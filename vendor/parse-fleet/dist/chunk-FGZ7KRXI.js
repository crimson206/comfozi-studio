// src/router.ts
var IMAGE_FORMATS = /* @__PURE__ */ new Set([
  "pdf-image",
  "png",
  "jpg",
  "photo"
]);
function classifyFormat(doc) {
  if (doc.format && doc.format !== "unknown") return doc.format;
  const name = (doc.filename ?? doc.path ?? doc.id ?? "").toLowerCase();
  const ext = name.slice(name.lastIndexOf(".") + 1);
  const byExt = {
    csv: "csv",
    tsv: "tsv",
    xlsx: "xlsx",
    json: "json",
    txt: "txt",
    eml: "eml",
    html: "html",
    htm: "html",
    md: "md",
    png: "png",
    jpg: "jpg",
    jpeg: "jpg",
    pdf: "pdf-text"
    // ambiguous: treated as text-first; det lane may pass it on
  };
  return byExt[ext] ?? "unknown";
}
function isDeterministicCandidate(format) {
  return !IMAGE_FORMATS.has(format);
}
function shouldFallback(out, opts) {
  const floor = opts.detRowFloor ?? 1;
  const minConf = opts.minConfidence ?? 0.5;
  const recovered = out.productiveRows ?? out.rows.length;
  if (recovered < floor) return true;
  if (out.minConfidence !== void 0 && out.minConfidence < minConf) return true;
  return false;
}
async function routeOne(doc, opts, deterministic, ai) {
  const mode = opts.mode ?? "auto";
  const format = classifyFormat(doc);
  const filename = doc.filename ?? doc.path ?? doc.id;
  const log = opts.log ?? (() => {
  });
  const decide = (lane, reason, extra = {}) => ({ docId: doc.id, filename, format, lane, reason, aiFallbackUsed: false, ...extra });
  if (mode === "ai") {
    log(`route ${filename}: forced AI`);
    const output = await ai(doc, opts);
    return { decision: decide("ai", "mode=ai (forced)", { aiFallbackUsed: true }), output };
  }
  if (!isDeterministicCandidate(format)) {
    if (mode === "deterministic") {
      log(`route ${filename}: image format under deterministic mode \u2192 likely fail-candidate`);
      const output2 = await deterministic(doc, opts);
      return { decision: decide("deterministic", "image format, deterministic pinned"), output: output2 };
    }
    log(`route ${filename}: image format \u2192 AI`);
    const output = await ai(doc, opts);
    return { decision: decide("ai", "image/pixel format", { aiFallbackUsed: true }), output };
  }
  const detOut = await deterministic(doc, opts);
  if (mode === "deterministic") {
    return {
      decision: decide("deterministic", "mode=deterministic (forced)", {
        deterministicRows: detOut.productiveRows ?? detOut.rows.length,
        minConfidence: detOut.minConfidence
      }),
      output: detOut
    };
  }
  if (!shouldFallback(detOut, opts)) {
    return {
      decision: decide("deterministic", "deterministic sufficient", {
        deterministicRows: detOut.productiveRows ?? detOut.rows.length,
        minConfidence: detOut.minConfidence
      }),
      output: detOut
    };
  }
  log(`route ${filename}: deterministic thin (rows=${detOut.rows.length}, conf=${detOut.minConfidence}) \u2192 AI fallback`);
  const aiOut = await ai(doc, opts);
  return {
    decision: decide("ai", "deterministic thin \u2192 AI fallback", {
      deterministicRows: detOut.productiveRows ?? detOut.rows.length,
      minConfidence: detOut.minConfidence,
      aiFallbackUsed: true
    }),
    output: aiOut
  };
}

// src/deterministic.ts
import {
  runParserChainDetailed,
  deterministicTextParser,
  noisyTableParser,
  spaceTableParser
} from "@comfozi/doc-import";

// src/util/mapLimit.ts
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const lanes = Math.max(1, Math.min(limit, items.length));
  async function run2(lane) {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = { status: "fulfilled", value: await worker(items[index], index, lane) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from({ length: lanes }, (_, lane) => run2(lane)));
  return results;
}

// src/deterministic.ts
var DETERMINISTIC_CHAIN = [
  deterministicTextParser,
  spaceTableParser,
  noisyTableParser
];
function lowestConfidence(rows) {
  let min;
  for (const r of rows) {
    const c = r.__source?.confidence;
    if (typeof c === "number") min = min === void 0 ? c : Math.min(min, c);
  }
  return min;
}
function productiveCount(rows) {
  return rows.filter((r) => r.__source?.parser !== "unresolved").length;
}
async function runDeterministicOne(doc, opts) {
  const ctx = { now: opts.now, log: opts.log };
  const detail = await runParserChainDetailed(doc, DETERMINISTIC_CHAIN, ctx);
  return {
    rows: detail.candidates,
    minConfidence: lowestConfidence(detail.candidates),
    productiveRows: productiveCount(detail.candidates)
  };
}
async function runDeterministicBatch(docs, opts) {
  const limit = opts.concurrency ?? 2;
  const settled = await mapLimit(docs, limit, (doc) => runDeterministicOne(doc, opts));
  return settled.map((s) => s.status === "fulfilled" ? s.value : null);
}

// src/pool.ts
import { spawn } from "child_process";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { emptyRow, stampParser } from "@comfozi/doc-import";
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
var DEFAULT_PARSER_PROFILE = "comfozi-doc-parser";
function isPdfBytes(bytes) {
  if (typeof bytes === "string") return bytes.startsWith("%PDF-");
  return bytes.length >= 5 && Buffer.from(bytes.subarray(0, 5)).toString("ascii") === "%PDF-";
}
async function rasterizePdf(pdfPath, outDir, reqId, maxPages = 20) {
  const prefix = path.join(outDir, `page-${reqId}`);
  await run("pdftoppm", ["-f", "1", "-l", String(maxPages), "-r", "150", "-png", pdfPath, prefix]);
  const names = (await fs.readdir(outDir)).filter((n) => n.startsWith(`page-${reqId}-`) && n.endsWith(".png")).sort((a, b) => a.localeCompare(b, void 0, { numeric: true }));
  return names.map((n) => path.join(outDir, n));
}
var _tesseract;
async function hasTesseract() {
  if (_tesseract !== void 0) return _tesseract;
  try {
    await run("which", ["tesseract"]);
    _tesseract = true;
  } catch {
    _tesseract = false;
  }
  return _tesseract;
}
async function extractOcrText(opts) {
  const clip = (t) => t.replace(/[ \t]+\n/g, "\n").trim().slice(0, 6e3);
  if (opts.isPdf) {
    try {
      const out = await run("pdftotext", ["-layout", opts.inputPath, "-"]);
      if (out.replace(/\s/g, "").length > 20) return { text: clip(out), source: "pdftotext" };
    } catch {
    }
  }
  if (await hasTesseract()) {
    const targets = opts.isPdf ? opts.pagePngs : [opts.inputPath];
    const parts = [];
    for (const t of targets) {
      try {
        parts.push(await run("tesseract", [t, "stdout", "-l", "kor+eng"]));
      } catch {
      }
    }
    const joined = parts.join("\n");
    if (joined.replace(/\s/g, "").length > 0) return { text: clip(joined), source: "tesseract" };
  }
  return { text: "", source: "none" };
}
function run(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => out += c);
    child.stderr.on("data", (c) => err += c);
    child.on("error", reject);
    child.on(
      "close",
      (code) => code === 0 ? resolve(out) : reject(new Error(`${file} ${args[0]} exit ${code}: ${err.trim()}`))
    );
  });
}
function iseshTransport(workspace, profile) {
  return {
    async start(session) {
      const args = ["start", session, "-w", workspace, "-d"];
      if (profile) args.push("-p", profile);
      await run("isesh", args);
    },
    async stop(session) {
      await run("isesh", ["stop", session]);
    },
    async send(session, message) {
      await run("imessenger", ["send", session, message, "--skip-verify"]);
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
        if (size > 0 && size === lastSize) {
          const text = await fs.readFile(outPath, "utf8");
          return JSON.parse(text);
        }
        lastSize = size;
        await sleep(pollMs);
      }
      throw new Error(`AI response timeout after ${timeoutMs}ms (${outPath})`);
    }
  };
}
var str = (v) => v === null || v === void 0 ? "" : String(v);
function normalizeAiRows(resp, filename) {
  let minConf;
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
    row.effective_date = str(r.applied_date);
    if (typeof r.confidence === "number") minConf = minConf === void 0 ? r.confidence : Math.min(minConf, r.confidence);
    return row;
  });
  void filename;
  return { rows, minConfidence: minConf };
}
var SessionPool = class {
  constructor(opts) {
    this.opts = opts;
    this.transport = opts.transport ?? iseshTransport(opts.workspace ?? process.cwd(), opts.profile ?? DEFAULT_PARSER_PROFILE);
    this.timeoutMs = opts.timeoutMs ?? 18e4;
    this.readiness = opts.readiness ?? opts.transport === void 0;
    this.readinessTimeoutMs = opts.readinessTimeoutMs ?? 12e4;
    this.aiInput = opts.aiInput ?? "vision";
    this.backend = opts.backend ?? "claude";
    this.onSession = opts.onSession;
    this.log = opts.log ?? (() => {
    });
    this.tmpDir = opts.tmpDir ?? path.join(os.tmpdir(), `parse-fleet-${opts.prefix}`);
  }
  opts;
  transport;
  sessions = [];
  free = [];
  waiters = [];
  timeoutMs;
  readiness;
  readinessTimeoutMs;
  aiInput;
  backend;
  onSession;
  log;
  tmpDir;
  started = false;
  /** in-flight warm() so concurrent cold-start submits share ONE warm (no double-init). */
  warming;
  counter = 0;
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
  async warm() {
    if (this.started) return;
    if (this.warming) return this.warming;
    this.warming = this.doWarm().finally(() => {
      this.warming = void 0;
    });
    return this.warming;
  }
  async doWarm() {
    await fs.mkdir(this.tmpDir, { recursive: true });
    const names = Array.from({ length: this.opts.size }, (_, i) => `${this.opts.prefix}-parser-${i + 1}`);
    await Promise.all(names.map((n) => this.transport.start(n)));
    this.log(`pool: started ${names.length} session(s), awaiting readiness\u2026`);
    if (this.readiness) {
      await Promise.all(names.map((n) => this.awaitReady(n)));
    } else if (this.opts.primer) {
      await Promise.all(names.map((n) => this.transport.send(n, this.opts.primer)));
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
  async awaitReady(session) {
    const readyPath = path.join(this.tmpDir, `ready-${session}.txt`);
    const probe = `[FLEET-READY] \uC900\uBE44\uB418\uBA74 \uC989\uC2DC Write \uB3C4\uAD6C\uB85C \uD30C\uC77C "${readyPath}" \uC5D0 \uC815\uD655\uD788 READY \uD55C \uB2E8\uC5B4\uB9CC \uC368\uB77C. \uC774 \uD30C\uC77C \uC791\uC131 \uC678 \uB2E4\uB978 \uC751\uB2F5/\uD30C\uC77C \uC0DD\uC131\uC740 \uD558\uC9C0 \uB9C8\uB77C.`;
    const deadline = Date.now() + this.readinessTimeoutMs;
    let lastSend = 0;
    while (Date.now() < deadline) {
      if (Date.now() - lastSend > 12e3) {
        await this.transport.send(session, probe).catch(() => {
        });
        lastSend = Date.now();
      }
      try {
        const st = await fs.stat(readyPath);
        if (st.size > 0) {
          await fs.rm(readyPath, { force: true }).catch(() => {
          });
          this.log(`pool: ${session} READY`);
          return;
        }
      } catch {
      }
      await sleep(1e3);
    }
    throw new Error(`session ${session} not READY after ${this.readinessTimeoutMs}ms`);
  }
  /** Lease a free session (waits if all K are busy — this IS the backpressure). */
  acquire() {
    const s = this.free.pop();
    if (s) return Promise.resolve(s);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  release(session) {
    const waiter = this.waiters.shift();
    if (waiter) waiter(session);
    else this.free.push(session);
  }
  /**
   * Dispatch one document to a free session and collect its RawRow[].
   * PDF → pdftoppm page fan-out (imagePaths); PNG/JPG → single imagePath.
   * fresh-per-doc: one request per session lease, session reused across docs.
   */
  async submit(doc, _opts) {
    if (!this.started) await this.warm();
    const session = await this.acquire();
    const reqId = `${this.opts.prefix}-${++this.counter}`;
    const filename = doc.filename ?? doc.path ?? doc.id;
    const outPath = path.join(this.tmpDir, `result-${reqId}.json`);
    const cleanup = [outPath];
    const t0 = Date.now();
    let sessionStarted = false;
    let doneRows = 0;
    let doneConf;
    try {
      const bytes = doc.bytes;
      const pdf = isPdfBytes(bytes);
      const inputPath = path.join(this.tmpDir, `input-${reqId}${pdf ? ".pdf" : path.extname(filename) || ".png"}`);
      await fs.writeFile(inputPath, typeof bytes === "string" ? bytes : Buffer.from(bytes));
      cleanup.push(inputPath);
      let pages = [];
      let payload;
      if (pdf) {
        pages = await rasterizePdf(inputPath, this.tmpDir, reqId, this.opts.maxPdfPages ?? 20);
        cleanup.push(...pages);
        payload = {
          reqId,
          filename: path.basename(filename),
          sourceType: "PDF",
          imagePaths: pages.map((p, i) => ({ path: p, page: i + 1 })),
          outPath
        };
      } else {
        payload = { reqId, filename: path.basename(filename), sourceType: "IMAGE", imagePath: inputPath, outPath };
      }
      if (this.aiInput === "vision+ocr") {
        const ocr = await extractOcrText({ inputPath, isPdf: pdf, pagePngs: pages });
        payload.ocrText = ocr.text;
        payload.ocrSource = ocr.source;
        payload.ocrNote = "\uCD08\uBC8C \uC804\uC0AC(\uCC38\uACE0\uC6A9, \uC624\uB958 \uAC00\uB2A5) \u2014 \uC774\uBBF8\uC9C0\uAC00 \uC815\uB2F5\uC774\uBA70 OCR\uC740 \uAD50\uCC28\uAC80\uC99D\uC6A9";
        this.log(`pool: ${filename} ocr=${ocr.source} (${ocr.text.length} chars)`);
      }
      this.onSession?.start({
        session_id: reqId,
        doc: path.basename(filename),
        backend: this.backend,
        pages: pdf ? pages.length : 1
      });
      sessionStarted = true;
      await this.transport.send(session, "[DOC-EXTRACT] " + JSON.stringify(payload));
      const raw = await this.transport.collect(outPath, this.timeoutMs);
      const { rows, minConfidence } = normalizeAiRows(raw, filename);
      const stamped = stampParser(rows, "vision-pool", {
        file: filename,
        confidence: minConfidence ?? 0.8
      });
      doneRows = stamped.length;
      doneConf = minConfidence;
      this.log(`pool: ${filename} \u2192 ${stamped.length} row(s) via ${session}`);
      return { rows: stamped, minConfidence };
    } finally {
      if (sessionStarted) {
        this.onSession?.done({
          session_id: reqId,
          duration_ms: Date.now() - t0,
          rows: doneRows,
          ...doneConf !== void 0 ? { self_conf: doneConf } : {}
        });
      }
      for (const p of cleanup) await fs.rm(p, { force: true }).catch(() => {
      });
      this.release(session);
    }
  }
  /**
   * 2D 배치: 여러 문서의 파일 "경로"를 한 요청으로 전달(이미지 합치기 X, 각 원본 풀해상도).
   * 세션 하나를 lease해 batch payload 를 보내고, 응답을 docId 별 LaneOutput[] 로 분리해 반환.
   */
  async submitBatch(docs, _opts) {
    if (!this.started) await this.warm();
    const session = await this.acquire();
    const reqId = `${this.opts.prefix}-b${++this.counter}`;
    const outPath = path.join(this.tmpDir, `result-${reqId}.json`);
    const cleanup = [outPath];
    const entries = [];
    const meta = [];
    const t0 = Date.now();
    try {
      for (let i = 0; i < docs.length; i++) {
        const doc = docs[i];
        const docId = doc.id ?? `DOC-${i + 1}`;
        const filename = doc.filename ?? doc.path ?? doc.id;
        const bytes = doc.bytes;
        const pdf = isPdfBytes(bytes);
        const inputPath = path.join(this.tmpDir, `input-${reqId}-${i}${pdf ? ".pdf" : path.extname(filename) || ".png"}`);
        await fs.writeFile(inputPath, typeof bytes === "string" ? bytes : Buffer.from(bytes));
        cleanup.push(inputPath);
        let pages = [];
        let entry;
        if (pdf) {
          pages = await rasterizePdf(inputPath, this.tmpDir, `${reqId}-${i}`, this.opts.maxPdfPages ?? 20);
          cleanup.push(...pages);
          entry = { docId, filename: path.basename(filename), sourceType: "PDF", imagePaths: pages.map((p, j) => ({ path: p, page: j + 1 })) };
        } else {
          entry = { docId, filename: path.basename(filename), sourceType: "IMAGE", imagePath: inputPath };
        }
        if (this.aiInput === "vision+ocr") {
          const ocr = await extractOcrText({ inputPath, isPdf: pdf, pagePngs: pages });
          entry.ocrText = ocr.text;
          entry.ocrSource = ocr.source;
        }
        entries.push(entry);
        meta.push({ docId, filename, pages: pdf ? pages.length : 1 });
        this.onSession?.start({ session_id: `${reqId}-${i}`, doc: path.basename(filename), backend: this.backend, pages: pdf ? pages.length : 1 });
      }
      await this.transport.send(session, "[DOC-EXTRACT] " + JSON.stringify({ reqId, batch: entries, outPath }));
      const timeout = this.timeoutMs * Math.max(1, Math.ceil(docs.length / 2));
      const raw = await this.transport.collect(outPath, timeout);
      const byId = /* @__PURE__ */ new Map();
      for (const r of raw?.results ?? []) if (r && r.docId !== void 0) byId.set(String(r.docId), r);
      return meta.map((m, i) => {
        const res = byId.get(m.docId) ?? { rows: [] };
        const { rows, minConfidence } = normalizeAiRows({ rows: res.rows ?? [], unreadable: res.unreadable }, m.filename);
        const stamped = stampParser(rows, "vision-pool", { file: m.filename, confidence: minConfidence ?? 0.8 });
        this.onSession?.done({ session_id: `${reqId}-${i}`, duration_ms: Date.now() - t0, rows: stamped.length, ...minConfidence !== void 0 ? { self_conf: minConfidence } : {} });
        this.log(`pool[batch ${reqId}]: ${m.filename} -> ${stamped.length} row(s)`);
        return { rows: stamped, minConfidence };
      });
    } finally {
      for (const p of cleanup) await fs.rm(p, { force: true }).catch(() => {
      });
      this.release(session);
    }
  }
  /** LaneRunner-compatible bound method for the router. */
  runner = (doc, opts) => this.submit(doc, opts);
  /** Stop every session and clean tmp. Safe to call more than once. */
  async teardown() {
    if (!this.started) return;
    for (const s of [...this.sessions].reverse()) {
      try {
        await this.transport.stop(s);
        this.log(`pool: stopped ${s}`);
      } catch (e) {
        this.log(`pool: teardown warning ${s}: ${e.message}`);
      }
    }
    this.sessions.length = 0;
    this.free.length = 0;
    this.started = false;
    await fs.rm(this.tmpDir, { recursive: true, force: true }).catch(() => {
    });
  }
};

// src/aggregate.ts
import { analyze } from "@comfozi/detectors";
function mergeRows(laneRows) {
  const rows = [];
  for (const group of laneRows) for (const r of group) rows.push(r);
  rows.forEach((r, i) => {
    if (r.__source) r.__source = { ...r.__source, row: i + 1 };
  });
  return rows;
}
function aggregate(laneRows) {
  const rows = mergeRows(laneRows);
  const analyses = analyze(rows);
  return { rows, analyses };
}

// src/run.ts
import { analyze as analyze2 } from "@comfozi/detectors";

// src/events.ts
import { STAGE_ORDER, STAGE_LABEL, foldRun, emptyRunState } from "@comfozi/contract";
var RunEventEmitter = class {
  constructor(runId, clock = () => (/* @__PURE__ */ new Date()).toISOString(), onEvent) {
    this.runId = runId;
    this.clock = clock;
    this.onEvent = onEvent;
  }
  runId;
  clock;
  onEvent;
  /** 발화된 모든 이벤트(발생 순서). */
  events = [];
  seq = 0;
  push(partial) {
    const ev = {
      v: 1,
      run_id: this.runId,
      seq: ++this.seq,
      ts: this.clock(),
      ...partial
    };
    this.events.push(ev);
    this.onEvent?.(ev);
  }
  runStart(inputs, config) {
    this.push({ type: "run.start", inputs, config });
  }
  stageStart(stage, total) {
    this.push({ type: "stage.start", stage, ...total !== void 0 ? { total } : {} });
  }
  stageProgress(stage, done, total, active_sessions) {
    this.push({ type: "stage.progress", stage, done, total, active_sessions });
  }
  /** duration_ms 는 옵션(순간 스테이지는 생략 가능 — 계약 §8.1). */
  stageDone(stage, duration_ms, out) {
    this.push({
      type: "stage.done",
      stage,
      ...duration_ms !== void 0 ? { duration_ms } : {},
      ...out ? { out } : {}
    });
  }
  stageError(stage, error, fatal) {
    this.push({ type: "stage.error", stage, error, fatal });
  }
  sessionStart(info) {
    this.push({ type: "session.start", ...info });
  }
  sessionDone(info) {
    this.push({ type: "session.done", ...info });
  }
  itemEvent(stage, doc_id, payload) {
    this.push({ type: "item.event", stage, doc_id, payload });
  }
  runDone(duration_ms, summary) {
    this.push({ type: "run.done", duration_ms, summary });
  }
  /** 버퍼를 runs/run_<id>.jsonl 본문으로(줄당 1 이벤트, trailing newline). */
  toJsonl() {
    return this.events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  }
};

// src/run.ts
function byteLen(bytes) {
  return typeof bytes === "string" ? Buffer.byteLength(bytes) : bytes.byteLength;
}
async function runPipeline(docs, opts = {}) {
  const mode = opts.mode ?? "auto";
  const limit = opts.concurrency ?? 2;
  const mono = opts.monoClock ?? (() => Date.now());
  const runId = opts.runId ?? `run_${(/* @__PURE__ */ new Date()).toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
  const em = new RunEventEmitter(runId, opts.clock, opts.onEvent);
  const deterministic = opts.deterministicRunner ?? runDeterministicOne;
  const runT0 = mono();
  const classified = docs.map((doc) => {
    const format = classifyFormat(doc);
    const structured = isDeterministicCandidate(format);
    const tryDet = mode === "ai" ? false : mode === "deterministic" ? true : structured;
    return { doc, format, structured, tryDet };
  });
  const inputs = classified.map((c) => ({
    name: c.doc.filename ?? c.doc.path ?? c.doc.id,
    size: byteLen(c.doc.bytes),
    kind: c.structured ? "structured" : "scan"
  }));
  em.runStart(inputs, { mode: opts.recordMode ?? "replay", concurrency: limit });
  {
    const t = mono();
    em.stageStart("route", docs.length);
    const aiPreliminary = classified.filter((c) => !c.tryDet).length;
    em.stageDone("route", mono() - t, {
      deterministic: docs.length - aiPreliminary,
      ai: aiPreliminary
    });
  }
  const detOut = /* @__PURE__ */ new Map();
  const detTargets = classified.filter((c) => c.tryDet);
  {
    const t = mono();
    em.stageStart("parse.deterministic", detTargets.length);
    const settled = await mapLimit(detTargets, limit, (c) => deterministic(c.doc, opts));
    settled.forEach((s, i) => {
      const id = detTargets[i].doc.id;
      detOut.set(id, s.status === "fulfilled" ? s.value : { rows: [], productiveRows: 0 });
    });
    const stayed = detTargets.filter(
      (c) => mode === "deterministic" || !shouldFallback(detOut.get(c.doc.id), opts)
    );
    const fellBack = detTargets.length - stayed.length;
    const detRows = stayed.reduce((n, c) => n + detOut.get(c.doc.id).rows.length, 0);
    em.stageDone("parse.deterministic", mono() - t, { rows: detRows, fallbacks: fellBack });
  }
  const staysDet = new Set(
    detTargets.filter((c) => mode === "deterministic" || !shouldFallback(detOut.get(c.doc.id), opts)).map((c) => c.doc.id)
  );
  const aiTargets = classified.filter((c) => !staysDet.has(c.doc.id));
  const aiOut = /* @__PURE__ */ new Map();
  {
    const t = mono();
    em.stageStart("parse.ai", aiTargets.length);
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
          done: (info) => em.sessionDone(info)
        }
      });
      try {
        const settled = await mapLimit(aiTargets, limit, (c) => pool.runner(c.doc, opts));
        settled.forEach((s, i) => {
          const id = aiTargets[i].doc.id;
          aiOut.set(id, s.status === "fulfilled" ? s.value : { rows: [] });
        });
      } finally {
        await pool.teardown();
      }
    }
    const aiRows = aiTargets.reduce((n, c) => n + (aiOut.get(c.doc.id)?.rows.length ?? 0), 0);
    em.stageDone("parse.ai", mono() - t, { rows: aiRows, sessions: aiTargets.length });
  }
  const laneRows = [];
  const routing = [];
  let detCount = 0;
  let aiCount = 0;
  let failed = 0;
  for (const c of classified) {
    const filename = c.doc.filename ?? c.doc.path ?? c.doc.id;
    if (staysDet.has(c.doc.id)) {
      const out = detOut.get(c.doc.id);
      laneRows.push(out.rows);
      detCount++;
      routing.push({
        docId: c.doc.id,
        filename,
        format: c.format,
        lane: "deterministic",
        reason: mode === "deterministic" ? "mode=deterministic" : "deterministic sufficient",
        deterministicRows: out.productiveRows ?? out.rows.length,
        minConfidence: out.minConfidence,
        aiFallbackUsed: false
      });
    } else {
      const out = aiOut.get(c.doc.id);
      const rows2 = out?.rows ?? [];
      laneRows.push(rows2);
      if (rows2.length === 0 && out === void 0) failed++;
      aiCount++;
      const wasFallback = c.tryDet;
      routing.push({
        docId: c.doc.id,
        filename,
        format: c.format,
        lane: "ai",
        reason: mode === "ai" ? "mode=ai (forced)" : wasFallback ? "deterministic thin \u2192 AI fallback" : "image/pixel format",
        deterministicRows: wasFallback ? detOut.get(c.doc.id)?.rows.length : void 0,
        minConfidence: out?.minConfidence,
        aiFallbackUsed: true
      });
    }
  }
  let rows;
  {
    const t = mono();
    em.stageStart("merge");
    rows = mergeRows(laneRows);
    em.stageDone("merge", mono() - t, { rows: rows.length });
  }
  let analyses;
  {
    const t = mono();
    em.stageStart("detect", rows.length);
    analyses = analyze2(rows);
    const findings2 = analyses.reduce((n, a) => n + a.findings.length, 0);
    const needsReview = analyses.filter((a) => !a.approvable).length;
    em.stageDone("detect", mono() - t, { findings: findings2, needs_review: needsReview });
  }
  const autoCandidate = analyses.filter((a) => a.approvable).length;
  const toHuman = analyses.length - autoCandidate;
  {
    const t = mono();
    em.stageStart("score", rows.length);
    em.stageDone("score", mono() - t, { auto_candidate: autoCandidate, to_human: toHuman });
  }
  {
    const t = mono();
    em.stageStart("export");
    em.stageDone("export", mono() - t, { records: autoCandidate, blocked: toHuman });
  }
  const findings = analyses.reduce((n, a) => n + a.findings.length, 0);
  em.runDone(mono() - runT0, {
    docs: docs.length,
    rows: rows.length,
    findings,
    approved: autoCandidate
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
      totalRows: rows.length
    },
    runId,
    events: em.events,
    jsonl: em.toJsonl()
  };
}

// src/index.ts
function resolveAiRunner(opts) {
  if (opts.aiRunner) return { runner: opts.aiRunner };
  const prefix = `fleet-${process.pid}`;
  const pool = new SessionPool({
    size: opts.concurrency ?? 2,
    prefix,
    transport: opts.transport,
    aiInput: opts.aiInput,
    log: opts.log
  });
  return { runner: pool.runner, pool };
}
async function routeBatched(docs, opts, deterministic, pool, limit, batchSize) {
  const mode = opts.mode ?? "auto";
  const results = new Array(docs.length).fill(void 0);
  const aiIdx = [];
  const mk = (doc, lane, reason, extra = {}) => ({
    docId: doc.id,
    filename: doc.filename ?? doc.path ?? doc.id,
    format: classifyFormat(doc),
    lane,
    reason,
    aiFallbackUsed: lane === "ai" && mode === "auto",
    ...extra
  });
  await mapLimit(docs, limit, async (doc, index) => {
    const format = classifyFormat(doc);
    if (mode === "ai") {
      aiIdx.push(index);
      return;
    }
    if (isDeterministicCandidate(format)) {
      const out = await deterministic(doc, opts);
      if (mode === "auto" && shouldFallback(out, opts)) {
        aiIdx.push(index);
        return;
      }
      results[index] = { decision: mk(doc, "deterministic", "deterministic", { deterministicRows: out.productiveRows ?? out.rows.length }), output: out };
      try {
        opts.onResult?.(out, doc, index);
      } catch {
      }
    } else {
      aiIdx.push(index);
    }
  });
  const batches = [];
  for (let i = 0; i < aiIdx.length; i += batchSize) batches.push(aiIdx.slice(i, i + batchSize));
  await mapLimit(batches, limit, async (batch) => {
    const outs = await pool.submitBatch(batch.map((idx) => docs[idx]), opts);
    batch.forEach((idx, k) => {
      const doc = docs[idx];
      const out = outs[k] ?? { rows: [] };
      results[idx] = { decision: mk(doc, "ai", mode === "ai" ? "forced AI (batch)" : "ai fallback (batch)"), output: out };
      try {
        opts.onResult?.(out, doc, idx);
      } catch {
      }
    });
  });
  return docs.map((_doc, i) => {
    const r = results[i];
    return r ? { status: "fulfilled", value: r } : { status: "rejected", reason: new Error(`doc ${i}: AI lane produced no result (session failed/timeout)`) };
  });
}
async function parseFleet(docs, opts = {}) {
  const deterministic = opts.deterministicRunner ?? runDeterministicOne;
  const { runner: ai, pool } = resolveAiRunner(opts);
  const limit = opts.concurrency ?? 2;
  try {
    const batchSize = opts.batchSize ?? 1;
    const mode = opts.mode ?? "auto";
    const settled = batchSize > 1 && pool && (mode === "ai" || mode === "auto") ? await routeBatched(docs, opts, deterministic, pool, limit, batchSize) : await mapLimit(docs, limit, async (doc, index) => {
      const r = await routeOne(doc, opts, deterministic, ai);
      try {
        opts.onResult?.(r.output, doc, index);
      } catch {
      }
      return r;
    });
    const routing = [];
    const laneRows = [];
    let failed = 0;
    let deterministicCount = 0;
    let aiCount = 0;
    settled.forEach((s, i) => {
      const doc = docs[i];
      if (s.status === "fulfilled") {
        routing.push(s.value.decision);
        laneRows.push(s.value.output.rows);
        if (s.value.decision.lane === "ai") aiCount++;
        else deterministicCount++;
      } else {
        failed++;
        routing.push({
          docId: doc.id,
          filename: doc.filename ?? doc.path ?? doc.id,
          format: "unknown",
          lane: "deterministic",
          reason: `lane error: ${s.reason?.message ?? String(s.reason)}`,
          aiFallbackUsed: false
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
        totalRows: rows.length
      }
    };
  } finally {
    if (pool) await pool.teardown();
  }
}

export {
  classifyFormat,
  isDeterministicCandidate,
  shouldFallback,
  routeOne,
  mapLimit,
  DETERMINISTIC_CHAIN,
  runDeterministicOne,
  runDeterministicBatch,
  DEFAULT_PARSER_PROFILE,
  rasterizePdf,
  hasTesseract,
  extractOcrText,
  iseshTransport,
  normalizeAiRows,
  SessionPool,
  mergeRows,
  aggregate,
  RunEventEmitter,
  STAGE_ORDER,
  STAGE_LABEL,
  foldRun,
  emptyRunState,
  runPipeline,
  parseFleet
};
//# sourceMappingURL=chunk-FGZ7KRXI.js.map