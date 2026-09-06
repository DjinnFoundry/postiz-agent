import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDaemon } from '../../src/cli/daemon.js';

afterEach(() => vi.useRealTimers());
describe('daemon lifecycle', () => {
  it('does not sleep when stopping after the current publish', async () => {
    let stopped = false;
    const sleep = vi.fn();
    await runDaemon({ tenant: 'default', platforms: ['x'], intervalMs: 3600_000, sleep, writer: () => {}, shouldStop: () => stopped, executor: async () => { stopped = true; return { dispatched: false, ts: '' }; } });
    expect(sleep).not.toHaveBeenCalled();
  });
  it('ends a long heartbeat wait immediately on abort', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const executor = vi.fn().mockResolvedValue({ dispatched: false, ts: '' });
    let exited = false;
    const task = runDaemon({ tenant: 'default', platforms: ['x'], intervalMs: 3600_000, signal: controller.signal, executor, writer: () => {} }).then(() => { exited = true; });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(exited).toBe(true);
    await task;
    expect(executor).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('nonpositive intervals run once instead of entering a busy loop', async () => {
    const executor = vi.fn().mockResolvedValue({ dispatched: false, ts: '' });
    await runDaemon({ tenant: 'default', platforms: ['x'], intervalMs: 0, maxIterations: 3, executor, writer: () => {} });
    expect(executor).toHaveBeenCalledTimes(1);
  });
});
