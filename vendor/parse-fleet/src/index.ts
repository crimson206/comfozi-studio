/**
 * @comfozi/parse-fleet — 병렬 문서 파싱 오케스트레이터.
 *
 * 흐름:  DocRef[] → [router] 결정적 우선 시도 → (thin/pixel면 AI 세션 풀 폴백)
 *        → laneRows[] → [aggregate] 병합 + provenance → @comfozi/detectors.
 *
 * 결정적 로직은 @comfozi/doc-import, 검출은 @comfozi/detectors를 재사용만 한다
 * (base 재구현 금지). 이 패키지는 라우팅·동시성·세션 수명주기만 소유한다.
 */
import type { ParsedRow } from '@comfozi/doc-import';
import type { DocRef, FleetOptions, FleetResult, LaneOutput, LaneRunner, RouteDecision } from './types.js';
import { routeOne, classifyFormat, isDeterministicCandidate, shouldFallback } from './router.js';
import type { RoutedDoc } from './router.js';
import { runDeterministicOne } from './deterministic.js';
import { SessionPool } from './pool.js';
import { aggregate } from './aggregate.js';
import { mapLimit, type Settled } from './util/mapLimit.js';

export type {
  DocRef,
  FleetMode,
  FleetOptions,
  FleetResult,
  Lane,
  LaneOutput,
  LaneRunner,
  RouteDecision,
} from './types.js';
export { routeOne, classifyFormat, isDeterministicCandidate, shouldFallback } from './router.js';
export { runDeterministicOne, runDeterministicBatch, DETERMINISTIC_CHAIN } from './deterministic.js';
export {
  SessionPool,
  iseshTransport,
  normalizeAiRows,
  rasterizePdf,
  extractOcrText,
  hasTesseract,
  DEFAULT_PARSER_PROFILE,
  type PoolTransport,
  type SessionPoolOptions,
  type AiInputMode,
} from './pool.js';
export { mergeRows, aggregate, type AggregateResult } from './aggregate.js';
export { mapLimit, type Settled } from './util/mapLimit.js';

// ── run.jsonl 이벤트 발화 (Stream B: Emitter) ────────────────────────────────
export { runPipeline, type RunPipelineOptions, type RunPipelineResult } from './run.js';
export {
  RunEventEmitter,
  type SessionStartInfo,
  type SessionDoneInfo,
  // 계약 재-export (편의): 타입 SSOT 는 @comfozi/contract.
  type StageId,
  type RunEvent,
  type RunState,
  type InputRef,
  type RunConfig,
  STAGE_ORDER,
  STAGE_LABEL,
  foldRun,
  emptyRunState,
} from './events.js';
export type { SessionHook } from './pool.js';

/** Build the default AI lane: a warm SessionPool, unless a runner is injected. */
function resolveAiRunner(opts: FleetOptions): { runner: LaneRunner; pool?: SessionPool } {
  if (opts.aiRunner) return { runner: opts.aiRunner };
  const prefix = `fleet-${process.pid}`;
  const pool = new SessionPool({
    size: opts.concurrency ?? 2,
    prefix,
    transport: opts.transport,
    aiInput: opts.aiInput,
    log: opts.log,
  });
  return { runner: pool.runner, pool };
}

/**
 * Parse a batch of documents through the fleet and return merged rows +
 * detector analyses + routing decisions. Concurrency is bounded by
 * `opts.concurrency` (default 2) across BOTH lanes.
 *
 * The AI SessionPool is warmed lazily on first fallback and torn down before
 * return — unless the caller injects `aiRunner`/`transport` (tests/offline).
 */
/**
 * 2D 배치 라우팅: (auto) 결정적-우선 후 폴백 문서를, (ai) 전체를 → batchSize 개씩 묶어
 * pool.submitBatch 로 X세션 동시 처리. 이미지 합치기 없음. 배치 완료마다 onResult.
 */
async function routeBatched(
  docs: readonly DocRef[],
  opts: FleetOptions,
  deterministic: LaneRunner,
  pool: SessionPool,
  limit: number,
  batchSize: number,
): Promise<Settled<RoutedDoc>[]> {
  const mode = opts.mode ?? 'auto';
  const results: (RoutedDoc | undefined)[] = new Array(docs.length).fill(undefined);
  const aiIdx: number[] = [];
  const mk = (doc: DocRef, lane: 'deterministic' | 'ai', reason: string, extra: Partial<RouteDecision> = {}): RouteDecision => ({
    docId: doc.id,
    filename: doc.filename ?? doc.path ?? doc.id,
    format: classifyFormat(doc),
    lane,
    reason,
    aiFallbackUsed: lane === 'ai' && mode === 'auto',
    ...extra,
  });
  await mapLimit(docs, limit, async (doc, index) => {
    const format = classifyFormat(doc);
    if (mode === 'ai') { aiIdx.push(index); return; }
    if (isDeterministicCandidate(format)) {
      const out = await deterministic(doc, opts);
      if (mode === 'auto' && shouldFallback(out, opts)) { aiIdx.push(index); return; }
      results[index] = { decision: mk(doc, 'deterministic', 'deterministic', { deterministicRows: out.productiveRows ?? out.rows.length }), output: out };
      try { opts.onResult?.(out, doc, index); } catch { /* best-effort */ }
    } else {
      aiIdx.push(index);
    }
  });
  const batches: number[][] = [];
  for (let i = 0; i < aiIdx.length; i += batchSize) batches.push(aiIdx.slice(i, i + batchSize));
  await mapLimit(batches, limit, async (batch) => {
    // submitBatch 가 throw(세션 실패/타임아웃)하면 이 배치 문서들은 results 미설정 → 최종 docs.map 에서 failed 로 집계된다.
    const outs = await pool.submitBatch(batch.map((idx) => docs[idx]!), opts);
    batch.forEach((idx, k) => {
      const doc = docs[idx]!;
      const out = outs[k] ?? { rows: [] };
      results[idx] = { decision: mk(doc, 'ai', mode === 'ai' ? 'forced AI (batch)' : 'ai fallback (batch)'), output: out };
      try { opts.onResult?.(out, doc, idx); } catch { /* best-effort */ }
    });
  });
  return docs.map((_doc, i) => {
    const r = results[i];
    return (r
      ? { status: 'fulfilled', value: r }
      : { status: 'rejected', reason: new Error(`doc ${i}: AI lane produced no result (session failed/timeout)`) }) as Settled<RoutedDoc>;
  });
}

export async function parseFleet(docs: readonly DocRef[], opts: FleetOptions = {}): Promise<FleetResult> {
  const deterministic: LaneRunner = opts.deterministicRunner ?? runDeterministicOne;
  const { runner: ai, pool } = resolveAiRunner(opts);
  const limit = opts.concurrency ?? 2;

  try {
    const batchSize = opts.batchSize ?? 1;
    const mode = opts.mode ?? 'auto';
    const settled =
      batchSize > 1 && pool && (mode === 'ai' || mode === 'auto')
        ? await routeBatched(docs, opts, deterministic, pool, limit, batchSize)
        : await mapLimit(docs, limit, async (doc, index) => {
            const r = await routeOne(doc, opts, deterministic, ai);
            try { opts.onResult?.(r.output, doc, index); } catch { /* streaming is best-effort */ }
            return r;
          });

    const routing: RouteDecision[] = [];
    const laneRows: ParsedRow[][] = [];
    let failed = 0;
    let deterministicCount = 0;
    let aiCount = 0;

    settled.forEach((s, i) => {
      const doc = docs[i]!;
      if (s.status === 'fulfilled') {
        routing.push(s.value.decision);
        laneRows.push(s.value.output.rows);
        if (s.value.decision.lane === 'ai') aiCount++;
        else deterministicCount++;
      } else {
        failed++;
        routing.push({
          docId: doc.id,
          filename: doc.filename ?? doc.path ?? doc.id,
          format: 'unknown',
          lane: 'deterministic',
          reason: `lane error: ${(s.reason as Error)?.message ?? String(s.reason)}`,
          aiFallbackUsed: false,
        });
        laneRows.push([]);
      }
    });

    const { rows, analyses } = aggregate(laneRows);

    return {
      rows,
      analyses,
      routing,
      stats: {
        documents: docs.length,
        deterministic: deterministicCount,
        ai: aiCount,
        failed,
        totalRows: rows.length,
      },
    };
  } finally {
    if (pool) await pool.teardown();
  }
}
