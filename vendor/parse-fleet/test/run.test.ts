import { describe, it, expect } from 'vitest';
import { foldRun, STAGE_ORDER, type RunEvent } from '@comfozi/contract';
import { runPipeline } from '../src/run.js';
import { RunEventEmitter } from '../src/events.js';
import type { PoolTransport } from '../src/pool.js';
import type { DocRef, LaneRunner } from '../src/types.js';

/** Injected AI transport: writes canned rows to the file-drop outPath. */
function fakeTransport(rowsPerDoc = 2): PoolTransport {
  return {
    async start() {},
    async stop() {},
    async send(_s, message) {
      const payload = JSON.parse(message.replace(/^\[DOC-EXTRACT\]\s*/, '')) as {
        filename?: string;
        outPath: string;
      };
      const rows = Array.from({ length: rowsPerDoc }, (_, i) => ({
        doc_id: payload.filename ?? 'd',
        supplier: 'S',
        raw_item_name: `item-${i}`,
        prev_unit_price: 100,
        new_unit_price: 120,
        applied_date: '2026-08-05',
        confidence: 0.9,
      }));
      const { promises: fs } = await import('node:fs');
      await fs.writeFile(payload.outPath, JSON.stringify({ rows, unreadable: null }));
    },
    async collect(outPath, timeoutMs) {
      const { promises: fs } = await import('node:fs');
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          const t = await fs.readFile(outPath, 'utf8');
          if (t) return JSON.parse(t);
        } catch {
          /* wait */
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error('timeout');
    },
  };
}

const doc = (id: string, filename: string): DocRef => ({ id, filename, bytes: '' });

/** deterministic clock/monoClock for reproducible ts + durations. */
function fixtures() {
  let iso = 0;
  let mono = 0;
  return {
    clock: () => `2026-08-13T00:00:${String(iso++).padStart(2, '0')}.000Z`,
    monoClock: () => (mono += 10),
  };
}

describe('runPipeline — event emission', () => {
  it('emits a full, well-formed stage trace (mode=ai → fan-out)', async () => {
    const { clock, monoClock } = fixtures();
    const res = await runPipeline([doc('D1', 'a.pdf'), doc('D2', 'b.pdf')], {
      mode: 'ai',
      concurrency: 2,
      transport: fakeTransport(),
      poolPrefix: 'test',
      clock,
      monoClock,
    });

    const types = res.events.map((e) => e.type);
    expect(types[0]).toBe('run.start');
    expect(types.at(-1)).toBe('run.done');
    // every stage boundary present
    for (const t of ['stage.start', 'stage.done']) expect(types).toContain(t);
    // ③ fan-out: one session.start + session.done per doc
    expect(types.filter((t) => t === 'session.start')).toHaveLength(2);
    expect(types.filter((t) => t === 'session.done')).toHaveLength(2);

    // envelope invariants: seq strictly monotonic from 1, v=1, run_id stable
    res.events.forEach((e, i) => {
      expect(e.seq).toBe(i + 1);
      expect(e.v).toBe(1);
      expect(e.run_id).toBe(res.runId);
    });
  });

  it('folds to a fully-done run (all stages done, no active sessions)', async () => {
    const { clock, monoClock } = fixtures();
    const res = await runPipeline([doc('D1', 'a.pdf'), doc('D2', 'b.pdf')], {
      mode: 'ai',
      transport: fakeTransport(),
      poolPrefix: 'test',
      clock,
      monoClock,
    });
    const st = foldRun(res.events);
    expect(st.status).toBe('done');
    expect(st.lastSeq).toBe(res.events.length);
    // parse.ai + merge + detect + score + export ran; normalize/inbox stay pending
    for (const id of ['route', 'parse.ai', 'merge', 'detect', 'score', 'export'] as const) {
      expect(st.stages[id].status).toBe('done');
    }
    expect(st.sessions).toHaveLength(2);
    expect(st.sessions.every((s) => s.status === 'done')).toBe(true);
    expect(st.stages['parse.ai'].active_sessions).toBe(0);
  });

  it('routes deterministic-capable docs via injected det runner (no AI)', async () => {
    const det: LaneRunner = async () => ({ rows: [{ __source: { file: 'x', row: 1, parser: 'p' } }] as never, minConfidence: 0.9, productiveRows: 1 });
    const res = await runPipeline([doc('D1', 'a.csv')], {
      mode: 'auto',
      deterministicRunner: det,
      transport: fakeTransport(),
      poolPrefix: 'test',
    });
    expect(res.stats.deterministic).toBe(1);
    expect(res.stats.ai).toBe(0);
    expect(res.events.some((e) => e.type === 'session.start')).toBe(false);
  });
});

describe('foldRun — resilience (contract self-verification)', () => {
  async function sampleEvents(): Promise<RunEvent[]> {
    const { clock, monoClock } = fixtures();
    const res = await runPipeline([doc('D1', 'a.pdf'), doc('D2', 'b.pdf')], {
      mode: 'ai',
      transport: fakeTransport(),
      poolPrefix: 'test',
      clock,
      monoClock,
    });
    return res.events;
  }

  it('is order-insensitive and duplicate-seq safe', async () => {
    const events = await sampleEvents();
    const ref = foldRun(events);

    // shuffle + duplicate every 3rd event → must fold to the SAME state
    const shuffled = [...events].reverse();
    const dupes = events.filter((_, i) => i % 3 === 0);
    const scrambled = [...shuffled, ...dupes];

    const got = foldRun(scrambled);
    expect(got.status).toBe(ref.status);
    expect(got.lastSeq).toBe(ref.lastSeq);
    expect(got.sessions).toHaveLength(ref.sessions.length);
    for (const id of STAGE_ORDER) {
      expect(got.stages[id].status).toBe(ref.stages[id].status);
    }
  });

  it('folds a partial stream (tail dropped) to a still-running run', async () => {
    const events = await sampleEvents();
    // drop run.done + export stage.done → run should read as running, export pending
    const partial = events.filter(
      (e) => e.type !== 'run.done' && !(e.type === 'stage.done' && 'stage' in e && e.stage === 'export'),
    );
    const st = foldRun(partial);
    expect(st.status).toBe('running');
    expect(st.stages['export'].status).not.toBe('done');
    // earlier stages still resolved
    expect(st.stages['parse.ai'].status).toBe('done');
    expect(st.stages['detect'].status).toBe('done');
  });
});

describe('RunEventEmitter', () => {
  it('assigns monotonic seq and stamps envelope via injected clock', () => {
    const em = new RunEventEmitter('run_X', () => '2026-08-13T00:00:00.000Z');
    em.runStart([{ name: 'a', kind: 'scan' }], { mode: 'replay', concurrency: 2 });
    em.stageStart('route', 1);
    em.stageDone('route', 10, { ai: 1 });
    em.runDone(10, { docs: 1 });
    expect(em.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(em.events.every((e) => e.run_id === 'run_X' && e.ts.endsWith('Z'))).toBe(true);
    expect(em.toJsonl().trim().split('\n')).toHaveLength(4);
  });
});
