import { describe, it, expect } from 'vitest';
import { mapLimit } from '../src/util/mapLimit.js';

describe('mapLimit', () => {
  it('processes all items, preserving index order', async () => {
    const out = await mapLimit([1, 2, 3, 4], 2, async (n) => n * 10);
    expect(out.map((s) => (s.status === 'fulfilled' ? s.value : null))).toEqual([10, 20, 30, 40]);
  });

  it('never exceeds the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);
    await mapLimit(items, 3, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return n;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // actually ran concurrently
  });

  it('settles failures without rejecting the batch', async () => {
    const out = await mapLimit([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom');
      return n;
    });
    expect(out[0]).toEqual({ status: 'fulfilled', value: 1 });
    expect(out[1]!.status).toBe('rejected');
    expect(out[2]).toEqual({ status: 'fulfilled', value: 3 });
  });

  it('handles empty input', async () => {
    expect(await mapLimit([], 4, async (n) => n)).toEqual([]);
  });
});
