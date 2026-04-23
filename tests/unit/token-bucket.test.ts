import { describe, it, expect } from 'vitest';
import { TokenBucket } from '../../src/lib/token-bucket.js';

function makeClock(start = 1_000_000) {
  const state = { value: start };
  const sleeps: number[] = [];
  return {
    state,
    sleeps,
    now: () => state.value,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      state.value += ms;
    },
  };
}

describe('TokenBucket', () => {
  it('first acquire returns immediately without sleeping', async () => {
    const clock = makeClock();
    const bucket = new TokenBucket({ ratePerSec: 10, now: clock.now, sleep: clock.sleep });
    await bucket.acquire();
    expect(clock.sleeps).toEqual([]);
  });

  it('consumes all burst tokens immediately then sleeps ~100ms at 10 req/s', async () => {
    const clock = makeClock();
    const bucket = new TokenBucket({ ratePerSec: 10, burst: 3, now: clock.now, sleep: clock.sleep });

    await bucket.acquire();
    await bucket.acquire();
    await bucket.acquire();
    expect(clock.sleeps).toEqual([]);

    await bucket.acquire();
    expect(clock.sleeps.length).toBe(1);
    expect(clock.sleeps[0]).toBeGreaterThanOrEqual(99);
    expect(clock.sleeps[0]).toBeLessThanOrEqual(101);
  });

  it('burst larger than ratePerSec allows a matching spike then throttles', async () => {
    const clock = makeClock();
    const bucket = new TokenBucket({ ratePerSec: 10, burst: 20, now: clock.now, sleep: clock.sleep });

    for (let i = 0; i < 20; i++) {
      await bucket.acquire();
    }
    expect(clock.sleeps).toEqual([]);

    await bucket.acquire();
    expect(clock.sleeps.length).toBe(1);
    expect(clock.sleeps[0]).toBeGreaterThan(0);
  });

  it('gradual refill: after 100ms at 10 req/s we have one more token', async () => {
    const clock = makeClock();
    const bucket = new TokenBucket({ ratePerSec: 10, burst: 1, now: clock.now, sleep: clock.sleep });

    await bucket.acquire();
    expect(clock.sleeps).toEqual([]);

    clock.state.value += 100;
    await bucket.acquire();
    expect(clock.sleeps).toEqual([]);
  });

  it('throws rate-limit acquire timeout when wait exceeds timeoutMs', async () => {
    const clock = makeClock();
    const bucket = new TokenBucket({ ratePerSec: 1, burst: 1, now: clock.now, sleep: clock.sleep });

    await bucket.acquire();
    await expect(bucket.acquire(100)).rejects.toThrow(/rate-limit acquire timeout/);
    expect(clock.sleeps).toEqual([]);
  });

  it('timeoutMs equal to required wait succeeds', async () => {
    const clock = makeClock();
    const bucket = new TokenBucket({ ratePerSec: 10, burst: 1, now: clock.now, sleep: clock.sleep });

    await bucket.acquire();
    await bucket.acquire(100);
    expect(clock.sleeps.length).toBe(1);
  });

  it('ratePerSec=0 disables waiting: acquire is a no-op', async () => {
    const clock = makeClock();
    const bucket = new TokenBucket({ ratePerSec: 0, now: clock.now, sleep: clock.sleep });

    for (let i = 0; i < 100; i++) {
      await bucket.acquire();
    }
    expect(clock.sleeps).toEqual([]);
  });

  it('burst defaults to ratePerSec when not provided', async () => {
    const clock = makeClock();
    const bucket = new TokenBucket({ ratePerSec: 5, now: clock.now, sleep: clock.sleep });

    for (let i = 0; i < 5; i++) {
      await bucket.acquire();
    }
    expect(clock.sleeps).toEqual([]);

    await bucket.acquire();
    expect(clock.sleeps.length).toBe(1);
  });

  it('refill caps at burst capacity (idle time does not stockpile beyond burst)', async () => {
    const clock = makeClock();
    const bucket = new TokenBucket({ ratePerSec: 10, burst: 3, now: clock.now, sleep: clock.sleep });

    clock.state.value += 10_000;

    await bucket.acquire();
    await bucket.acquire();
    await bucket.acquire();
    expect(clock.sleeps).toEqual([]);

    await bucket.acquire();
    expect(clock.sleeps.length).toBe(1);
  });

  it('serializes concurrent acquires so they do not all consume the same token', async () => {
    const clock = makeClock();
    const bucket = new TokenBucket({ ratePerSec: 10, burst: 2, now: clock.now, sleep: clock.sleep });

    await Promise.all([bucket.acquire(), bucket.acquire(), bucket.acquire(), bucket.acquire()]);

    expect(clock.sleeps.length).toBe(2);
    for (const s of clock.sleeps) {
      expect(s).toBeGreaterThan(0);
    }
  });
});
