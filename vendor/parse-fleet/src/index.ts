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
import type { DocRef, FleetOptions, FleetResult, LaneRunner, RouteDecision } from './types.js';
import { routeOne } from './router.js';
import { runDeterministicOne } from './deterministic.js';
import { SessionPool } from './pool.js';
import { aggregate } from './aggregate.js';
import { mapLimit } from './util/mapLimit.js';

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
export async function parseFleet(docs: readonly DocRef[], opts: FleetOptions = {}): Promise<FleetResult> {
  const deterministic: LaneRunner = opts.deterministicRunner ?? runDeterministicOne;
  const { runner: ai, pool } = resolveAiRunner(opts);
  const limit = opts.concurrency ?? 2;

  try {
    const settled = await mapLimit(docs, limit, async (doc, index) => {
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
