#!/usr/bin/env node
/**
 * comfozi-parse-fleet — CLI for @comfozi/parse-fleet.
 *
 *   comfozi-parse-fleet parse <dir|files...> [options]
 *     --concurrency <K>     AI/lane concurrency (default 2)
 *     --out <path>          write result JSON (default stdout)
 *     --mode <auto|deterministic|ai>   routing mode (default auto)
 *     --pretty              indent JSON
 *
 * Uses Node's built-in util.parseArgs (no external arg dep).
 */
import { parseArgs } from 'node:util';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { parseFleet, runPipeline, foldRun } from './index.js';
import type { DocRef, FleetMode } from './types.js';
import type { PoolTransport } from './pool.js';
import type { DocFormat } from '@comfozi/doc-import';

const TEXT_EXT = new Set(['.csv', '.tsv', '.json', '.txt', '.eml', '.html', '.htm', '.md']);

/** Extension → DocFormat. Drives spaceTableParser's pdf-text gate + routing. */
const EXT_FORMAT: Record<string, DocFormat> = {
  '.csv': 'csv',
  '.tsv': 'tsv',
  '.xlsx': 'xlsx',
  '.json': 'json',
  '.txt': 'txt',
  '.eml': 'eml',
  '.html': 'html',
  '.htm': 'html',
  '.md': 'md',
  '.pdf': 'pdf-text', // text-layer first; det chain passes on to AI if no text
  '.png': 'png',
  '.jpg': 'jpg',
  '.jpeg': 'jpg',
};

async function loadDoc(file: string, id: string): Promise<DocRef> {
  const ext = path.extname(file).toLowerCase();
  const isText = TEXT_EXT.has(ext);
  const bytes = isText ? await fs.readFile(file, 'utf8') : new Uint8Array(await fs.readFile(file));
  return { id, filename: path.basename(file), path: path.resolve(file), bytes, format: EXT_FORMAT[ext] };
}

/** Expand a mix of dirs/files into a flat DocRef[]. */
async function collectDocs(targets: string[]): Promise<DocRef[]> {
  const files: string[] = [];
  for (const t of targets) {
    const stat = await fs.stat(t);
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(t)).sort()) {
        const full = path.join(t, name);
        if ((await fs.stat(full)).isFile()) files.push(full);
      }
    } else {
      files.push(t);
    }
  }
  return Promise.all(files.map((f, i) => loadDoc(f, `DOC-${String(i + 1).padStart(4, '0')}`)));
}

const HELP = `comfozi-parse-fleet — 병렬 문서 파싱 오케스트레이터

Usage:
  comfozi-parse-fleet parse <dir|files...> [options]   # FleetResult JSON
  comfozi-parse-fleet run   <dir|files...> [options]   # + runs/run_<id>.jsonl 발화

Options (parse & run):
  --concurrency <K>                 lane/AI-pool concurrency (default 2)
  --mode <auto|deterministic|ai>    routing mode (default auto; run 데모는 ai 권장)
  --ai-input <vision|vision+ocr>    AI-lane input channel (default vision)
  --out <path>                      write result JSON (default stdout)
  --pretty                          indent JSON

Options (run only):
  --runs-dir <dir>                  run.jsonl 출력 디렉터리 (default ./runs)
  --run-id <id>                     run 식별자 (default run_<ts>)
  --live                            실제 isesh AI 세션 풀 사용 (default: 결정적 mock 트랜스포트)
                                    mock = 재현 가능한 리플레이 아티팩트(파일 드롭 프로토콜 그대로 실행)

  --help / --version
`;

/**
 * 결정적 mock AI 트랜스포트 — 재현 가능한 리플레이 아티팩트용.
 *
 * 실제 파일 드롭 프로토콜을 그대로 실행한다(send→collect, outPath 폴링). 라이브
 * isesh 세션 대신, [DOC-EXTRACT] payload 를 파싱해 파일명 기반의 정직한 canned
 * RawRow 를 outPath 에 Write 한다. K-slot 세마포어·pdftoppm 래스터화·session.*
 * 이벤트는 전부 진짜로 돈다 → run.jsonl 의 fan-out 트레이스는 실측 구조.
 *
 * 라이브 실행은 `--live` (기본 iseshTransport). 여기 rows 는 실제 vision 파싱이
 * 아니라 데모/리플레이용 대체값임을 명시한다.
 */
function mockAiTransport(): PoolTransport {
  let dispatch = 0;
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  return {
    async start() {
      /* no live session */
    },
    async stop() {
      /* no-op */
    },
    async send(_session, message) {
      const json = message.replace(/^\[DOC-EXTRACT\]\s*/, '');
      const payload = JSON.parse(json) as { filename?: string; outPath: string };
      const name = payload.filename ?? 'doc';
      // 파일명에 '누락'이 있으면 한 행의 new_unit_price 를 비워 탐지기가 물게 한다.
      const hasMissing = /누락/.test(name);
      const base = name.replace(/\.[^.]+$/, '');
      const rows = [
        {
          doc_id: base,
          source_type: '공문',
          supplier: base.split(/[_\s]/)[0] ?? base,
          raw_item_name: '품목-A',
          normalized_item_name: '품목 A',
          spec: '1kg',
          unit: 'kg',
          prev_unit_price: 1000,
          new_unit_price: 1200,
          applied_date: '2026-08-05',
          confidence: 0.9,
        },
        {
          doc_id: base,
          source_type: '공문',
          supplier: base.split(/[_\s]/)[0] ?? base,
          raw_item_name: '품목-B',
          normalized_item_name: '품목 B',
          spec: '500g',
          unit: 'g',
          prev_unit_price: 800,
          new_unit_price: hasMissing ? null : 900,
          applied_date: '2026-08-05',
          confidence: hasMissing ? 0.55 : 0.88,
        },
      ];
      // 살짝의 시뮬레이션 지연(디스패치 순서 기반) → K-slot fan-out 겹침이 보이게.
      const n = ++dispatch;
      await sleep(120 + (n % 3) * 90);
      await fs.writeFile(payload.outPath, JSON.stringify({ rows, unreadable: null }));
    },
    async collect(outPath, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          const text = await fs.readFile(outPath, 'utf8');
          if (text.length > 0) return JSON.parse(text);
        } catch {
          /* not yet */
        }
        await sleep(50);
      }
      throw new Error(`mock collect timeout (${outPath})`);
    },
  };
}

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      concurrency: { type: 'string' },
      mode: { type: 'string' },
      'ai-input': { type: 'string' },
      out: { type: 'string' },
      'runs-dir': { type: 'string' },
      'run-id': { type: 'string' },
      live: { type: 'boolean', default: false },
      pretty: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });

  if (values.version) {
    process.stdout.write('0.1.0\n');
    return;
  }
  const cmd = positionals[0];
  if (values.help || cmd === undefined || cmd === 'help') {
    process.stdout.write(HELP);
    return;
  }
  if (cmd !== 'parse' && cmd !== 'run') {
    process.stderr.write(`comfozi-parse-fleet: unknown command: ${cmd}\n\n${HELP}`);
    process.exit(1);
  }

  const targets = positionals.slice(1);
  if (targets.length === 0) {
    process.stderr.write(`comfozi-parse-fleet: ${cmd} requires <dir|files...>\n`);
    process.exit(1);
  }

  const mode = (values.mode ?? 'auto') as FleetMode;
  const concurrency = values.concurrency ? Number(values.concurrency) : 2;
  const aiInput = (values['ai-input'] ?? 'vision') as 'vision' | 'vision+ocr';
  if (aiInput !== 'vision' && aiInput !== 'vision+ocr') {
    process.stderr.write(`comfozi-parse-fleet: invalid --ai-input: ${aiInput}\n`);
    process.exit(1);
  }

  const docs = await collectDocs(targets);
  process.stderr.write(
    `comfozi-parse-fleet: ${docs.length} document(s), mode=${mode}, K=${concurrency}, ai-input=${aiInput}\n`,
  );

  // ── run: emit run.jsonl + self-verify with foldRun ──────────────────────
  if (cmd === 'run') {
    const runsDir = path.resolve(values['runs-dir'] ?? 'runs');
    const transport = values.live ? undefined : mockAiTransport();
    if (!values.live) {
      process.stderr.write('comfozi-parse-fleet: AI lane = deterministic mock transport (use --live for isesh)\n');
    }
    const result = await runPipeline(docs, {
      mode,
      concurrency,
      aiInput,
      recordMode: values.live ? 'live' : 'replay',
      runId: values['run-id'],
      transport,
      log: (m) => process.stderr.write(`  ${m}\n`),
      onEvent: (ev) => process.stderr.write(`  ▸ ${ev.type}${'stage' in ev ? ` ${ev.stage}` : ''}\n`),
    });

    await fs.mkdir(runsDir, { recursive: true });
    const jsonlPath = path.join(runsDir, `${result.runId}.jsonl`);
    await fs.writeFile(jsonlPath, result.jsonl);

    // 자체검증: foldRun(events) — 부분스트림·중복 seq 안전.
    const folded = foldRun(result.events);
    const stagesDone = Object.values(folded.stages).filter((s) => s.status === 'done').length;
    process.stderr.write(
      `comfozi-parse-fleet: run.jsonl → ${jsonlPath}\n` +
        `  events=${result.events.length} lastSeq=${folded.lastSeq} runStatus=${folded.status} ` +
        `stagesDone=${stagesDone}/${folded.order.length} sessions=${folded.sessions.length}\n`,
    );

    if (values.out) {
      await fs.writeFile(values.out, JSON.stringify(result, null, values.pretty ? 2 : undefined) + '\n');
    }
    process.stderr.write(
      `comfozi-parse-fleet: done — rows=${result.stats.totalRows} ` +
        `det=${result.stats.deterministic} ai=${result.stats.ai} failed=${result.stats.failed}\n`,
    );
    return;
  }

  const result = await parseFleet(docs, {
    mode,
    concurrency,
    aiInput,
    log: (m) => process.stderr.write(`  ${m}\n`),
  });

  const json = JSON.stringify(result, null, values.pretty ? 2 : undefined) + '\n';
  if (values.out) await fs.writeFile(values.out, json);
  else process.stdout.write(json);

  process.stderr.write(
    `comfozi-parse-fleet: done — rows=${result.stats.totalRows} ` +
      `det=${result.stats.deterministic} ai=${result.stats.ai} failed=${result.stats.failed}\n`,
  );
}

main(process.argv.slice(2)).catch((e) => {
  process.stderr.write(`comfozi-parse-fleet: ${(e as Error).message}\n`);
  process.exit(1);
});
