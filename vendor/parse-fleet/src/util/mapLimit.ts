/**
 * Bounded-concurrency map — the backpressure primitive shared by the in-process
 * deterministic lane and the AI session pool. Ported from the yeonseo
 * orchestrate.js `mapLimit` (JS) into typed, settle-don't-throw form.
 *
 * At most `limit` workers run at once; every item resolves to a settled result
 * so one failure never rejects the whole batch.
 */
export type Settled<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown };

export async function mapLimit<I, O>(
  items: readonly I[],
  limit: number,
  worker: (item: I, index: number, lane: number) => Promise<O>,
): Promise<Array<Settled<O>>> {
  const results: Array<Settled<O>> = new Array(items.length);
  let cursor = 0;
  const lanes = Math.max(1, Math.min(limit, items.length));

  async function run(lane: number): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index]!, index, lane) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }

  await Promise.all(Array.from({ length: lanes }, (_, lane) => run(lane)));
  return results;
}
