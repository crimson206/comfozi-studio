/**
 * AI session pool — the concurrency-K isesh worker fleet.
 *
 * Lifecycle (mirrors the yeonseo bridge orchestrate.js / extract.js mechanism):
 *   1. warm()      : `isesh start <sess> -w <cwd> -d -p <profile>` × K, then
 *                    prime each with the parser-session-contract prompt.
 *   2. submit(doc) : lease a free session (backpressure = a K-slot semaphore),
 *                    write the doc bytes to a tmp file, `imessenger send` a
 *                    `[DOC-EXTRACT] {..., outPath}` request, then POLL outPath on
 *                    disk until the AI's Write lands a stable JSON file, validate
 *                    → RawRow[], stamp parser='vision-pool', release the session.
 *   3. teardown()  : `isesh stop <sess>` × K, remove tmp.
 *
 * The transport (start/stop/send/collect) is injectable so the flow is testable
 * offline; the default transport shells out to isesh/imessenger + fs polling.
 *
 * ── SIMPLIFICATIONS (see DESIGN.md "Blockers") ──────────────────────────────
 *  - Real vision needs PDF→PNG rasterization (pdftoppm) + per-page payloads like
 *    extract.js. Here we hand the raw file path to the session and expect it to
 *    read it. PDF page-fanout is a documented TODO.
 *  - normalizeAiRows does a minimal port of the private {rows,unreadable} schema
 *    → contract RawRow (applied_date→effective_date, null→'').
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { emptyRow, stampParser, type ParsedRow } from '@comfozi/doc-import';
import type { RawRow } from '@comfozi/contract';
import type { DocRef, FleetOptions, LaneOutput } from './types.js';

/** Pluggable session transport. Default = live isesh/imessenger + file-drop. */
export interface PoolTransport {
  /** spawn a detached session. */
  start(session: string): Promise<void>;
  /** stop/teardown a session. */
  stop(session: string): Promise<void>;
  /** deliver a message to a session (fire-and-forget with --skip-verify). */
  send(session: string, message: string): Promise<void>;
  /** wait for the AI's JSON reply written to `outPath`; resolve its parsed value. */
  collect(outPath: string, timeoutMs: number): Promise<unknown>;
}

export interface SessionPoolOptions {
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
export interface SessionHook {
  start(info: { session_id: string; doc: string; backend: 'claude' | 'codex'; pages?: number }): void;
  done(info: { session_id: string; duration_ms: number; rows: number; self_conf?: number }): void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The self-contained skit profile the AI parser sessions run under. */
export const DEFAULT_PARSER_PROFILE = 'comfozi-doc-parser';

/** Does this byte buffer look like a PDF? (%PDF- magic) */
function isPdfBytes(bytes: Uint8Array | string): boolean {
  if (typeof bytes === 'string') return bytes.startsWith('%PDF-');
  return bytes.length >= 5 && Buffer.from(bytes.subarray(0, 5)).toString('ascii') === '%PDF-';
}

/**
 * Rasterize a PDF to per-page PNGs via pdftoppm (page fan-out). Returns absolute
 * page paths in order. maxPages caps the vision payload. Requires poppler.
 */
export async function rasterizePdf(
  pdfPath: string,
  outDir: string,
  reqId: string,
  maxPages = 20,
): Promise<string[]> {
  const prefix = path.join(outDir, `page-${reqId}`);
  await run('pdftoppm', ['-f', '1', '-l', String(maxPages), '-r', '150', '-png', pdfPath, prefix]);
  const names = (await fs.readdir(outDir))
    .filter((n) => n.startsWith(`page-${reqId}-`) && n.endsWith('.png'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return names.map((n) => path.join(outDir, n));
}

/** AI-lane input channel: image only, or image + a rough OCR transcript. */
export type AiInputMode = 'vision' | 'vision+ocr';

let _tesseract: boolean | undefined;
/** Is tesseract on PATH? (cached; kor pack usage attempted at call time.) */
export async function hasTesseract(): Promise<boolean> {
  if (_tesseract !== undefined) return _tesseract;
  try {
    await run('which', ['tesseract']);
    _tesseract = true;
  } catch {
    _tesseract = false;
  }
  return _tesseract;
}

/**
 * Best-effort OCR/text extraction for the `vision+ocr` channel. Text-layer PDFs
 * → pdftotext (fast, exact); image-only inputs → tesseract (kor+eng) IF present.
 * Returns {text:'', source:'none'} when no text can be produced (e.g. a scan with
 * no tesseract). The text is a ROUGH transcript — vision remains the ground truth.
 */
export async function extractOcrText(opts: {
  inputPath: string;
  isPdf: boolean;
  pagePngs: string[];
}): Promise<{ text: string; source: string }> {
  const clip = (t: string): string => t.replace(/[ \t]+\n/g, '\n').trim().slice(0, 6000);
  if (opts.isPdf) {
    try {
      const out = await run('pdftotext', ['-layout', opts.inputPath, '-']);
      if (out.replace(/\s/g, '').length > 20) return { text: clip(out), source: 'pdftotext' };
    } catch {
      /* no text layer → try OCR below */
    }
  }
  if (await hasTesseract()) {
    const targets = opts.isPdf ? opts.pagePngs : [opts.inputPath];
    const parts: string[] = [];
    for (const t of targets) {
      try {
        parts.push(await run('tesseract', [t, 'stdout', '-l', 'kor+eng']));
      } catch {
        /* skip this page */
      }
    }
    const joined = parts.join('\n');
    if (joined.replace(/\s/g, '').length > 0) return { text: clip(joined), source: 'tesseract' };
  }
  return { text: '', source: 'none' };
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${file} ${args[0]} exit ${code}: ${err.trim()}`)),
    );
  });
}

/** Default transport: isesh start/stop, imessenger send, fs-poll collect. */
export function iseshTransport(workspace: string, profile?: string): PoolTransport {
  return {
    async start(session) {
      const args = ['start', session, '-w', workspace, '-d'];
      if (profile) args.push('-p', profile);
      await run('isesh', args);
    },
    async stop(session) {
      await run('isesh', ['stop', session]);
    },
    async send(session, message) {
      await run('imessenger', ['send', session, message, '--skip-verify']);
    },
    async collect(outPath, timeoutMs) {
      const pollMs = 200;
      const deadline = Date.now() + timeoutMs;
      let lastSize = -1;
      while (Date.now() < deadline) {
        let size = -1;
        try {
          size = (await fs.stat(outPath)).size;
        } catch {
          lastSize = -1;
          await sleep(pollMs);
          continue;
        }
        // require a stable, non-empty file (two identical polls) before reading
        if (size > 0 && size === lastSize) {
          const text = await fs.readFile(outPath, 'utf8');
          return JSON.parse(text);
        }
        lastSize = size;
        await sleep(pollMs);
      }
      throw new Error(`AI response timeout after ${timeoutMs}ms (${outPath})`);
    },
  };
}

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

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/** Map the private {rows,unreadable} schema → contract RawRow[] (null→''). */
export function normalizeAiRows(resp: AiResponse, filename: string): { rows: RawRow[]; minConfidence?: number } {
  let minConf: number | undefined;
  const rows = (resp.rows ?? []).map((r) => {
    const row = emptyRow();
    row.doc_id = str(r.doc_id);
    row.source_type = str(r.source_type);
    row.supplier = str(r.supplier);
    row.raw_item_name = str(r.raw_item_name);
    row.normalized_item_name = str(r.normalized_item_name);
    row.spec = str(r.spec);
    row.unit = str(r.unit);
    row.prev_unit_price = str(r.prev_unit_price);
    row.new_unit_price = str(r.new_unit_price);
    row.effective_date = str(r.applied_date); // applied_date → effective_date
    if (typeof r.confidence === 'number') minConf = minConf === undefined ? r.confidence : Math.min(minConf, r.confidence);
    return row;
  });
  void filename;
  return { rows, minConfidence: minConf };
}

/** A warm, reusable fleet of AI parser sessions with K-slot backpressure. */
export class SessionPool {
  private readonly transport: PoolTransport;
  private readonly sessions: string[] = [];
  private readonly free: string[] = [];
  private readonly waiters: Array<(s: string) => void> = [];
  private readonly timeoutMs: number;
  private readonly readiness: boolean;
  private readonly readinessTimeoutMs: number;
  private readonly aiInput: AiInputMode;
  private readonly backend: 'claude' | 'codex';
  private readonly onSession?: SessionHook;
  private readonly log: (m: string) => void;
  private tmpDir: string;
  private started = false;
  /** in-flight warm() so concurrent cold-start submits share ONE warm (no double-init). */
  private warming?: Promise<void>;
  private counter = 0;

  constructor(private readonly opts: SessionPoolOptions) {
    this.transport =
      opts.transport ?? iseshTransport(opts.workspace ?? process.cwd(), opts.profile ?? DEFAULT_PARSER_PROFILE);
    this.timeoutMs = opts.timeoutMs ?? 180000;
    // Readiness handshake defaults ON for the real isesh transport, OFF when a
    // transport is injected (tests/offline) — those have no real agent to init.
    this.readiness = opts.readiness ?? opts.transport === undefined;
    this.readinessTimeoutMs = opts.readinessTimeoutMs ?? 120000;
    this.aiInput = opts.aiInput ?? 'vision';
    this.backend = opts.backend ?? 'claude';
    this.onSession = opts.onSession;
    this.log = opts.log ?? (() => {});
    this.tmpDir = opts.tmpDir ?? path.join(os.tmpdir(), `parse-fleet-${opts.prefix}`);
  }

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
  async warm(): Promise<void> {
    if (this.started) return;
    // Concurrent cold-start submits (③ fan-out) must NOT each run warm() — that
    // double-pushes sessions into free[] and collapses the pool onto one session.
    // Coalesce onto a single in-flight warm.
    if (this.warming) return this.warming;
    this.warming = this.doWarm().finally(() => {
      this.warming = undefined;
    });
    return this.warming;
  }

  private async doWarm(): Promise<void> {
    await fs.mkdir(this.tmpDir, { recursive: true });
    const names = Array.from({ length: this.opts.size }, (_, i) => `${this.opts.prefix}-parser-${i + 1}`);

    await Promise.all(names.map((n) => this.transport.start(n)));
    this.log(`pool: started ${names.length} session(s), awaiting readiness…`);

    if (this.readiness) {
      await Promise.all(names.map((n) => this.awaitReady(n)));
    } else if (this.opts.primer) {
      await Promise.all(names.map((n) => this.transport.send(n, this.opts.primer!)));
    }

    for (const n of names) {
      this.sessions.push(n);
      this.free.push(n);
      this.log(`pool: warmed ${n}`);
    }
    this.started = true;
  }

  /**
   * Confirm a session's agent is initialized AND can Write, by asking it to drop
   * a ready-file and polling for it. Re-sends the probe periodically so a probe
   * that lands before the agent is listening doesn't strand us.
   */
  private async awaitReady(session: string): Promise<void> {
    const readyPath = path.join(this.tmpDir, `ready-${session}.txt`);
    const probe =
      `[FLEET-READY] 준비되면 즉시 Write 도구로 파일 "${readyPath}" 에 정확히 READY 한 단어만 써라. ` +
      `이 파일 작성 외 다른 응답/파일 생성은 하지 마라.`;
    const deadline = Date.now() + this.readinessTimeoutMs;
    let lastSend = 0;
    while (Date.now() < deadline) {
      if (Date.now() - lastSend > 12000) {
        await this.transport.send(session, probe).catch(() => {}); // busy/not-ready → retry next loop
        lastSend = Date.now();
      }
      try {
        const st = await fs.stat(readyPath);
        if (st.size > 0) {
          await fs.rm(readyPath, { force: true }).catch(() => {});
          this.log(`pool: ${session} READY`);
          return;
        }
      } catch {
        /* not yet */
      }
      await sleep(1000);
    }
    throw new Error(`session ${session} not READY after ${this.readinessTimeoutMs}ms`);
  }

  /** Lease a free session (waits if all K are busy — this IS the backpressure). */
  private acquire(): Promise<string> {
    const s = this.free.pop();
    if (s) return Promise.resolve(s);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private release(session: string): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(session);
    else this.free.push(session);
  }

  /**
   * Dispatch one document to a free session and collect its RawRow[].
   * PDF → pdftoppm page fan-out (imagePaths); PNG/JPG → single imagePath.
   * fresh-per-doc: one request per session lease, session reused across docs.
   */
  async submit(doc: DocRef, _opts: FleetOptions): Promise<LaneOutput> {
    if (!this.started) await this.warm();
    const session = await this.acquire();
    const reqId = `${this.opts.prefix}-${++this.counter}`;
    const filename = doc.filename ?? doc.path ?? doc.id;
    const outPath = path.join(this.tmpDir, `result-${reqId}.json`);
    const cleanup: string[] = [outPath];
    // ③ fan-out trace: timing + result counters for the session.done event.
    const t0 = Date.now();
    let sessionStarted = false;
    let doneRows = 0;
    let doneConf: number | undefined;
    try {
      const bytes = doc.bytes;
      const pdf = isPdfBytes(bytes);
      const inputPath = path.join(this.tmpDir, `input-${reqId}${pdf ? '.pdf' : path.extname(filename) || '.png'}`);
      await fs.writeFile(inputPath, typeof bytes === 'string' ? bytes : Buffer.from(bytes));
      cleanup.push(inputPath);

      let pages: string[] = [];
      let payload: Record<string, unknown>;
      if (pdf) {
        pages = await rasterizePdf(inputPath, this.tmpDir, reqId, this.opts.maxPdfPages ?? 20);
        cleanup.push(...pages);
        payload = {
          reqId,
          filename: path.basename(filename),
          sourceType: 'PDF',
          imagePaths: pages.map((p, i) => ({ path: p, page: i + 1 })),
          outPath,
        };
      } else {
        payload = { reqId, filename: path.basename(filename), sourceType: 'IMAGE', imagePath: inputPath, outPath };
      }

      // vision+ocr: attach a ROUGH OCR transcript for the agent to cross-check.
      if (this.aiInput === 'vision+ocr') {
        const ocr = await extractOcrText({ inputPath, isPdf: pdf, pagePngs: pages });
        payload.ocrText = ocr.text;
        payload.ocrSource = ocr.source;
        payload.ocrNote = '초벌 전사(참고용, 오류 가능) — 이미지가 정답이며 OCR은 교차검증용';
        this.log(`pool: ${filename} ocr=${ocr.source} (${ocr.text.length} chars)`);
      }

      // session.start — the AI session is now actively parsing this doc.
      // session_id = reqId (UNIQUE per dispatch): the physical session name is
      // reused across docs, but foldRun keys sessions by id → reuse would collapse
      // two parse jobs onto one card. reqId gives one honest card per parse job
      // while active_sessions still reflects true concurrency (K).
      this.onSession?.start({
        session_id: reqId,
        doc: path.basename(filename),
        backend: this.backend,
        pages: pdf ? pages.length : 1,
      });
      sessionStarted = true;

      await this.transport.send(session, '[DOC-EXTRACT] ' + JSON.stringify(payload));
      const raw = (await this.transport.collect(outPath, this.timeoutMs)) as AiResponse;
      const { rows, minConfidence } = normalizeAiRows(raw, filename);
      const stamped: ParsedRow[] = stampParser(rows, 'vision-pool', {
        file: filename,
        confidence: minConfidence ?? 0.8,
      });
      doneRows = stamped.length;
      doneConf = minConfidence;
      this.log(`pool: ${filename} → ${stamped.length} row(s) via ${session}`);
      return { rows: stamped, minConfidence };
    } finally {
      // session.done — emit once per started session (success OR failure: rows=0).
      if (sessionStarted) {
        this.onSession?.done({
          session_id: reqId,
          duration_ms: Date.now() - t0,
          rows: doneRows,
          ...(doneConf !== undefined ? { self_conf: doneConf } : {}),
        });
      }
      for (const p of cleanup) await fs.rm(p, { force: true }).catch(() => {});
      this.release(session);
    }
  }

  /** LaneRunner-compatible bound method for the router. */
  runner = (doc: DocRef, opts: FleetOptions): Promise<LaneOutput> => this.submit(doc, opts);

  /** Stop every session and clean tmp. Safe to call more than once. */
  async teardown(): Promise<void> {
    if (!this.started) return;
    for (const s of [...this.sessions].reverse()) {
      try {
        await this.transport.stop(s);
        this.log(`pool: stopped ${s}`);
      } catch (e) {
        this.log(`pool: teardown warning ${s}: ${(e as Error).message}`);
      }
    }
    this.sessions.length = 0;
    this.free.length = 0;
    this.started = false;
    await fs.rm(this.tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
