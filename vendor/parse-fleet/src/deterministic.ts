/**
 * Deterministic lane — in-process, no AI. Wraps @comfozi/doc-import's
 * chain-of-responsibility text/table parsers (base 재구현 금지). We build a
 * DETERMINISTIC-ONLY chain (no vision) so this lane never touches a session; the
 * router is responsible for sending pixel/low-yield docs to the AI lane instead.
 *
 * Batch entry `runDeterministicBatch` runs many docs concurrently via mapLimit;
 * `runDeterministicOne` is the LaneRunner the router injects per document.
 */
import {
  runParserChainDetailed,
  deterministicTextParser,
  noisyTableParser,
  spaceTableParser,
  type DocParser,
  type ParsedRow,
  type ParserContext,
} from '@comfozi/doc-import';
import type { DocRef, FleetOptions, LaneOutput } from './types.js';
import { mapLimit } from './util/mapLimit.js';

/**
 * Deterministic-only chain (no vision), ordered to match doc-import's
 * buildChain(): text → space-table (관공서/레터헤드 공문 PDF) → noisy-table.
 * spaceTableParser fires on format==='pdf-text' or meta.__pdfBytes, so PDF docs
 * MUST carry format='pdf-text' (the CLI loader sets it from the extension).
 */
export const DETERMINISTIC_CHAIN: DocParser[] = [
  deterministicTextParser,
  spaceTableParser,
  noisyTableParser,
];

/** Lowest per-row confidence across candidates (undefined if none carry it). */
function lowestConfidence(rows: ParsedRow[]): number | undefined {
  let min: number | undefined;
  for (const r of rows) {
    const c = r.__source?.confidence;
    if (typeof c === 'number') min = min === undefined ? c : Math.min(min, c);
  }
  return min;
}

/** Rows a real parser recovered (fail-candidates carry parser='unresolved'). */
function productiveCount(rows: ParsedRow[]): number {
  return rows.filter((r) => r.__source?.parser !== 'unresolved').length;
}

/** Run the deterministic chain over a single document. */
export async function runDeterministicOne(doc: DocRef, opts: FleetOptions): Promise<LaneOutput> {
  const ctx: ParserContext = { now: opts.now, log: opts.log };
  const detail = await runParserChainDetailed(doc, DETERMINISTIC_CHAIN, ctx);
  return {
    rows: detail.candidates,
    minConfidence: lowestConfidence(detail.candidates),
    productiveRows: productiveCount(detail.candidates),
  };
}

/** Run the deterministic lane over many docs with bounded concurrency. */
export async function runDeterministicBatch(
  docs: readonly DocRef[],
  opts: FleetOptions,
): Promise<Array<LaneOutput | null>> {
  const limit = opts.concurrency ?? 2;
  const settled = await mapLimit(docs, limit, (doc) => runDeterministicOne(doc, opts));
  return settled.map((s) => (s.status === 'fulfilled' ? s.value : null));
}
