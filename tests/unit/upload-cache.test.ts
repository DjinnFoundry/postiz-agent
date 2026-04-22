import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UploadCache, computeUploadTimeoutMs } from '../../src/lib/upload-cache.js';

function newTempCache(ttlMs = 7 * 24 * 60 * 60 * 1000, fakeNow?: Date) {
  const dir = mkdtempSync(join(tmpdir(), 'upload-cache-'));
  const path = join(dir, 'cache.json');
  const cache = new UploadCache(path, ttlMs, fakeNow ? () => fakeNow : undefined);
  return { dir, path, cache };
}

describe('UploadCache', () => {
  let dir: string;
  let cache: UploadCache;
  let path: string;

  beforeEach(() => {
    ({ dir, path, cache } = newTempCache());
  });

  it('returns undefined on miss', () => {
    expect(cache.get('nope')).toBeUndefined();
  });

  it('round-trips set → get', () => {
    cache.set('abc', { mediaId: 'm-1', path: '/tmp/x.mp4' });
    const got = cache.get('abc');
    expect(got?.mediaId).toBe('m-1');
    expect(got?.path).toBe('/tmp/x.mp4');
    expect(got?.uploadedAt).toBeDefined();
  });

  it('honors TTL: expired entries return undefined', () => {
    const fakeNow = new Date('2026-04-22T12:00:00Z');
    ({ dir, path, cache } = newTempCache(60_000, fakeNow));
    cache.set('abc', { mediaId: 'm-1' });
    // Move time forward past TTL
    const ancient = new Date(fakeNow.getTime() + 120_000);
    const cache2 = new UploadCache(path, 60_000, () => ancient);
    expect(cache2.get('abc')).toBeUndefined();
  });

  it('invalidate() drops an entry', () => {
    cache.set('abc', { mediaId: 'm-1' });
    cache.invalidate('abc');
    expect(cache.get('abc')).toBeUndefined();
  });

  it('prune() drops only expired entries', () => {
    const t0 = new Date('2026-04-22T12:00:00Z');
    const c0 = new UploadCache(path, 60_000, () => t0);
    c0.set('fresh', { mediaId: 'm-fresh' });
    const t1 = new Date(t0.getTime() + 120_000);
    const c1 = new UploadCache(path, 60_000, () => t1);
    // Write a new fresh entry at t1
    c1.set('newer', { mediaId: 'm-newer' });
    const dropped = c1.prune();
    expect(dropped).toBe(1);
    expect(c1.get('newer')?.mediaId).toBe('m-newer');
    expect(c1.get('fresh')).toBeUndefined();
  });

  it('hashFile() produces stable SHA256 for the same bytes', async () => {
    const file = join(dir, 'foo.mp4');
    writeFileSync(file, 'hello world');
    const a = await cache.hashFile(file);
    const b = await cache.hashFile(file);
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('hashFile() differs for different content', async () => {
    const a = join(dir, 'a.mp4'); writeFileSync(a, 'A');
    const b = join(dir, 'b.mp4'); writeFileSync(b, 'B');
    const hashA = await cache.hashFile(a);
    const hashB = await cache.hashFile(b);
    expect(hashA).not.toBe(hashB);
  });

  it('survives a corrupt cache file by starting fresh', () => {
    writeFileSync(path, '{not json'); // corrupt on disk
    const recovered = new UploadCache(path);
    expect(recovered.get('anything')).toBeUndefined();
    recovered.set('x', { mediaId: 'm-x' });
    expect(recovered.get('x')?.mediaId).toBe('m-x');
  });

  afterEachCleanup(() => dir);
});

function afterEachCleanup(getDir: () => string) {
  // We rely on the OS tmpdir to reap old dirs, but be polite.
  try { rmSync(getDir(), { recursive: true, force: true }); } catch { /* noop */ }
}

describe('computeUploadTimeoutMs', () => {
  it('returns base timeout (15s) for tiny files', () => {
    expect(computeUploadTimeoutMs(1)).toBe(15_000);
  });

  it('scales with file size assuming 200kbps worst-case uplink', () => {
    // 1MB at 200kbps ≈ 40s theoretical, padded × 1.5 = 60s
    const t = computeUploadTimeoutMs(1 * 1024 * 1024);
    expect(t).toBeGreaterThan(40_000);
    expect(t).toBeLessThan(120_000);
  });

  it('respects an explicit minKbps override', () => {
    const low = computeUploadTimeoutMs(10 * 1024 * 1024, { minKbps: 100 });
    const high = computeUploadTimeoutMs(10 * 1024 * 1024, { minKbps: 1000 });
    expect(low).toBeGreaterThan(high);
  });
});
