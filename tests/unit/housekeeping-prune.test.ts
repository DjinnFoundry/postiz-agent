import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, utimesSync, rmSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pruneRenderLogs, pruneUploadCache } from '../../src/cli/housekeeping.js';
import { UploadCache } from '../../src/lib/upload-cache.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function makeLog(dir: string, name: string, ageDays: number, now: Date) {
  const p = join(dir, name);
  writeFileSync(p, `simulated stderr payload for ${name}`);
  const t = new Date(now.getTime() - ageDays * DAY_MS);
  utimesSync(p, t, t);
  return p;
}

describe('pruneRenderLogs', () => {
  let dir: string;
  const now = new Date('2026-04-22T12:00:00Z');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'render-logs-'));
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('returns zero counters when the directory does not exist', async () => {
    const missing = join(dir, 'does-not-exist');
    const res = await pruneRenderLogs({ dir: missing, olderThanDays: 30, now });
    expect(res.removed).toBe(0);
    expect(res.kept).toBe(0);
    expect(res.bytesFreed).toBe(0);
    expect(res.removedFiles).toEqual([]);
  });

  it('removes only files older than the cutoff', async () => {
    makeLog(dir, 'old-1.log', 60, now);
    makeLog(dir, 'old-2.log', 40, now);
    makeLog(dir, 'fresh-1.log', 10, now);
    makeLog(dir, 'fresh-2.log', 0, now);

    const res = await pruneRenderLogs({ dir, olderThanDays: 30, now });

    expect(res.removed).toBe(2);
    expect(res.kept).toBe(2);
    expect(res.bytesFreed).toBeGreaterThan(0);
    expect(res.removedFiles.map(f => f.split('/').pop()).sort()).toEqual(['old-1.log', 'old-2.log']);
    const remaining = readdirSync(dir).sort();
    expect(remaining).toEqual(['fresh-1.log', 'fresh-2.log']);
  });

  it('dry-run reports what would be removed but does not delete', async () => {
    makeLog(dir, 'old.log', 90, now);
    makeLog(dir, 'fresh.log', 5, now);

    const res = await pruneRenderLogs({ dir, olderThanDays: 30, now, dryRun: true });

    expect(res.removed).toBe(1);
    expect(res.kept).toBe(1);
    expect(res.removedFiles.map(f => f.split('/').pop())).toEqual(['old.log']);
    expect(existsSync(join(dir, 'old.log'))).toBe(true);
    expect(existsSync(join(dir, 'fresh.log'))).toBe(true);
  });

  it('skips non-.log files', async () => {
    makeLog(dir, 'ancient.log', 100, now);
    const noise = join(dir, 'README.md');
    writeFileSync(noise, 'not a log');
    const ancient = new Date(now.getTime() - 100 * DAY_MS);
    utimesSync(noise, ancient, ancient);

    const res = await pruneRenderLogs({ dir, olderThanDays: 30, now });
    expect(res.removed).toBe(1);
    expect(res.removedFiles.map(f => f.split('/').pop())).toEqual(['ancient.log']);
    expect(existsSync(noise)).toBe(true);
  });

  it('honors a custom retention window', async () => {
    makeLog(dir, 'a.log', 10, now);
    makeLog(dir, 'b.log', 3, now);
    const res = await pruneRenderLogs({ dir, olderThanDays: 7, now });
    expect(res.removed).toBe(1);
    expect(res.kept).toBe(1);
    expect(res.removedFiles.map(f => f.split('/').pop())).toEqual(['a.log']);
  });

  it('treats non-positive retention as no-op (never prunes)', async () => {
    makeLog(dir, 'a.log', 999, now);
    const res = await pruneRenderLogs({ dir, olderThanDays: 0, now });
    expect(res.removed).toBe(0);
    expect(res.kept).toBe(1);
  });

  it('returns zero counters when dir is empty', async () => {
    mkdirSync(dir, { recursive: true });
    const res = await pruneRenderLogs({ dir, olderThanDays: 30, now });
    expect(res.removed).toBe(0);
    expect(res.kept).toBe(0);
    expect(res.bytesFreed).toBe(0);
  });
});

describe('pruneUploadCache', () => {
  let tmpDir: string;
  let cachePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'upload-cache-prune-'));
    cachePath = join(tmpDir, 'upload-cache.json');
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('delegates to UploadCache.prune and reports removed + kept counts', () => {
    const t0 = new Date('2026-04-01T00:00:00Z');
    const ttl = 7 * DAY_MS;
    const c0 = new UploadCache(cachePath, ttl, () => t0);
    c0.set('stale', { mediaId: 'm-stale' });

    const t1 = new Date(t0.getTime() + 10 * DAY_MS);
    const c1 = new UploadCache(cachePath, ttl, () => t1);
    c1.set('fresh', { mediaId: 'm-fresh' });

    const res = pruneUploadCache({ cache: c1 });
    expect(res.removed).toBe(1);
    expect(res.kept).toBe(1);
  });

  it('returns zeros when the cache is empty / missing', () => {
    const cache = new UploadCache(cachePath);
    const res = pruneUploadCache({ cache });
    expect(res.removed).toBe(0);
    expect(res.kept).toBe(0);
  });

  it('does not double-count: all-stale collapses kept to 0', () => {
    const t0 = new Date('2026-04-01T00:00:00Z');
    const ttl = 7 * DAY_MS;
    const c0 = new UploadCache(cachePath, ttl, () => t0);
    c0.set('one', { mediaId: 'm-1' });
    c0.set('two', { mediaId: 'm-2' });

    const t1 = new Date(t0.getTime() + 30 * DAY_MS);
    const later = new UploadCache(cachePath, ttl, () => t1);
    const res = pruneUploadCache({ cache: later });
    expect(res.removed).toBe(2);
    expect(res.kept).toBe(0);
  });
});
