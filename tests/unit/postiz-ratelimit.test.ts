import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PostizClient, type PostizIntegration } from '../../src/platforms/postiz.js';
import { UploadCache } from '../../src/lib/upload-cache.js';

function mockResponse(body: unknown, ok = true, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
    statusText: ok ? 'OK' : 'ERR',
  });
}

const FIXTURE: PostizIntegration[] = [
  { id: 'x-1', name: 'X', providerIdentifier: 'x', disabled: false },
];

interface FakeClock {
  state: { value: number };
  sleeps: number[];
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

function makeClock(start = 1_000_000): FakeClock {
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

function makeClient(clock: FakeClock, opts: { ratePerSec?: number; burst?: number; acquireTimeoutMs?: number } = {}) {
  return new PostizClient(
    'https://postiz.test/public/v1',
    'test-key',
    new UploadCache('/tmp/postiz-cache-test-ignored.json'),
    {
      now: clock.now,
      rateLimitPerSec: opts.ratePerSec,
      rateLimitBurst: opts.burst,
      rateLimitSleep: clock.sleep,
      rateLimitAcquireTimeoutMs: opts.acquireTimeoutMs,
    },
  );
}

describe('PostizClient rate limiting', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => mockResponse(FIXTURE));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('ratePerSec=2 with 3 requests forces the extras to wait', async () => {
    const clock = makeClock();
    const client = makeClient(clock, { ratePerSec: 2, burst: 2 });

    await client.listIntegrations();
    client.invalidateIntegrationsCache();
    await client.listIntegrations();
    expect(clock.sleeps).toEqual([]);

    client.invalidateIntegrationsCache();
    await client.listIntegrations();
    expect(clock.sleeps.length).toBe(1);
    expect(clock.sleeps[0]).toBeGreaterThan(0);
  });

  it('ratePerSec=0 disables rate limiting: no waits regardless of burst', async () => {
    const clock = makeClock();
    const client = makeClient(clock, { ratePerSec: 0 });

    for (let i = 0; i < 20; i++) {
      await client.listIntegrations();
      client.invalidateIntegrationsCache();
    }
    expect(clock.sleeps).toEqual([]);
  });

  it('acquire timeout surfaces as a thrown error from request()', async () => {
    const clock = makeClock();
    const client = makeClient(clock, { ratePerSec: 1, burst: 1, acquireTimeoutMs: 50 });

    await client.listIntegrations();
    client.invalidateIntegrationsCache();

    await expect(client.listIntegrations()).rejects.toThrow(/rate-limit acquire timeout/);
  });

  it('default rateLimitPerSec (10) is applied when not provided', async () => {
    const clock = makeClock();
    const client = new PostizClient(
      'https://postiz.test/public/v1',
      'test-key',
      new UploadCache('/tmp/postiz-cache-test-ignored.json'),
      { now: clock.now, rateLimitSleep: clock.sleep },
    );

    for (let i = 0; i < 10; i++) {
      await client.listIntegrations();
      client.invalidateIntegrationsCache();
    }
    expect(clock.sleeps).toEqual([]);

    await client.listIntegrations();
    expect(clock.sleeps.length).toBe(1);
    expect(clock.sleeps[0]).toBeGreaterThan(0);
  });
});
