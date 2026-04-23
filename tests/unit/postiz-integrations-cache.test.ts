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

function makeClient(fakeNow: { value: number }, opts: { ttlMs?: number } = {}) {
  // Pass apiKey directly so assertPostizConfigured() passes without env.
  // Bypass the real upload cache to keep the test hermetic.
  return new PostizClient(
    'https://postiz.test/public/v1',
    'test-key',
    new UploadCache('/tmp/postiz-cache-test-ignored.json'),
    { integrationsCacheTtlMs: opts.ttlMs ?? 30_000, now: () => fakeNow.value },
  );
}

const FIXTURE: PostizIntegration[] = [
  { id: 'x-1', name: 'X', providerIdentifier: 'x', disabled: false },
  { id: 'tk-1', name: 'TikTok', providerIdentifier: 'tiktok', disabled: false },
  { id: 'ig-1', name: 'Instagram', providerIdentifier: 'instagram', disabled: false },
  { id: 'yt-1', name: 'YouTube', providerIdentifier: 'youtube', disabled: false },
];

describe('PostizClient integrations cache', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  const fakeNow = { value: 1_000_000 };

  beforeEach(() => {
    fakeNow.value = 1_000_000;
    // Each call must return a fresh Response; Response bodies are single-use.
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => mockResponse(FIXTURE));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('first findIntegration triggers exactly one HTTP call', async () => {
    const client = makeClient(fakeNow);
    const integ = await client.findIntegration('x');
    expect(integ.id).toBe('x-1');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('second findIntegration within TTL reuses the cached list (no HTTP call)', async () => {
    const client = makeClient(fakeNow);
    await client.findIntegration('x');
    await client.findIntegration('tiktok');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('parallel publish (4 platforms) only hits the API once', async () => {
    const client = makeClient(fakeNow);
    const [x, tk, ig, yt] = await Promise.all([
      client.findIntegration('x'),
      client.findIntegration('tiktok'),
      client.findIntegration('instagram'),
      client.findIntegration('youtube'),
    ]);
    expect([x.id, tk.id, ig.id, yt.id]).toEqual(['x-1', 'tk-1', 'ig-1', 'yt-1']);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('refetches after the TTL elapses', async () => {
    const client = makeClient(fakeNow, { ttlMs: 30_000 });
    await client.findIntegration('x');
    fakeNow.value += 30_001;
    await client.findIntegration('x');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('still serves from cache at the TTL boundary (exactly TTL ms)', async () => {
    const client = makeClient(fakeNow, { ttlMs: 30_000 });
    await client.findIntegration('x');
    fakeNow.value += 30_000;
    await client.findIntegration('x');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('invalidateIntegrationsCache() forces a refetch on the next call', async () => {
    const client = makeClient(fakeNow);
    await client.findIntegration('x');
    client.invalidateIntegrationsCache();
    await client.findIntegration('x');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('a failed fetch does not poison the cache; the next call retries the network', async () => {
    const client = makeClient(fakeNow);
    fetchSpy.mockResolvedValueOnce(mockResponse({ message: 'boom' }, false, 503));
    await expect(client.findIntegration('x')).rejects.toThrow(/failed \[503\]/);
    fetchSpy.mockResolvedValueOnce(mockResponse(FIXTURE));
    const integ = await client.findIntegration('x');
    expect(integ.id).toBe('x-1');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('listIntegrations() benefits from the same cache as findIntegration()', async () => {
    const client = makeClient(fakeNow);
    const a = await client.listIntegrations();
    const b = await client.listIntegrations();
    expect(a).toEqual(FIXTURE);
    expect(b).toEqual(FIXTURE);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
