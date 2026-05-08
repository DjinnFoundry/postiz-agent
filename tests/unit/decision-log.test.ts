import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DecisionLog } from '../../src/decisions/log.js';
import type { PublishResult } from '../../src/types.js';

const result = (platform: PublishResult['platform'], success = true): PublishResult => ({
  platform,
  success,
  timestamp: new Date().toISOString(),
});

describe('DecisionLog', () => {
  let dir: string;
  let logPath: string;
  let log: DecisionLog;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'postiz-agent-log-'));
    logPath = join(dir, 'decisions.jsonl');
    log = new DecisionLog(logPath);
  });

  it('records an entry and appends it to the file', async () => {
    const entry = await log.record({
      action: 'publish.x',
      contentSlug: 'dragon-marcos',
      platform: 'x',
      reason: 'test',
      result: result('x'),
    });
    expect(entry.id).toBeDefined();
    expect(existsSync(logPath)).toBe(true);
    const fileContent = readFileSync(logPath, 'utf-8').trim();
    expect(JSON.parse(fileContent)).toMatchObject({ action: 'publish.x', contentSlug: 'dragon-marcos' });
    rmSync(dir, { recursive: true, force: true });
  });

  it('filters list by contentSlug', async () => {
    await log.record({ action: 'publish.x', contentSlug: 'a', platform: 'x', reason: '', result: result('x') });
    await log.record({ action: 'publish.x', contentSlug: 'b', platform: 'x', reason: '', result: result('x') });
    const onlyA = log.list({ contentSlug: 'a' });
    expect(onlyA).toHaveLength(1);
    expect(onlyA[0].contentSlug).toBe('a');
    rmSync(dir, { recursive: true, force: true });
  });

  it('filters list by platform', async () => {
    await log.record({ action: 'publish.x', contentSlug: 's', platform: 'x', reason: '', result: result('x') });
    await log.record({ action: 'publish.tiktok', contentSlug: 's', platform: 'tiktok', reason: '', result: result('tiktok') });
    const onlyTiktok = log.list({ platform: 'tiktok' });
    expect(onlyTiktok).toHaveLength(1);
    expect(onlyTiktok[0].platform).toBe('tiktok');
    rmSync(dir, { recursive: true, force: true });
  });

  it('normalizes legacy entries that only have storySlug', () => {
    writeFileSync(logPath, JSON.stringify({
      id: 'legacy',
      action: 'publish.x',
      storySlug: 'old-slug',
      platform: 'x',
      reason: '',
      result: result('x'),
      createdAt: new Date().toISOString(),
    }) + '\n');

    const entries = log.list({ contentSlug: 'old-slug' });
    expect(entries).toHaveLength(1);
    expect(entries[0].contentSlug).toBe('old-slug');
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns an empty array when the log file does not exist yet', () => {
    const freshLog = new DecisionLog(join(dir, 'not-created-yet.jsonl'));
    expect(freshLog.list()).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('handles many concurrent appends without losing or corrupting entries', async () => {
    const N = 50;
    const writes = Array.from({ length: N }, (_, i) =>
      log.record({
        action: `publish.x`,
        contentSlug: `slug-${i}`,
        platform: 'x',
        reason: '',
        result: result('x'),
      }),
    );
    await Promise.all(writes);
    const entries = log.list();
    expect(entries).toHaveLength(N);
    const slugs = new Set(entries.map(e => e.contentSlug));
    expect(slugs.size).toBe(N);
    // Each line should be valid JSON on its own
    const lines = readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(N);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });
});
