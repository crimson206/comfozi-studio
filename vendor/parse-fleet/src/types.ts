/**
 * Fleet-level contract types.
 *
 * We CONSUME @comfozi/contract (RawRow) and @comfozi/doc-import (DocInput,
 * ParsedRow, DocFormat) as ground truth — never re-declare the field set. A
 * DocRef is one document to route; the fleet decides deterministic vs AI per
 * document, then aggregates into RawRow[] and runs @comfozi/detectors.
 *
 * NB: all imports here are TYPE-ONLY, so this module has zero runtime deps and
 * can be imported by offline unit tests without resolving the heavy packages.
 */
import type { DocInput, ParsedRow, DocFormat } from '@comfozi/doc-import';
import type { RowAnalysis } from '@comfozi/contract';

/** How the fleet decides which lane a document takes. */
export type FleetMode = 'auto' | 'deterministic' | 'ai';

/** The two processing lanes. */
export type Lane = 'deterministic' | 'ai';

/**
 * One document handed to the fleet. Compatible with @comfozi/doc-import's
 * DocInput (superset): adds an optional on-disk path for the CLI loader.
 */
export interface DocRef extends DocInput {
  /** absolute path on disk, if loaded from a directory (provenance/logging). */
  path?: string;
}

/** Per-document routing decision + evidence (dashboard/debugging). */
export interface RouteDecision {
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
export interface FleetOptions {
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
  aiInput?: import('./pool.js').AiInputMode;
  /** injected AI transport (test/offline). Default = live isesh/imessenger. */
  transport?: import('./pool.js').PoolTransport;
  /** injected deterministic runner (test). Default = wraps @comfozi/doc-import. */
  deterministicRunner?: LaneRunner;
  /** injected AI runner (test). Default = SessionPool over the transport. */
  aiRunner?: LaneRunner;
  /** ISO timestamp injected for determinism (passed to parser ctx). */
  now?: string;
  /** progress log sink. */
  log?: (msg: string) => void;
  /** streaming: fired as each document's lane output resolves (index = position in docs). */
  onResult?: (out: LaneOutput, doc: DocRef, index: number) => void;
}

/** What a lane runner returns for a single document. */
export interface LaneOutput {
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
export type LaneRunner = (doc: DocRef, opts: FleetOptions) => Promise<LaneOutput>;

/** Final fleet result. */
export interface FleetResult {
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
