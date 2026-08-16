#!/usr/bin/env node
import {
  foldRun,
  parseFleet,
  runPipeline
} from "./chunk-ZZ6XISC3.js";

// src/cli.ts
import { parseArgs } from "util";
import { appendFileSync, writeFileSync } from "fs";
import { promises as fs } from "fs";
import * as path from "path";
var TEXT_EXT = /* @__PURE__ */ new Set([".csv", ".tsv", ".json", ".txt", ".eml", ".html", ".htm", ".md"]);
var EXT_FORMAT = {
  ".csv": "csv",
  ".tsv": "tsv",
  ".xlsx": "xlsx",
  ".json": "json",
  ".txt": "txt",
  ".eml": "eml",
  ".html": "html",
  ".htm": "html",
  ".md": "md",
  ".pdf": "pdf-text",
  // text-layer first; det chain passes on to AI if no text
  ".png": "png",
  ".jpg": "jpg",
  ".jpeg": "jpg"
};
async function loadDoc(file, id) {
  const ext = path.extname(file).toLowerCase();
  const isText = TEXT_EXT.has(ext);
  const bytes = isText ? await fs.readFile(file, "utf8") : new Uint8Array(await fs.readFile(file));
  return { id, filename: path.basename(file), path: path.resolve(file), bytes, format: EXT_FORMAT[ext] };
}
async function collectDocs(targets) {
  const files = [];
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
  return Promise.all(files.map((f, i) => loadDoc(f, `DOC-${String(i + 1).padStart(4, "0")}`)));
}
var HELP = `comfozi-parse-fleet \u2014 \uBCD1\uB82C \uBB38\uC11C \uD30C\uC2F1 \uC624\uCF00\uC2A4\uD2B8\uB808\uC774\uD130

Usage:
  comfozi-parse-fleet parse <dir|files...> [options]   # FleetResult JSON
  comfozi-parse-fleet run   <dir|files...> [options]   # + runs/run_<id>.jsonl \uBC1C\uD654

Options (parse & run):
  --concurrency <K>                 lane/AI-pool concurrency (default 2)
  --mode <auto|deterministic|ai>    routing mode (default auto; run \uB370\uBAA8\uB294 ai \uAD8C\uC7A5)
  --ai-input <vision|vision+ocr>    AI-lane input channel (default vision)
  --out <path>                      write result JSON (default stdout)
  --pretty                          indent JSON

Options (run only):
  --runs-dir <dir>                  run.jsonl \uCD9C\uB825 \uB514\uB809\uD130\uB9AC (default ./runs)
  --run-id <id>                     run \uC2DD\uBCC4\uC790 (default run_<ts>)
  --live                            \uC2E4\uC81C isesh AI \uC138\uC158 \uD480 \uC0AC\uC6A9 (default: \uACB0\uC815\uC801 mock \uD2B8\uB79C\uC2A4\uD3EC\uD2B8)
                                    mock = \uC7AC\uD604 \uAC00\uB2A5\uD55C \uB9AC\uD50C\uB808\uC774 \uC544\uD2F0\uD329\uD2B8(\uD30C\uC77C \uB4DC\uB86D \uD504\uB85C\uD1A0\uCF5C \uADF8\uB300\uB85C \uC2E4\uD589)

  --help / --version
`;
function mockAiTransport() {
  let dispatch = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  return {
    async start() {
    },
    async stop() {
    },
    async send(_session, message) {
      const json = message.replace(/^\[DOC-EXTRACT\]\s*/, "");
      const payload = JSON.parse(json);
      const name = payload.filename ?? "doc";
      const hasMissing = /누락/.test(name);
      const base = name.replace(/\.[^.]+$/, "");
      const rows = [
        {
          doc_id: base,
          source_type: "\uACF5\uBB38",
          supplier: base.split(/[_\s]/)[0] ?? base,
          raw_item_name: "\uD488\uBAA9-A",
          normalized_item_name: "\uD488\uBAA9 A",
          spec: "1kg",
          unit: "kg",
          prev_unit_price: 1e3,
          new_unit_price: 1200,
          applied_date: "2026-08-05",
          confidence: 0.9
        },
        {
          doc_id: base,
          source_type: "\uACF5\uBB38",
          supplier: base.split(/[_\s]/)[0] ?? base,
          raw_item_name: "\uD488\uBAA9-B",
          normalized_item_name: "\uD488\uBAA9 B",
          spec: "500g",
          unit: "g",
          prev_unit_price: 800,
          new_unit_price: hasMissing ? null : 900,
          applied_date: "2026-08-05",
          confidence: hasMissing ? 0.55 : 0.88
        }
      ];
      const n = ++dispatch;
      await sleep(120 + n % 3 * 90);
      await fs.writeFile(payload.outPath, JSON.stringify({ rows, unreadable: null }));
    },
    async collect(outPath, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          const text = await fs.readFile(outPath, "utf8");
          if (text.length > 0) return JSON.parse(text);
        } catch {
        }
        await sleep(50);
      }
      throw new Error(`mock collect timeout (${outPath})`);
    }
  };
}
async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      concurrency: { type: "string" },
      sessions: { type: "string" },
      stream: { type: "string" },
      batch: { type: "string" },
      mode: { type: "string" },
      "ai-input": { type: "string" },
      out: { type: "string" },
      "runs-dir": { type: "string" },
      "run-id": { type: "string" },
      live: { type: "boolean", default: false },
      pretty: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false }
    }
  });
  if (values.version) {
    process.stdout.write("0.1.0\n");
    return;
  }
  const cmd = positionals[0];
  if (values.help || cmd === void 0 || cmd === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (cmd !== "parse" && cmd !== "run") {
    process.stderr.write(`comfozi-parse-fleet: unknown command: ${cmd}

${HELP}`);
    process.exit(1);
  }
  const targets = positionals.slice(1);
  if (targets.length === 0) {
    process.stderr.write(`comfozi-parse-fleet: ${cmd} requires <dir|files...>
`);
    process.exit(1);
  }
  const mode = values.mode ?? "auto";
  const concurrency = values.sessions ? Number(values.sessions) : values.concurrency ? Number(values.concurrency) : 2;
  const batchSize = values.batch ? Number(values.batch) : 1;
  const aiInput = values["ai-input"] ?? "vision";
  if (aiInput !== "vision" && aiInput !== "vision+ocr") {
    process.stderr.write(`comfozi-parse-fleet: invalid --ai-input: ${aiInput}
`);
    process.exit(1);
  }
  const docs = await collectDocs(targets);
  process.stderr.write(
    `comfozi-parse-fleet: ${docs.length} document(s), mode=${mode}, sessions=${concurrency}, batch=${batchSize}, ai-input=${aiInput}
`
  );
  if (cmd === "run") {
    const runsDir = path.resolve(values["runs-dir"] ?? "runs");
    const transport = values.live ? void 0 : mockAiTransport();
    if (!values.live) {
      process.stderr.write("comfozi-parse-fleet: AI lane = deterministic mock transport (use --live for isesh)\n");
    }
    const result2 = await runPipeline(docs, {
      mode,
      concurrency,
      aiInput,
      recordMode: values.live ? "live" : "replay",
      runId: values["run-id"],
      transport,
      log: (m) => process.stderr.write(`  ${m}
`),
      onEvent: (ev) => process.stderr.write(`  \u25B8 ${ev.type}${"stage" in ev ? ` ${ev.stage}` : ""}
`)
    });
    await fs.mkdir(runsDir, { recursive: true });
    const jsonlPath = path.join(runsDir, `${result2.runId}.jsonl`);
    await fs.writeFile(jsonlPath, result2.jsonl);
    const folded = foldRun(result2.events);
    const stagesDone = Object.values(folded.stages).filter((s) => s.status === "done").length;
    process.stderr.write(
      `comfozi-parse-fleet: run.jsonl \u2192 ${jsonlPath}
  events=${result2.events.length} lastSeq=${folded.lastSeq} runStatus=${folded.status} stagesDone=${stagesDone}/${folded.order.length} sessions=${folded.sessions.length}
`
    );
    if (values.out) {
      await fs.writeFile(values.out, JSON.stringify(result2, null, values.pretty ? 2 : void 0) + "\n");
    }
    process.stderr.write(
      `comfozi-parse-fleet: done \u2014 rows=${result2.stats.totalRows} det=${result2.stats.deterministic} ai=${result2.stats.ai} failed=${result2.stats.failed}
`
    );
    return;
  }
  const streamPath = values.stream;
  if (streamPath) writeFileSync(streamPath, "");
  const result = await parseFleet(docs, {
    mode,
    concurrency,
    batchSize,
    aiInput,
    log: (m) => process.stderr.write(`  ${m}
`),
    onResult: streamPath ? (out, doc, i) => {
      const name = doc.filename ?? doc.path ?? doc.id;
      const body = out.rows.length ? out.rows.map((r) => JSON.stringify({ __doc: name, ...r })).join("\n") + "\n" : JSON.stringify({ __doc: name, __rows: 0 }) + "\n";
      appendFileSync(streamPath, body);
      process.stderr.write(`  stream[${i + 1}/${docs.length}]: ${name} \u2192 ${out.rows.length} row(s)
`);
    } : void 0
  });
  const json = JSON.stringify(result, null, values.pretty ? 2 : void 0) + "\n";
  if (values.out) await fs.writeFile(values.out, json);
  else process.stdout.write(json);
  process.stderr.write(
    `comfozi-parse-fleet: done \u2014 rows=${result.stats.totalRows} det=${result.stats.deterministic} ai=${result.stats.ai} failed=${result.stats.failed}
`
  );
}
main(process.argv.slice(2)).catch((e) => {
  process.stderr.write(`comfozi-parse-fleet: ${e.message}
`);
  process.exit(1);
});
//# sourceMappingURL=cli.js.map