import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
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
      storySlug: 'dragon-marcos',
      platform: 'x',
      reason: 'test',
      result: result('x'),
    });
    expect(entry.id).toBeDefined();
    expect(existsSync(logPath)).toBe(true);
    const fileContent = readFileSync(logPath, 'utf-8').trim();
    expect(JSON.parse(fileContent)).toMatchObject({ action: 'publish.x', storySlug: 'dragon-marcos' });
    rmSync(dir, { recursive: true, force: true });
  });

  it('filters list by storySlug', async () => {
    await log.record({ action: 'publish.x', storySlug: 'a', platform: 'x', reason: '', result: result('x') });
    await log.record({ action: 'publish.x', storySlug: 'b', platform: 'x', reason: '', result: result('x') });
    const onlyA = log.list({ storySlug: 'a' });
    expect(onlyA).toHaveLength(1);
    expect(onlyA[0].storySlug).toBe('a');
    rmSync(dir, { recursive: true, force: true });
  });

  it('filters list by platform', async () => {
    await log.record({ action: 'publish.x', storySlug: 's', platform: 'x', reason: '', result: result('x') });
    await log.record({ action: 'publish.tiktok', storySlug: 's', platform: 'tiktok', reason: '', result: result('tiktok') });
    const onlyTiktok = log.list({ platform: 'tiktok' });
    expect(onlyTiktok).toHaveLength(1);
    expect(onlyTiktok[0].platform).toBe('tiktok');
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns an empty array when the log file does not exist yet', () => {
    const freshLog = new DecisionLog(join(dir, 'not-created-yet.jsonl'));
    expect(freshLog.list()).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists runId when provided and filters list by runId', async () => {
    const runId = '11111111-2222-3333-4444-555555555555';
    await log.record({
      action: 'publish.x',
      storySlug: 's',
      platform: 'x',
      reason: '',
      result: result('x'),
      runId,
    });
    await log.record({
      action: 'publish.tiktok',
      storySlug: 's',
      platform: 'tiktok',
      reason: '',
      result: result('tiktok'),
      runId,
    });
    await log.record({
      action: 'publish.x',
      storySlug: 's',
      platform: 'x',
      reason: '',
      result: result('x'),
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    const fileContent = readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(JSON.parse(fileContent[0]).runId).toBe(runId);
    const filtered = log.list({ runId });
    expect(filtered).toHaveLength(2);
    expect(filtered.every(e => e.runId === runId)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('tolerates legacy entries without runId (backward compat) and list() still returns them', async () => {
    await log.record({ action: 'publish.x', storySlug: 's', platform: 'x', reason: '', result: result('x') });
    const entries = log.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].runId).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it('handles many concurrent appends without losing or corrupting entries', async () => {
    const N = 50;
    const writes = Array.from({ length: N }, (_, i) =>
      log.record({
        action: `publish.x`,
        storySlug: `slug-${i}`,
        platform: 'x',
        reason: '',
        result: result('x'),
      }),
    );
    await Promise.all(writes);
    const entries = log.list();
    expect(entries).toHaveLength(N);
    const slugs = new Set(entries.map(e => e.storySlug));
    expect(slugs.size).toBe(N);
    // Each line should be valid JSON on its own
    const lines = readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(N);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });
});
