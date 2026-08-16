import { describe, it, expect } from 'vitest';
import { parseFleet } from '../src/index.js';
import type { PoolTransport } from '../src/pool.js';
import type { DocRef } from '../src/types.js';

/** Mock transport: parses the [DOC-EXTRACT] batch payload and returns per-docId rows. */
function mockBatchTransport() {
  const state = { batchesSent: 0, maxBatchLen: 0, last: null as any };
  const t: PoolTransport = {
    async start() {},
    async stop() {},
    async send(_s: string, msg: string) {
      const json = JSON.parse(msg.replace('[DOC-EXTRACT] ', ''));
      state.last = json;
      if (json.batch) {
        state.batchesSent++;
        state.maxBatchLen = Math.max(state.maxBatchLen, json.batch.length);
      }
    },
    async collect() {
      const j = state.last;
      if (j?.batch) {
        return {
          results: j.batch.map((e: any) => ({
            docId: e.docId,
            rows: [
              { doc_id: e.docId, source_type: 'IMAGE', supplier: 's', raw_item_name: 'itm-' + e.filename, prev_unit_price: '1', new_unit_price: '2' },
            ],
          })),
        };
      }
      return { rows: [{ doc_id: 'x', raw_item_name: 'single', prev_unit_price: '1', new_unit_price: '2' }] };
    },
  };
  return { t, state };
}

function png(id: string): DocRef {
  return { id, filename: id + '.png', format: 'png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) };
}

describe('2D batch AI parsing', () => {
  it('mode=ai batches docs (batchSize) and splits results per doc + streams', async () => {
    const docs = Array.from({ length: 20 }, (_, i) => png('DOC-' + (i + 1)));
    const { t, state } = mockBatchTransport();
    const streamed: string[] = [];
    const res = await parseFleet(docs, {
      mode: 'ai',
      concurrency: 4,
      batchSize: 8,
      transport: t,
      onResult: (_o, doc) => streamed.push(doc.filename!),
    });
    expect(state.batchesSent).toBe(3); // 20 / 8 = 3 batches (8,8,4)
    expect(state.maxBatchLen).toBe(8); // no batch exceeds Y
    expect(res.stats.documents).toBe(20);
    expect(res.stats.ai).toBe(20);
    expect(res.stats.failed).toBe(0);
    expect(res.rows.length).toBe(20); // one row per doc, attributed
    expect(streamed.length).toBe(20); // streaming fired per doc
    // per-doc attribution preserved
    const names = res.rows.map((r) => r.raw_item_name).sort();
    expect(names[0]).toBe('itm-DOC-1.png');
  });

  it('batchSize=1 keeps legacy per-doc path (no batch payload)', async () => {
    const docs = [png('A'), png('B')];
    const { t, state } = mockBatchTransport();
    const res = await parseFleet(docs, { mode: 'ai', concurrency: 2, batchSize: 1, transport: t });
    expect(state.batchesSent).toBe(0); // never sent a batch payload
    expect(res.stats.documents).toBe(2);
  });
});
