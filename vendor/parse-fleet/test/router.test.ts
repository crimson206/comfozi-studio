import { describe, it, expect } from 'vitest';
import { classifyFormat, isDeterministicCandidate, shouldFallback, routeOne } from '../src/router.js';
import type { DocRef, FleetOptions, LaneOutput, LaneRunner } from '../src/types.js';

function doc(id: string, filename: string, format?: DocRef['format']): DocRef {
  return { id, filename, format, bytes: '' };
}

/** A lane runner that records calls and returns a fixed output. */
function fakeRunner(label: string, out: LaneOutput, calls: string[]): LaneRunner {
  return async (d) => {
    calls.push(`${label}:${d.id}`);
    return out;
  };
}

const rows = (n: number, conf?: number): LaneOutput => ({
  rows: Array.from({ length: n }, () => ({ __source: { file: 'x', row: 1, parser: 'p' } })) as never,
  minConfidence: conf,
});

describe('classifyFormat', () => {
  it('prefers explicit format hint', () => {
    expect(classifyFormat(doc('1', 'x.csv', 'json'))).toBe('json');
  });
  it('falls back to extension', () => {
    expect(classifyFormat(doc('1', 'a.CSV'))).toBe('csv');
    expect(classifyFormat(doc('1', 'a.png'))).toBe('png');
    expect(classifyFormat(doc('1', 'a.jpeg'))).toBe('jpg');
    expect(classifyFormat(doc('1', 'a.pdf'))).toBe('pdf-text');
    expect(classifyFormat(doc('1', 'a.weird'))).toBe('unknown');
  });
});

describe('isDeterministicCandidate', () => {
  it('rejects pixel formats, accepts text/table', () => {
    expect(isDeterministicCandidate('png')).toBe(false);
    expect(isDeterministicCandidate('pdf-image')).toBe(false);
    expect(isDeterministicCandidate('csv')).toBe(true);
    expect(isDeterministicCandidate('pdf-text')).toBe(true);
  });
});

describe('shouldFallback', () => {
  const opts: FleetOptions = { detRowFloor: 1, minConfidence: 0.5 };
  it('falls back when rows below floor', () => {
    expect(shouldFallback(rows(0), opts)).toBe(true);
    expect(shouldFallback(rows(3), opts)).toBe(false);
  });
  it('falls back when confidence below threshold', () => {
    expect(shouldFallback(rows(3, 0.4), opts)).toBe(true);
    expect(shouldFallback(rows(3, 0.9), opts)).toBe(false);
  });
});

describe('routeOne', () => {
  it('mode=deterministic never calls AI', async () => {
    const calls: string[] = [];
    const det = fakeRunner('det', rows(2), calls);
    const ai = fakeRunner('ai', rows(9), calls);
    const r = await routeOne(doc('D', 'a.csv'), { mode: 'deterministic' }, det, ai);
    expect(r.decision.lane).toBe('deterministic');
    expect(calls).toEqual(['det:D']);
  });

  it('mode=ai always calls AI', async () => {
    const calls: string[] = [];
    const det = fakeRunner('det', rows(2), calls);
    const ai = fakeRunner('ai', rows(9), calls);
    const r = await routeOne(doc('D', 'a.csv'), { mode: 'ai' }, det, ai);
    expect(r.decision.lane).toBe('ai');
    expect(r.decision.aiFallbackUsed).toBe(true);
    expect(calls).toEqual(['ai:D']);
  });

  it('auto: image format routes straight to AI (det not called)', async () => {
    const calls: string[] = [];
    const det = fakeRunner('det', rows(2), calls);
    const ai = fakeRunner('ai', rows(5), calls);
    const r = await routeOne(doc('D', 'scan.png'), { mode: 'auto' }, det, ai);
    expect(r.decision.lane).toBe('ai');
    expect(r.decision.format).toBe('png');
    expect(calls).toEqual(['ai:D']);
  });

  it('auto: sufficient deterministic yield stays deterministic', async () => {
    const calls: string[] = [];
    const det = fakeRunner('det', rows(4, 0.9), calls);
    const ai = fakeRunner('ai', rows(5), calls);
    const r = await routeOne(doc('D', 'a.csv'), { mode: 'auto' }, det, ai);
    expect(r.decision.lane).toBe('deterministic');
    expect(r.decision.deterministicRows).toBe(4);
    expect(calls).toEqual(['det:D']);
  });

  it('auto: thin deterministic yield falls back to AI', async () => {
    const calls: string[] = [];
    const det = fakeRunner('det', rows(0), calls);
    const ai = fakeRunner('ai', rows(3), calls);
    const r = await routeOne(doc('D', 'a.txt'), { mode: 'auto' }, det, ai);
    expect(r.decision.lane).toBe('ai');
    expect(r.decision.aiFallbackUsed).toBe(true);
    expect(r.decision.deterministicRows).toBe(0);
    expect(calls).toEqual(['det:D', 'ai:D']);
  });

  it('auto: rows present but 0 productive (all fail-candidates) falls back to AI', async () => {
    const calls: string[] = [];
    // one row, but it is an `unresolved` fail-candidate → productiveRows:0
    const det: LaneRunner = async (d) => {
      calls.push(`det:${d.id}`);
      return { rows: [{ __source: { file: 'x', row: 1, parser: 'unresolved' } }] as never, productiveRows: 0 };
    };
    const ai = fakeRunner('ai', rows(3, 0.9), calls);
    const r = await routeOne(doc('D', 'vendor.pdf', 'pdf-text'), { mode: 'auto' }, det, ai);
    expect(r.decision.lane).toBe('ai');
    expect(r.decision.aiFallbackUsed).toBe(true);
    expect(r.decision.deterministicRows).toBe(0);
    expect(calls).toEqual(['det:D', 'ai:D']);
  });

  it('auto: low-confidence deterministic yield falls back to AI', async () => {
    const calls: string[] = [];
    const det = fakeRunner('det', rows(3, 0.3), calls);
    const ai = fakeRunner('ai', rows(3, 0.9), calls);
    const r = await routeOne(doc('D', 'a.html'), { mode: 'auto', minConfidence: 0.5 }, det, ai);
    expect(r.decision.lane).toBe('ai');
    expect(calls).toEqual(['det:D', 'ai:D']);
  });
});
