import { describe, it, expect } from 'vitest';
import { runDaemon, type DispatchOutcome } from '../../src/cli/daemon.js';
import type { Platform } from '../../src/types.js';

describe('runDaemon', () => {
  it('runs the executor exactly maxIterations times', async () => {
    let calls = 0;
    const executor = async (_tenant: string, _platforms: Platform[]): Promise<DispatchOutcome> => {
      calls += 1;
      return { dispatched: false, reason: 'nothing pending', ts: new Date().toISOString() };
    };
    await runDaemon({
      tenant: 'audiokids',
      platforms: ['x'],
      intervalMs: 1000,
      maxIterations: 3,
      sleep: async () => {},
      executor,
    });
    expect(calls).toBe(3);
  });

  it('sleeps intervalMs between iterations (not before the first)', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    await runDaemon({
      tenant: 'audiokids',
      platforms: ['x'],
      intervalMs: 60_000,
      maxIterations: 3,
      sleep: async (ms) => { sleeps.push(ms); },
      executor: async () => { calls += 1; return { dispatched: false, ts: new Date().toISOString() }; },
    });
    expect(calls).toBe(3);
    expect(sleeps).toEqual([60_000, 60_000]);
  });

  it('writes a heartbeat line per iteration', async () => {
    const lines: string[] = [];
    await runDaemon({
      tenant: 'audiokids',
      platforms: ['x', 'tiktok'],
      intervalMs: 1000,
      maxIterations: 2,
      sleep: async () => {},
      executor: async () => ({ dispatched: false, reason: 'nothing pending', ts: '2026-04-26T08:00:00.000Z' }),
      writer: (s) => lines.push(s),
    });
    const heartbeat = lines.find(l => /heartbeat/i.test(l));
    expect(heartbeat).toBeDefined();
    expect(heartbeat).toMatch(/audiokids/);
  });

  it('stops on stopSignal even mid-loop', async () => {
    let calls = 0;
    const stop = { triggered: false };
    setTimeout(() => { stop.triggered = true; }, 5);
    await runDaemon({
      tenant: 'audiokids',
      platforms: ['x'],
      intervalMs: 10,
      maxIterations: 100,
      sleep: async (ms) => {
        if (stop.triggered) return;
        await new Promise(r => setTimeout(r, ms));
      },
      shouldStop: () => stop.triggered,
      executor: async () => { calls += 1; return { dispatched: false, ts: new Date().toISOString() }; },
    });
    // Should have stopped well before reaching 100 iterations.
    expect(calls).toBeLessThan(100);
  });

  it('continues running when an iteration throws', async () => {
    let calls = 0;
    const errors: string[] = [];
    await runDaemon({
      tenant: 'audiokids',
      platforms: ['x'],
      intervalMs: 1000,
      maxIterations: 3,
      sleep: async () => {},
      executor: async () => {
        calls += 1;
        if (calls === 2) throw new Error('boom on iteration 2');
        return { dispatched: false, ts: new Date().toISOString() };
      },
      writer: (s) => { if (/error|boom/i.test(s)) errors.push(s); },
    });
    expect(calls).toBe(3);
    expect(errors.some(e => /boom on iteration 2/.test(e))).toBe(true);
  });

  it('reports successful dispatches in the writer', async () => {
    const lines: string[] = [];
    await runDaemon({
      tenant: 'audiokids',
      platforms: ['x'],
      intervalMs: 1000,
      maxIterations: 1,
      sleep: async () => {},
      executor: async () => ({ dispatched: true, slug: 'mystory', ts: '2026-04-26T08:00:00.000Z' }),
      writer: (s) => lines.push(s),
    });
    expect(lines.some(l => /mystory/.test(l))).toBe(true);
    expect(lines.some(l => /dispatched/i.test(l))).toBe(true);
  });
});
