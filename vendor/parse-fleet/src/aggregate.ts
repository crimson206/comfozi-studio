/**
 * Aggregate — merge every lane's candidate rows, fix physical provenance row
 * numbers, and run @comfozi/detectors (base 재구현 금지: detection lives there).
 *
 * We do NOT re-implement dedup/exception logic; the duplicate/missing/spec/unit
 * verdicts come straight from `analyze()`. Aggregation here is only: concat +
 * stable ordering + provenance row re-stamp.
 */
import { analyze } from '@comfozi/detectors';
import type { RowAnalysis } from '@comfozi/contract';
import type { ParsedRow } from '@comfozi/doc-import';

export interface AggregateResult {
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
export function mergeRows(laneRows: ReadonlyArray<ParsedRow[]>): ParsedRow[] {
  const rows: ParsedRow[] = [];
  for (const group of laneRows) for (const r of group) rows.push(r);

  // Re-stamp physical row numbers to final position while preserving parser/file.
  rows.forEach((r, i) => {
    if (r.__source) r.__source = { ...r.__source, row: i + 1 };
  });

  return rows;
}

/**
 * Merge lane outputs into one RawRow[] and analyze (merge + detect coupled).
 * @param laneRows rows grouped per source document (preserves doc order).
 */
export function aggregate(laneRows: ReadonlyArray<ParsedRow[]>): AggregateResult {
  const rows = mergeRows(laneRows);
  const analyses = analyze(rows);
  return { rows, analyses };
}
