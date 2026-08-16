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
import type { DocFormat } from '@comfozi/doc-import';
import type { DocRef, FleetOptions, LaneOutput, LaneRunner, RouteDecision } from './types.js';

/** Pixel-only formats — deterministic text parsing cannot apply. */
const IMAGE_FORMATS: ReadonlySet<DocFormat> = new Set<DocFormat>([
  'pdf-image',
  'png',
  'jpg',
  'photo',
]);

/** Cheap format guess from the format hint or the filename extension. */
export function classifyFormat(doc: DocRef): DocFormat {
  if (doc.format && doc.format !== 'unknown') return doc.format;
  const name = (doc.filename ?? doc.path ?? doc.id ?? '').toLowerCase();
  const ext = name.slice(name.lastIndexOf('.') + 1);
  const byExt: Record<string, DocFormat> = {
    csv: 'csv',
    tsv: 'tsv',
    xlsx: 'xlsx',
    json: 'json',
    txt: 'txt',
    eml: 'eml',
    html: 'html',
    htm: 'html',
    md: 'md',
    png: 'png',
    jpg: 'jpg',
    jpeg: 'jpg',
    pdf: 'pdf-text', // ambiguous: treated as text-first; det lane may pass it on
  };
  return byExt[ext] ?? 'unknown';
}

/** Is this format a candidate for the deterministic lane at all? */
export function isDeterministicCandidate(format: DocFormat): boolean {
  return !IMAGE_FORMATS.has(format);
}

/** Should `auto` mode fall back to AI after a deterministic attempt? */
export function shouldFallback(out: LaneOutput, opts: FleetOptions): boolean {
  const floor = opts.detRowFloor ?? 1;
  const minConf = opts.minConfidence ?? 0.5;
  // Count RECOVERED rows only — a lone `unresolved` fail-candidate is NOT a win.
  const recovered = out.productiveRows ?? out.rows.length;
  if (recovered < floor) return true;
  if (out.minConfidence !== undefined && out.minConfidence < minConf) return true;
  return false;
}

export interface RoutedDoc {
  decision: RouteDecision;
  output: LaneOutput;
}

/**
 * Route + run ONE document. Returns the chosen lane's output plus the decision
 * record. `deterministic` and `ai` are injected runners.
 */
export async function routeOne(
  doc: DocRef,
  opts: FleetOptions,
  deterministic: LaneRunner,
  ai: LaneRunner,
): Promise<RoutedDoc> {
  const mode = opts.mode ?? 'auto';
  const format = classifyFormat(doc);
  const filename = doc.filename ?? doc.path ?? doc.id;
  const log = opts.log ?? (() => {});

  const decide = (
    lane: RouteDecision['lane'],
    reason: string,
    extra: Partial<RouteDecision> = {},
  ): RouteDecision => ({ docId: doc.id, filename, format, lane, reason, aiFallbackUsed: false, ...extra });

  // --- forced modes -------------------------------------------------------
  if (mode === 'ai') {
    log(`route ${filename}: forced AI`);
    const output = await ai(doc, opts);
    return { decision: decide('ai', 'mode=ai (forced)', { aiFallbackUsed: true }), output };
  }

  if (!isDeterministicCandidate(format)) {
    if (mode === 'deterministic') {
      // caller pinned deterministic but the format is pixels — honor the pin but
      // it will almost certainly yield a fail-candidate. Record honestly.
      log(`route ${filename}: image format under deterministic mode → likely fail-candidate`);
      const output = await deterministic(doc, opts);
      return { decision: decide('deterministic', 'image format, deterministic pinned'), output };
    }
    log(`route ${filename}: image format → AI`);
    const output = await ai(doc, opts);
    return { decision: decide('ai', 'image/pixel format', { aiFallbackUsed: true }), output };
  }

  // --- deterministic-first for text/table formats -------------------------
  const detOut = await deterministic(doc, opts);

  if (mode === 'deterministic') {
    return {
      decision: decide('deterministic', 'mode=deterministic (forced)', {
        deterministicRows: detOut.productiveRows ?? detOut.rows.length,
        minConfidence: detOut.minConfidence,
      }),
      output: detOut,
    };
  }

  // auto: evaluate the deterministic yield
  if (!shouldFallback(detOut, opts)) {
    return {
      decision: decide('deterministic', 'deterministic sufficient', {
        deterministicRows: detOut.productiveRows ?? detOut.rows.length,
        minConfidence: detOut.minConfidence,
      }),
      output: detOut,
    };
  }

  log(`route ${filename}: deterministic thin (rows=${detOut.rows.length}, conf=${detOut.minConfidence}) → AI fallback`);
  const aiOut = await ai(doc, opts);
  return {
    decision: decide('ai', 'deterministic thin → AI fallback', {
      deterministicRows: detOut.productiveRows ?? detOut.rows.length,
      minConfidence: detOut.minConfidence,
      aiFallbackUsed: true,
    }),
    output: aiOut,
  };
}
