#!/usr/bin/env node
/**
 * batch-parse-ab.mjs — Claude 원샷 파싱 배치크기(N장) A/B 하네스 (재사용 가능).
 *
 * scratch.md §6: "claude code 원샷으로 한번에, 1장·2장·4장·8장 파싱 속도 및 정확성 비교".
 * 한 번의 `claude -p` 호출에 스캔 이미지 N장을 각각 첨부(방식 A, 다운스케일 없음)하고
 * 문서별 그룹 `{documents:[{image,rows}]}` 출력을 받아 채점한다. 배치들은 **병렬**로 돌린다
 * (concurrency), "하나만 계속 돌리기" 금지.
 *
 * REUSE: 코퍼스/정답은 `@comfozi/data-raw`(gen manifest), 채점은 그 `scoreRecovery`를 그대로 씀.
 * 재현:
 *   comfozi-data-raw gen --seed 21 --count 220 --formats png,jpg --difficulty mixed --out <corpus>
 *   node scripts/batch-parse-ab.mjs --corpus <corpus> --batches 1,2,4,8 \
 *        --limit 16 --concurrency 4 --reps 1 --out /tmp/batch_ab/result.json
 *
 * stdout = 사람이 읽는 요약, --out = 기계용 JSON. 세션/프로세스 누수 없음(claude -p 단발).
 */
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// scoreRecovery from @comfozi/data-raw (built dist). Reused, never re-implemented.
const dataRaw = await import(
  resolve(HERE, '../../../comfozi.data-raw/dist/index.js')
);
const { scoreRecovery } = dataRaw;

const SCORE_FIELDS = [
  'supplier', 'raw_item_name', 'spec', 'unit',
  'prev_unit_price', 'new_unit_price', 'effective_date',
];
const SCAN_FORMATS = new Set(['png', 'jpg', 'pdf-image']);

// ── arg parsing (Node built-in, no deps) ─────────────────────────────────────
function argVal(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const CORPUS = argVal('corpus', '/tmp/batch_ab/corpus');
const BATCHES = String(argVal('batches', '1,2,4,8')).split(',').map((s) => parseInt(s, 10)).filter(Boolean);
const LIMIT = parseInt(argVal('limit', '16'), 10);
const CONCURRENCY = parseInt(argVal('concurrency', '4'), 10);
const REPS = parseInt(argVal('reps', '1'), 10);
const OUT = argVal('out', '/tmp/batch_ab/result.json');
const FORMATS = String(argVal('formats', 'png,jpg')).split(',').map((s) => s.trim());
const CLAUDE_TIMEOUT_MS = parseInt(argVal('timeout', '180000'), 10);

// ── prompt (방식 A: N images each attached, grouped output) ──────────────────
function buildPrompt(imgPaths) {
  const list = imgPaths.map((p, i) => `  [${i + 1}] ${p}`).join('\n');
  return `You are a precise document parser. I attach ${imgPaths.length} scanned Korean price-change official documents (단가 변경 공문). Each image contains a table of items with a unit-price change.

Read EVERY image below with the Read tool and extract EVERY table row from each:
${list}

For each row output these fields (verbatim from the document; empty string if truly absent):
- supplier            (거래처/공급사명)
- raw_item_name       (품목명, 문서 표기 그대로)
- spec                (규격)
- unit                (단위)
- prev_unit_price      (기존/변경전 단가 — digits only, no commas/원)
- new_unit_price       (변경/신규 단가 — digits only)
- effective_date       (적용일/시행일 — YYYY-MM-DD)

Output ONLY minified JSON, no prose, no code fence:
{"documents":[{"image":"<image path>","rows":[{"supplier":"","raw_item_name":"","spec":"","unit":"","prev_unit_price":"","new_unit_price":"","effective_date":""}]}]}
The documents array MUST be in the same order as the images listed above, one entry per image.`;
}

function runClaude(prompt) {
  return new Promise((res) => {
    const t0 = Date.now();
    execFile(
      'claude',
      ['-p', prompt, '--allowedTools', 'Read'],
      { timeout: CLAUDE_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => res({ err, stdout: stdout || '', ms: Date.now() - t0 }),
    );
  });
}

function extractJson(text) {
  // strip ``` fences and find the outermost {...}
  const s = text.replace(/```json/gi, '').replace(/```/g, '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

// ── simple concurrency pool ──────────────────────────────────────────────────
async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let idx = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const my = idx++;
      out[my] = await worker(items[my], my);
    }
  });
  await Promise.all(runners);
  return out;
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }

// ── main ─────────────────────────────────────────────────────────────────────
const manifest = JSON.parse(readFileSync(join(CORPUS, 'manifest.json'), 'utf8'));
let docs = manifest.docs
  .filter((d) => SCAN_FORMATS.has(d.format) && FORMATS.includes(d.format))
  .sort((a, b) => a.id.localeCompare(b.id));
if (LIMIT > 0) docs = docs.slice(0, LIMIT);

const truthById = new Map(docs.map((d) => [d.id, d.truth]));
const pathById = new Map(docs.map((d) => [d.id, resolve(CORPUS, d.file)]));
const truthRows = docs.reduce((a, d) => a + d.truth.length, 0);

console.error(`[batch-ab] corpus=${CORPUS} scans=${docs.length} truthRows=${truthRows} batches=${BATCHES} conc=${CONCURRENCY} reps=${REPS}`);

const results = [];
for (const N of BATCHES) {
  for (let rep = 0; rep < REPS; rep++) {
    const groups = chunk(docs, N);
    const t0 = Date.now();
    const callResults = await pool(groups, CONCURRENCY, async (grp) => {
      const paths = grp.map((d) => pathById.get(d.id));
      const { err, stdout, ms } = await runClaude(buildPrompt(paths));
      const parsed = extractJson(stdout);
      return { grp, err: !!err, ms, parsed };
    });
    const wallMs = Date.now() - t0;

    // score each doc
    let failures = 0;
    const entries = [];
    for (const cr of callResults) {
      const docsOut = cr.parsed && Array.isArray(cr.parsed.documents) ? cr.parsed.documents : null;
      if (cr.err || !docsOut) { failures++; }
      cr.grp.forEach((d, i) => {
        let rows = [];
        if (docsOut) {
          // prefer match by image path, fall back to positional
          const byPath = docsOut.find((o) => o && typeof o.image === 'string' && o.image.includes(d.file));
          const pick = byPath || docsOut[i];
          rows = pick && Array.isArray(pick.rows) ? pick.rows : [];
        }
        const score = scoreRecovery(rows, truthById.get(d.id), { fields: SCORE_FIELDS, minMatch: 2 });
        entries.push({ id: d.id, format: d.format, difficulty: d.difficulty, score, callMs: cr.ms, docsInCall: cr.grp.length });
      });
    }

    // aggregate
    const fieldCorrect = entries.reduce((a, e) => a + e.score.fieldCorrect, 0);
    const fieldTotal = entries.reduce((a, e) => a + e.score.fieldTotal, 0);
    const matched = entries.reduce((a, e) => a + e.score.matched, 0);
    const tRows = entries.reduce((a, e) => a + e.score.truthCount, 0);
    const callMsList = callResults.map((c) => c.ms);
    const perDocLatency = mean(entries.map((e) => e.callMs / e.docsInCall));

    // byField
    const byField = {};
    for (const f of SCORE_FIELDS) {
      let c = 0, t = 0;
      for (const e of entries) { c += e.score.byField[f].correct; t += e.score.byField[f].total; }
      byField[f] = t ? +(c / t).toFixed(3) : 0;
    }

    const row = {
      N, rep,
      calls: callResults.length,
      fieldAcc: fieldTotal ? +(fieldCorrect / fieldTotal).toFixed(4) : 0,
      rowRecall: tRows ? +(matched / tRows).toFixed(4) : 0,
      perDocLatencyS: +(perDocLatency / 1000).toFixed(1),
      perCallLatencyS: +(mean(callMsList) / 1000).toFixed(1),
      wallS: +(wallMs / 1000).toFixed(1),
      failures,
      byField,
    };
    results.push(row);
    console.error(`[batch-ab] N=${N} rep=${rep} fieldAcc=${row.fieldAcc} rowRecall=${row.rowRecall} perDoc=${row.perDocLatencyS}s perCall=${row.perCallLatencyS}s wall=${row.wallS}s fail=${failures}`);
  }
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ meta: { corpus: CORPUS, scans: docs.length, truthRows, batches: BATCHES, concurrency: CONCURRENCY, reps: REPS, scoreFields: SCORE_FIELDS }, results }, null, 2));

// human summary
console.log('\n=== Batch-size A/B (Claude 원샷, 방식 A) ===');
console.log('N   calls  fieldAcc  rowRecall  perDoc(s)  perCall(s)  wall(s)  fail');
for (const r of results) {
  console.log(
    `${String(r.N).padEnd(3)} ${String(r.calls).padStart(5)}  ${r.fieldAcc.toFixed(4)}    ${r.rowRecall.toFixed(4)}     ${String(r.perDocLatencyS).padStart(6)}     ${String(r.perCallLatencyS).padStart(6)}   ${String(r.wallS).padStart(6)}   ${r.failures}`,
  );
}
console.log(`\nwrote ${OUT}`);
