import { RawRow, RowAnalysis, RunEvent, InputRef, RunConfig, StageId } from '@comfozi/contract';
export { InputRef, RunConfig, RunEvent, RunState, STAGE_LABEL, STAGE_ORDER, StageId, emptyRunState, foldRun } from '@comfozi/contract';
import { DocInput, ParsedRow, DocFormat, DocParser } from '@comfozi/doc-import';

/** Pluggable session transport. Default = live isesh/imessenger + file-drop. */
interface PoolTransport {
    /** spawn a detached session. */
    start(session: string): Promise<void>;
    /** stop/teardown a session. */
    stop(session: string): Promise<void>;
    /** deliver a message to a session (fire-and-forget with --skip-verify). */
    send(session: string, message: string): Promise<void>;
    /** wait for the AI's JSON reply written to `outPath`; resolve its parsed value. */
    collect(outPath: string, timeoutMs: number): Promise<unknown>;
}
interface SessionPoolOptions {
    /** number of warm sessions K. */
    size: number;
    /** session-name prefix (unique per run). */
    prefix: string;
    /** isesh profile for parser sessions. */
    profile?: string;
    /** workspace dir passed to `isesh start -w`. */
    workspace?: string;
    /** per-request AI timeout (ms). */
    timeoutMs?: number;
    /**
     * do the READY handshake before serving requests (beats the agent-init race).
     * Default: ON for the live isesh transport, OFF when a transport is injected.
     */
    readiness?: boolean;
    /** max wait for a session to report READY at warm-up (ms). Default 120000. */
    readinessTimeoutMs?: number;
    /** max PDF pages to rasterize per doc (vision payload cap). Default 20. */
    maxPdfPages?: number;
    /** AI input channel: 'vision' (image only) or 'vision+ocr'. Default 'vision'. */
    aiInput?: AiInputMode;
    /** tmp dir for the file-drop protocol (auto-created). */
    tmpDir?: string;
    /** injected transport (test/offline). */
    transport?: PoolTransport;
    /** primer message sent to each session at warm-up. */
    primer?: string;
    /**
     * which AI backend these sessions run — surfaced on session.start events for
     * the run.jsonl trace (③ fan-out visualization). Default 'claude'.
     */
    backend?: 'claude' | 'codex';
    /**
     * run.jsonl session lifecycle hook (③ fan-out). Called synchronously when a
     * doc is dispatched to a leased session (`start`) and when that session
     * returns/fails (`done`). Wire this to a RunEventEmitter to emit
     * session.start / session.done. Optional — offline/parseFleet leaves it unset.
     */
    onSession?: SessionHook;
    log?: (msg: string) => void;
}
/** SessionPool → run.jsonl session lifecycle bridge (see events.ts). */
interface SessionHook {
    start(info: {
        session_id: string;
        doc: string;
        backend: 'claude' | 'codex';
        pages?: number;
    }): void;
    done(info: {
        session_id: string;
        duration_ms: number;
        rows: number;
        self_conf?: number;
    }): void;
}
/** The self-contained skit profile the AI parser sessions run under. */
declare const DEFAULT_PARSER_PROFILE = "comfozi-doc-parser";
/**
 * Rasterize a PDF to per-page PNGs via pdftoppm (page fan-out). Returns absolute
 * page paths in order. maxPages caps the vision payload. Requires poppler.
 */
declare function rasterizePdf(pdfPath: string, outDir: string, reqId: string, maxPages?: number): Promise<string[]>;
/** AI-lane input channel: image only, or image + a rough OCR transcript. */
type AiInputMode = 'vision' | 'vision+ocr';
/** Is tesseract on PATH? (cached; kor pack usage attempted at call time.) */
declare function hasTesseract(): Promise<boolean>;
/**
 * Best-effort OCR/text extraction for the `vision+ocr` channel. Text-layer PDFs
 * → pdftotext (fast, exact); image-only inputs → tesseract (kor+eng) IF present.
 * Returns {text:'', source:'none'} when no text can be produced (e.g. a scan with
 * no tesseract). The text is a ROUGH transcript — vision remains the ground truth.
 */
declare function extractOcrText(opts: {
    inputPath: string;
    isPdf: boolean;
    pagePngs: string[];
}): Promise<{
    text: string;
    source: string;
}>;
/** Default transport: isesh start/stop, imessenger send, fs-poll collect. */
declare function iseshTransport(workspace: string, profile?: string): PoolTransport;
/** Private AI response schema (yeonseo doc-extract contract), minimally typed. */
interface AiRow {
    doc_id?: string | null;
    source_type?: string | null;
    supplier?: string | null;
    raw_item_name?: string | null;
    normalized_item_name?: string | null;
    spec?: string | null;
    unit?: string | null;
    prev_unit_price?: number | null;
    new_unit_price?: number | null;
    applied_date?: string | null;
    confidence?: number;
    uncertain_fields?: string[];
    provenance?: string | null;
}
interface AiResponse {
    rows: AiRow[];
    unreadable?: string | null;
}
/** Map the private {rows,unreadable} schema → contract RawRow[] (null→''). */
declare function normalizeAiRows(resp: AiResponse, filename: string): {
    rows: RawRow[];
    minConfidence?: number;
};
/** A warm, reusable fleet of AI parser sessions with K-slot backpressure. */
declare class SessionPool {
    private readonly opts;
    private readonly transport;
    private readonly sessions;
    private readonly free;
    private readonly waiters;
    private readonly timeoutMs;
    private readonly readiness;
    private readonly readinessTimeoutMs;
    private readonly aiInput;
    private readonly backend;
    private readonly onSession?;
    private readonly log;
    private tmpDir;
    private started;
    /** in-flight warm() so concurrent cold-start submits share ONE warm (no double-init). */
    private warming?;
    private counter;
    constructor(opts: SessionPoolOptions);
    /**
     * Start + prime K sessions. Idempotent.
     *
     * Sessions are started in parallel (init overlaps), then each is confirmed
     * READY before use. `isesh start` returns as soon as the tmux/agent process
     * exists — the Claude Code agent itself needs ~20-30s more before it will
     * consume an imessenger turn. Sending [DOC-EXTRACT] into that window is
     * silently dropped (the original E2E timeout). The readiness handshake beats
     * this race by re-sending a probe until the agent Writes a ready-file.
     */
    warm(): Promise<void>;
    private doWarm;
    /**
     * Confirm a session's agent is initialized AND can Write, by asking it to drop
     * a ready-file and polling for it. Re-sends the probe periodically so a probe
     * that lands before the agent is listening doesn't strand us.
     */
    private awaitReady;
    /** Lease a free session (waits if all K are busy — this IS the backpressure). */
    private acquire;
    private release;
    /**
     * Dispatch one document to a free session and collect its RawRow[].
     * PDF → pdftoppm page fan-out (imagePaths); PNG/JPG → single imagePath.
     * fresh-per-doc: one request per session lease, session reused across docs.
     */
    submit(doc: DocRef, _opts: FleetOptions): Promise<LaneOutput>;
    /** LaneRunner-compatible bound method for the router. */
    runner: (doc: DocRef, opts: FleetOptions) => Promise<LaneOutput>;
    /** Stop every session and clean tmp. Safe to call more than once. */
    teardown(): Promise<void>;
}

/** How the fleet decides which lane a document takes. */
type FleetMode = 'auto' | 'deterministic' | 'ai';
/** The two processing lanes. */
type Lane = 'deterministic' | 'ai';
/**
 * One document handed to the fleet. Compatible with @comfozi/doc-import's
 * DocInput (superset): adds an optional on-disk path for the CLI loader.
 */
interface DocRef extends DocInput {
    /** absolute path on disk, if loaded from a directory (provenance/logging). */
    path?: string;
}
/** Per-document routing decision + evidence (dashboard/debugging). */
interface RouteDecision {
    docId: string;
    filename: string;
    /** format the router classified the doc as. */
    format: DocFormat;
    /** which lane actually produced the final rows. */
    lane: Lane;
    /** human-readable why (e.g. "image format", "det rows<floor → ai fallback"). */
    reason: string;
    /** rows the deterministic attempt produced (auto mode signal). */
    deterministicRows?: number;
    /** lowest row confidence observed (auto mode signal), if known. */
    minConfidence?: number;
    /** true if the AI fallback was actually attempted for this doc. */
    aiFallbackUsed: boolean;
}
/** Options controlling routing + concurrency + fallback thresholds. */
interface FleetOptions {
    /** auto (default): deterministic-first + fallback. */
    mode?: FleetMode;
    /** AI session-pool concurrency K (default 2). Also bounds in-process det lanes. */
    concurrency?: number;
    /**
     * auto-mode fallback trigger: if a text-format doc yields FEWER than this many
     * deterministic rows, fall back to AI. Default 1 (i.e. zero rows → fallback).
     */
    detRowFloor?: number;
    /**
     * auto-mode fallback trigger: if the best deterministic row confidence is
     * below this, fall back to AI. Default 0.5.
     */
    minConfidence?: number;
    /**
     * AI-lane input channel (both modes are permanent, user-selectable):
     *  - 'vision'     : image(s) only (default).
     *  - 'vision+ocr' : image(s) + a rough OCR/text transcript for cross-checking.
     */
    aiInput?: AiInputMode;
    /** injected AI transport (test/offline). Default = live isesh/imessenger. */
    transport?: PoolTransport;
    /** injected deterministic runner (test). Default = wraps @comfozi/doc-import. */
    deterministicRunner?: LaneRunner;
    /** injected AI runner (test). Default = SessionPool over the transport. */
    aiRunner?: LaneRunner;
    /** ISO timestamp injected for determinism (passed to parser ctx). */
    now?: string;
    /** progress log sink. */
    log?: (msg: string) => void;
}
/** What a lane runner returns for a single document. */
interface LaneOutput {
    rows: ParsedRow[];
    /** lowest per-row confidence seen (undefined if not scored). */
    minConfidence?: number;
    /**
     * count of ACTUALLY RECOVERED rows, i.e. excluding `unresolved` fail-candidates
     * that @comfozi/doc-import emits for docs no parser could read. auto-mode uses
     * this (not rows.length) as the fallback signal — a lone fail-candidate must
     * still trigger the AI lane. undefined ⇒ treat rows.length as productive.
     */
    productiveRows?: number;
}
/** A pluggable per-document processor (deterministic or AI). */
type LaneRunner = (doc: DocRef, opts: FleetOptions) => Promise<LaneOutput>;
/** Final fleet result. */
interface FleetResult {
    /** merged candidate rows across all documents (with parser provenance). */
    rows: ParsedRow[];
    /** @comfozi/detectors output per row. */
    analyses: RowAnalysis[];
    /** per-document routing decisions. */
    routing: RouteDecision[];
    /** roll-up stats. */
    stats: {
        documents: number;
        deterministic: number;
        ai: number;
        failed: number;
        totalRows: number;
    };
}

/**
 * Router — the "결정적 우선 시도 → 저산출/저신뢰면 AI 폴백" brain.
 *
 * Pure orchestration: it owns NO parsing. It classifies each document's format,
 * decides a lane, and delegates to injected lane runners (deterministic / ai).
 * All heavy deps are reached only through those runners, so this module stays
 * type-only and unit-testable offline.
 *
 * Classification signal:
 *   - image/pixel formats (pdf-image/png/jpg/photo) are NOT deterministically
 *     parseable → straight to AI.
 *   - text/table formats (csv/tsv/xlsx/json/txt/eml/html/md/pdf-text) → try
 *     deterministic first; in `auto` mode fall back to AI when the deterministic
 *     attempt is thin (rows < detRowFloor) or low-confidence (< minConfidence).
 */

/** Cheap format guess from the format hint or the filename extension. */
declare function classifyFormat(doc: DocRef): DocFormat;
/** Is this format a candidate for the deterministic lane at all? */
declare function isDeterministicCandidate(format: DocFormat): boolean;
/** Should `auto` mode fall back to AI after a deterministic attempt? */
declare function shouldFallback(out: LaneOutput, opts: FleetOptions): boolean;
interface RoutedDoc {
    decision: RouteDecision;
    output: LaneOutput;
}
/**
 * Route + run ONE document. Returns the chosen lane's output plus the decision
 * record. `deterministic` and `ai` are injected runners.
 */
declare function routeOne(doc: DocRef, opts: FleetOptions, deterministic: LaneRunner, ai: LaneRunner): Promise<RoutedDoc>;

/**
 * Deterministic lane — in-process, no AI. Wraps @comfozi/doc-import's
 * chain-of-responsibility text/table parsers (base 재구현 금지). We build a
 * DETERMINISTIC-ONLY chain (no vision) so this lane never touches a session; the
 * router is responsible for sending pixel/low-yield docs to the AI lane instead.
 *
 * Batch entry `runDeterministicBatch` runs many docs concurrently via mapLimit;
 * `runDeterministicOne` is the LaneRunner the router injects per document.
 */

/**
 * Deterministic-only chain (no vision), ordered to match doc-import's
 * buildChain(): text → space-table (관공서/레터헤드 공문 PDF) → noisy-table.
 * spaceTableParser fires on format==='pdf-text' or meta.__pdfBytes, so PDF docs
 * MUST carry format='pdf-text' (the CLI loader sets it from the extension).
 */
declare const DETERMINISTIC_CHAIN: DocParser[];
/** Run the deterministic chain over a single document. */
declare function runDeterministicOne(doc: DocRef, opts: FleetOptions): Promise<LaneOutput>;
/** Run the deterministic lane over many docs with bounded concurrency. */
declare function runDeterministicBatch(docs: readonly DocRef[], opts: FleetOptions): Promise<Array<LaneOutput | null>>;

interface AggregateResult {
    rows: ParsedRow[];
    analyses: RowAnalysis[];
}
/**
 * ④ merge stage ONLY — concat every lane's rows in doc order + re-stamp physical
 * provenance row numbers. NO detection here (that is the ⑥ detect stage). The
 * event-emitting run orchestrator (run.ts) calls this at the `merge` boundary and
 * `analyze()` separately at the `detect` boundary, so the two stages stay distinct
 * in run.jsonl. `aggregate()` (below) keeps the coupled behavior for parseFleet().
 *
 * @param laneRows rows grouped per source document (preserves doc order).
 */
declare function mergeRows(laneRows: ReadonlyArray<ParsedRow[]>): ParsedRow[];
/**
 * Merge lane outputs into one RawRow[] and analyze (merge + detect coupled).
 * @param laneRows rows grouped per source document (preserves doc order).
 */
declare function aggregate(laneRows: ReadonlyArray<ParsedRow[]>): AggregateResult;

/**
 * Bounded-concurrency map — the backpressure primitive shared by the in-process
 * deterministic lane and the AI session pool. Ported from the yeonseo
 * orchestrate.js `mapLimit` (JS) into typed, settle-don't-throw form.
 *
 * At most `limit` workers run at once; every item resolves to a settled result
 * so one failure never rejects the whole batch.
 */
type Settled<T> = {
    status: 'fulfilled';
    value: T;
} | {
    status: 'rejected';
    reason: unknown;
};
declare function mapLimit<I, O>(items: readonly I[], limit: number, worker: (item: I, index: number, lane: number) => Promise<O>): Promise<Array<Settled<O>>>;

/**
 * run.jsonl 스테이지 이벤트 발화기 — 파이프라인이 "도는 걸 본다"의 SSOT emitter.
 *
 * ✅ 계약 확정 (2026-08-13, 스트림 A): run-event 타입은 이제 `@comfozi/contract`
 *    (src/run-event.ts) 에서 온다. 과거 여기 있던 로컬 draft(§6 복사본)는 삭제됐다.
 *    이 파일은 계약 타입을 re-export + `RunEventEmitter`(append 헬퍼)만 소유한다.
 *
 *    유효성 검증은 계약의 `foldRun(events)` 로 한다(부분스트림·중복 seq 안전).
 */

/** SessionPool → emitter 브리지가 넘기는 세션 시작 정보(계약 session.start payload). */
interface SessionStartInfo {
    session_id: string;
    doc: string;
    backend: 'claude' | 'codex';
    pages?: number;
}
/** 세션 종료 정보(계약 session.done payload). */
interface SessionDoneInfo {
    session_id: string;
    duration_ms: number;
    rows: number;
    self_conf?: number;
}
/**
 * append-only 이벤트 발화기.
 *
 * - `RunEvent` 유니온을 그대로 append 한다(계약 확정본). 스키마 검증 불필요 —
 *   타입이 컴파일타임에 강제하고, `foldRun`이 런타임에서 부분스트림·중복 seq를
 *   안전하게 접는다.
 * - seq 는 **동기적**으로 단조증가(발화 시점 즉시 할당) → fan-out 로 여러 세션이
 *   동시에 발화해도(JS 단일 이벤트루프) seq 는 결코 뒤섞이지 않는다.
 * - `ts` 는 주입된 clock 이 스탬프(실행 하네스 책임; 기본 실시간).
 * - `events[]` 버퍼 → `toJsonl()` 로 runs/run_<id>.jsonl 산출(리플레이). `onEvent`
 *   는 라이브 tail/콘솔용 동기 싱크(옵션). 둘 다 같은 fold 로직으로 소비된다.
 */
declare class RunEventEmitter {
    private readonly runId;
    private readonly clock;
    private readonly onEvent?;
    /** 발화된 모든 이벤트(발생 순서). */
    readonly events: RunEvent[];
    private seq;
    constructor(runId: string, clock?: () => string, onEvent?: ((ev: RunEvent) => void) | undefined);
    private push;
    runStart(inputs: InputRef[], config: RunConfig): void;
    stageStart(stage: StageId, total?: number): void;
    stageProgress(stage: StageId, done: number, total?: number, active_sessions?: number): void;
    /** duration_ms 는 옵션(순간 스테이지는 생략 가능 — 계약 §8.1). */
    stageDone(stage: StageId, duration_ms?: number, out?: Record<string, number>): void;
    stageError(stage: StageId, error: string, fatal: boolean): void;
    sessionStart(info: SessionStartInfo): void;
    sessionDone(info: SessionDoneInfo): void;
    itemEvent(stage: StageId, doc_id: string, payload: unknown): void;
    runDone(duration_ms: number, summary: Record<string, number>): void;
    /** 버퍼를 runs/run_<id>.jsonl 본문으로(줄당 1 이벤트, trailing newline). */
    toJsonl(): string;
}

/** Options for the event-emitting run. Superset of FleetOptions. */
interface RunPipelineOptions extends FleetOptions {
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
interface RunPipelineResult extends FleetResult {
    runId: string;
    /** 발화된 모든 이벤트(발생 순서). */
    events: RunEvent[];
    /** runs/run_<id>.jsonl 로 쓸 본문. */
    jsonl: string;
}
/**
 * 문서 배치를 스테이지별로 흘리며 run.jsonl 이벤트를 발화한다.
 *
 * mode:
 *  - 'auto'          : 결정적 우선 → thin/저신뢰면 parse.ai 폴백(문서별).
 *  - 'ai'            : 전 문서 parse.ai 강제(fan-out 데모용).
 *  - 'deterministic' : parse.ai 스킵.
 */
declare function runPipeline(docs: readonly DocRef[], opts?: RunPipelineOptions): Promise<RunPipelineResult>;

/**
 * Parse a batch of documents through the fleet and return merged rows +
 * detector analyses + routing decisions. Concurrency is bounded by
 * `opts.concurrency` (default 2) across BOTH lanes.
 *
 * The AI SessionPool is warmed lazily on first fallback and torn down before
 * return — unless the caller injects `aiRunner`/`transport` (tests/offline).
 */
declare function parseFleet(docs: readonly DocRef[], opts?: FleetOptions): Promise<FleetResult>;

export { type AggregateResult, type AiInputMode, DEFAULT_PARSER_PROFILE, DETERMINISTIC_CHAIN, type DocRef, type FleetMode, type FleetOptions, type FleetResult, type Lane, type LaneOutput, type LaneRunner, type PoolTransport, type RouteDecision, RunEventEmitter, type RunPipelineOptions, type RunPipelineResult, type SessionDoneInfo, type SessionHook, SessionPool, type SessionPoolOptions, type SessionStartInfo, type Settled, aggregate, classifyFormat, extractOcrText, hasTesseract, isDeterministicCandidate, iseshTransport, mapLimit, mergeRows, normalizeAiRows, parseFleet, rasterizePdf, routeOne, runDeterministicBatch, runDeterministicOne, runPipeline, shouldFallback };
