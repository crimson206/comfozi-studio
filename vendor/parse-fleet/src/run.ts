/**
 * run.ts — 이벤트 발화형 파이프라인 오케스트레이터 (Stream B: Emitter).
 *
 * `parseFleet()`(index.ts)는 문서 단위로 라우팅·파싱을 인터리브한다. 이 모듈은
 * 같은 빌딩블록(router 순수함수 · deterministic 러너 · SessionPool · aggregate)을
 * **배치 스테이지** 형태로 재배열하고, run-event-contract.md 의 스테이지 경계마다
 * run.jsonl 이벤트를 발화한다:
 *
 *   run.start
 *     → route → parse.deterministic → parse.ai(fan-out) → merge → detect → score → export
 *   run.done
 *
 * base 재구현 0: 결정적 파싱은 @comfozi/doc-import, 탐지는 @comfozi/detectors.analyze,
 * AI 병렬성은 SessionPool 이 담당한다. 여기 있는 건 스테이지 순서 + emit 지점뿐.
 */
import { analyze } from '@comfozi/detectors';
import type { RowAnalysis } from '@comfozi/contract';
import type { ParsedRow } from '@comfozi/doc-import';
import type { DocRef, FleetOptions, FleetResult, LaneOutput, LaneRunner, RouteDecision } from './types.js';
import { classifyFormat, isDeterministicCandidate, shouldFallback } from './router.js';
import { runDeterministicOne } from './deterministic.js';
import { SessionPool, type PoolTransport } from './pool.js';
import { mergeRows } from './aggregate.js';
import { mapLimit } from './util/mapLimit.js';
import { RunEventEmitter, type InputRef, type RunEvent } from './events.js';

/** Options for the event-emitting run. Superset of FleetOptions. */
export interface RunPipelineOptions extends FleetOptions {
  /** run 식별자. 미지정 시 자동 생성(run_<ts>). */
  runId?: string;
  /**
   * run.jsonl config.mode (계약 RunConfig): 'live'=스트리밍, 'replay'=녹화 재생.
   * 라우팅 모드(auto/ai/deterministic)와 별개다 — 그건 FleetOptions.mode. 기본 'replay'.
   */
  recordMode?: 'live' | 'replay';
  /** ISO ts 스탬프 clock (재현성 주입). 기본: 실시간. */
  clock?: () => string;
  /** duration_ms 계산용 단조 시계(ms). 기본: Date.now. */
  monoClock?: () => number;
  /** 라이브 tail/콘솔용 동기 이벤트 싱크. */
  onEvent?: (ev: RunEvent) => void;
  /** AI 세션 백엔드 라벨(session.start 에 노출). 기본 'claude'. */
  backend?: 'claude' | 'codex';
  /** AI 세션 이름 prefix(주입 시 재현성; 기본 fleet-<pid>). */
  poolPrefix?: string;
  /** 결정적 러너 주입(테스트). 기본 @comfozi/doc-import 래핑. */
  deterministicRunner?: LaneRunner;
}

/** run.jsonl 을 곁들인 FleetResult. */
export interface RunPipelineResult extends FleetResult {
  runId: string;
  /** 발화된 모든 이벤트(발생 순서). */
  events: RunEvent[];
  /** runs/run_<id>.jsonl 로 쓸 본문. */
  jsonl: string;
}

function byteLen(bytes: DocRef['bytes']): number {
  return typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.byteLength;
}

/**
 * 문서 배치를 스테이지별로 흘리며 run.jsonl 이벤트를 발화한다.
 *
 * mode:
 *  - 'auto'          : 결정적 우선 → thin/저신뢰면 parse.ai 폴백(문서별).
 *  - 'ai'            : 전 문서 parse.ai 강제(fan-out 데모용).
 *  - 'deterministic' : parse.ai 스킵.
 */
export async function runPipeline(
  docs: readonly DocRef[],
  opts: RunPipelineOptions = {},
): Promise<RunPipelineResult> {
  const mode = opts.mode ?? 'auto';
  const limit = opts.concurrency ?? 2;
  const mono = opts.monoClock ?? (() => Date.now());
  const runId = opts.runId ?? `run_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
  const em = new RunEventEmitter(runId, opts.clock, opts.onEvent);
  const deterministic: LaneRunner = opts.deterministicRunner ?? runDeterministicOne;

  const runT0 = mono();

  // ── classify (needed for run.start inputs + routing) ─────────────────────
  // structured = 결정적 파싱 후보 포맷(파일 성격). tryDet = 이번 run 에서 실제로
  // 결정적 레인을 시도할지(모드 반영): ai→never, deterministic→always, auto→structured.
  const classified = docs.map((doc) => {
    const format = classifyFormat(doc);
    const structured = isDeterministicCandidate(format);
    const tryDet = mode === 'ai' ? false : mode === 'deterministic' ? true : structured;
    return { doc, format, structured, tryDet };
  });

  const inputs: InputRef[] = classified.map((c) => ({
    name: c.doc.filename ?? c.doc.path ?? c.doc.id,
    size: byteLen(c.doc.bytes),
    kind: c.structured ? ('structured' as const) : ('scan' as const),
  }));
  em.runStart(inputs, { mode: opts.recordMode ?? 'replay', concurrency: limit });

  // ── ① route ──────────────────────────────────────────────────────────────
  {
    const t = mono();
    em.stageStart('route', docs.length);
    const aiPreliminary = classified.filter((c) => !c.tryDet).length;
    em.stageDone('route', mono() - t, {
      deterministic: docs.length - aiPreliminary,
      ai: aiPreliminary,
    });
  }

  // ── ② parse.deterministic ─────────────────────────────────────────────────
  const detOut = new Map<string, LaneOutput>();
  const detTargets = classified.filter((c) => c.tryDet);
  {
    const t = mono();
    em.stageStart('parse.deterministic', detTargets.length);
    const settled = await mapLimit(detTargets, limit, (c) => deterministic(c.doc, opts));
    settled.forEach((s, i) => {
      const id = detTargets[i]!.doc.id;
      detOut.set(id, s.status === 'fulfilled' ? s.value : { rows: [], productiveRows: 0 });
    });
    // fallback 판정: auto 모드에서 thin/저신뢰면 AI 로 넘긴다.
    const stayed = detTargets.filter(
      (c) => mode === 'deterministic' || !shouldFallback(detOut.get(c.doc.id)!, opts),
    );
    const fellBack = detTargets.length - stayed.length;
    const detRows = stayed.reduce((n, c) => n + detOut.get(c.doc.id)!.rows.length, 0);
    em.stageDone('parse.deterministic', mono() - t, { rows: detRows, fallbacks: fellBack });
  }

  // set of docs that STAY deterministic (rest go to AI lane)
  const staysDet = new Set(
    detTargets
      .filter((c) => mode === 'deterministic' || !shouldFallback(detOut.get(c.doc.id)!, opts))
      .map((c) => c.doc.id),
  );

  // ── ③ parse.ai (병렬 fan-out) ─────────────────────────────────────────────
  // AI 레인 = 결정적으로 남지 않은 모든 문서(이미지 + auto 폴백 + mode=ai 전량).
  const aiTargets = classified.filter((c) => !staysDet.has(c.doc.id));
  const aiOut = new Map<string, LaneOutput>();
  {
    const t = mono();
    em.stageStart('parse.ai', aiTargets.length);
    if (aiTargets.length > 0) {
      const pool = new SessionPool({
        size: limit,
        prefix: opts.poolPrefix ?? `fleet-${process.pid}`,
        transport: opts.transport,
        aiInput: opts.aiInput,
        backend: opts.backend,
        log: opts.log,
        // ③ fan-out 이벤트: 세션 spawn/종료마다 session.start / session.done.
        onSession: {
          start: (info) => em.sessionStart(info),
          done: (info) => em.sessionDone(info),
        },
      });
      try {
        const settled = await mapLimit(aiTargets, limit, (c) => pool.runner(c.doc, opts));
        settled.forEach((s, i) => {
          const id = aiTargets[i]!.doc.id;
          aiOut.set(id, s.status === 'fulfilled' ? s.value : { rows: [] });
        });
      } finally {
        await pool.teardown();
      }
    }
    const aiRows = aiTargets.reduce((n, c) => n + (aiOut.get(c.doc.id)?.rows.length ?? 0), 0);
    em.stageDone('parse.ai', mono() - t, { rows: aiRows, sessions: aiTargets.length });
  }

  // ── assemble per-doc lane rows (original order) + routing decisions ────────
  const laneRows: ParsedRow[][] = [];
  const routing: RouteDecision[] = [];
  let detCount = 0;
  let aiCount = 0;
  let failed = 0;
  for (const c of classified) {
    const filename = c.doc.filename ?? c.doc.path ?? c.doc.id;
    if (staysDet.has(c.doc.id)) {
      const out = detOut.get(c.doc.id)!;
      laneRows.push(out.rows);
      detCount++;
      routing.push({
        docId: c.doc.id,
        filename,
        format: c.format,
        lane: 'deterministic',
        reason: mode === 'deterministic' ? 'mode=deterministic' : 'deterministic sufficient',
        deterministicRows: out.productiveRows ?? out.rows.length,
        minConfidence: out.minConfidence,
        aiFallbackUsed: false,
      });
    } else {
      const out = aiOut.get(c.doc.id);
      const rows = out?.rows ?? [];
      laneRows.push(rows);
      if (rows.length === 0 && out === undefined) failed++;
      aiCount++;
      const wasFallback = c.tryDet; // det attempted then fell back to AI
      routing.push({
        docId: c.doc.id,
        filename,
        format: c.format,
        lane: 'ai',
        reason:
          mode === 'ai'
            ? 'mode=ai (forced)'
            : wasFallback
              ? 'deterministic thin → AI fallback'
              : 'image/pixel format',
        deterministicRows: wasFallback ? detOut.get(c.doc.id)?.rows.length : undefined,
        minConfidence: out?.minConfidence,
        aiFallbackUsed: true,
      });
    }
  }

  // ── ④ merge ───────────────────────────────────────────────────────────────
  let rows: ParsedRow[];
  {
    const t = mono();
    em.stageStart('merge');
    rows = mergeRows(laneRows);
    em.stageDone('merge', mono() - t, { rows: rows.length });
  }

  // ── ⑥ detect ──────────────────────────────────────────────────────────────
  let analyses: RowAnalysis[];
  {
    const t = mono();
    em.stageStart('detect', rows.length);
    analyses = analyze(rows);
    const findings = analyses.reduce((n, a) => n + a.findings.length, 0);
    const needsReview = analyses.filter((a) => !a.approvable).length;
    em.stageDone('detect', mono() - t, { findings, needs_review: needsReview });
  }

  // ── ⑦ score (트리아지) ─────────────────────────────────────────────────────
  // NB: comfozi.approval-ml(GBM) 미연결 → detector verdict(approvable)로 정직하게
  // 트리아지. ML 붙으면 이 스테이지만 신뢰도 버킷으로 교체.
  const autoCandidate = analyses.filter((a) => a.approvable).length;
  const toHuman = analyses.length - autoCandidate;
  {
    const t = mono();
    em.stageStart('score', rows.length);
    em.stageDone('score', mono() - t, { auto_candidate: autoCandidate, to_human: toHuman });
  }

  // ── ⑨ export ──────────────────────────────────────────────────────────────
  {
    const t = mono();
    em.stageStart('export');
    em.stageDone('export', mono() - t, { records: autoCandidate, blocked: toHuman });
  }

  const findings = analyses.reduce((n, a) => n + a.findings.length, 0);
  em.runDone(mono() - runT0, {
    docs: docs.length,
    rows: rows.length,
    findings,
    approved: autoCandidate,
  });

  return {
    rows,
    analyses,
    routing,
    stats: {
      documents: docs.length,
      deterministic: detCount,
      ai: aiCount,
      failed,
      totalRows: rows.length,
    },
    runId,
    events: em.events,
    jsonl: em.toJsonl(),
  };
}

export type { PoolTransport };
