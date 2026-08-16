/**
 * run.jsonl 스테이지 이벤트 발화기 — 파이프라인이 "도는 걸 본다"의 SSOT emitter.
 *
 * ✅ 계약 확정 (2026-08-13, 스트림 A): run-event 타입은 이제 `@comfozi/contract`
 *    (src/run-event.ts) 에서 온다. 과거 여기 있던 로컬 draft(§6 복사본)는 삭제됐다.
 *    이 파일은 계약 타입을 re-export + `RunEventEmitter`(append 헬퍼)만 소유한다.
 *
 *    유효성 검증은 계약의 `foldRun(events)` 로 한다(부분스트림·중복 seq 안전).
 */

// ── 계약 타입 (SSOT) — 로컬 재선언 금지 ──────────────────────────────────────
export type {
  StageId,
  RunEventType,
  Envelope,
  InputRef,
  RunConfig,
  RunEvent,
  RunState,
  StageState,
  StageStatus,
  RunStatus,
  SessionState,
} from '@comfozi/contract';
export { STAGE_ORDER, STAGE_LABEL, foldRun, emptyRunState } from '@comfozi/contract';

import type { InputRef, RunConfig, RunEvent, StageId } from '@comfozi/contract';

/** Omit over a discriminated union must DISTRIBUTE, else it collapses to common keys. */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** One RunEvent variant minus the envelope fields the emitter injects. */
type RunEventInput = DistributiveOmit<RunEvent, 'v' | 'run_id' | 'seq' | 'ts'>;

/** SessionPool → emitter 브리지가 넘기는 세션 시작 정보(계약 session.start payload). */
export interface SessionStartInfo {
  session_id: string;
  doc: string;
  backend: 'claude' | 'codex';
  pages?: number;
}
/** 세션 종료 정보(계약 session.done payload). */
export interface SessionDoneInfo {
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
export class RunEventEmitter {
  /** 발화된 모든 이벤트(발생 순서). */
  readonly events: RunEvent[] = [];
  private seq = 0;

  constructor(
    private readonly runId: string,
    private readonly clock: () => string = () => new Date().toISOString(),
    private readonly onEvent?: (ev: RunEvent) => void,
  ) {}

  private push(partial: RunEventInput): void {
    const ev = {
      v: 1,
      run_id: this.runId,
      seq: ++this.seq,
      ts: this.clock(),
      ...partial,
    } as RunEvent;
    this.events.push(ev);
    this.onEvent?.(ev);
  }

  runStart(inputs: InputRef[], config: RunConfig): void {
    this.push({ type: 'run.start', inputs, config });
  }
  stageStart(stage: StageId, total?: number): void {
    this.push({ type: 'stage.start', stage, ...(total !== undefined ? { total } : {}) });
  }
  stageProgress(stage: StageId, done: number, total?: number, active_sessions?: number): void {
    this.push({ type: 'stage.progress', stage, done, total, active_sessions });
  }
  /** duration_ms 는 옵션(순간 스테이지는 생략 가능 — 계약 §8.1). */
  stageDone(stage: StageId, duration_ms?: number, out?: Record<string, number>): void {
    this.push({
      type: 'stage.done',
      stage,
      ...(duration_ms !== undefined ? { duration_ms } : {}),
      ...(out ? { out } : {}),
    });
  }
  stageError(stage: StageId, error: string, fatal: boolean): void {
    this.push({ type: 'stage.error', stage, error, fatal });
  }
  sessionStart(info: SessionStartInfo): void {
    this.push({ type: 'session.start', ...info });
  }
  sessionDone(info: SessionDoneInfo): void {
    this.push({ type: 'session.done', ...info });
  }
  itemEvent(stage: StageId, doc_id: string, payload: unknown): void {
    this.push({ type: 'item.event', stage, doc_id, payload });
  }
  runDone(duration_ms: number, summary: Record<string, number>): void {
    this.push({ type: 'run.done', duration_ms, summary });
  }

  /** 버퍼를 runs/run_<id>.jsonl 본문으로(줄당 1 이벤트, trailing newline). */
  toJsonl(): string {
    return this.events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  }
}
