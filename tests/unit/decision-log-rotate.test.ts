import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DecisionLog } from '../../src/decisions/log.js';
import type { PublishResult } from '../../src/types.js';

const result = (platform: PublishResult['platform'], success = true): PublishResult => ({
  platform,
  success,
  timestamp: new Date().toISOString(),
});

describe('DecisionLog rotation', () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'postiz-agent-rotate-'));
    logPath = join(dir, 'decisions.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('shouldRotate returns false when the file does not exist yet', () => {
    const log = new DecisionLog(logPath, { maxBytes: 100 });
    expect(log.shouldRotate()).toBe(false);
  });

  it('shouldRotate returns false when the file is smaller than maxBytes', async () => {
    const log = new DecisionLog(logPath, { maxBytes: 10_000 });
    await log.record({
      action: 'publish.x', storySlug: 's', platform: 'x', reason: '', result: result('x'),
    });
    expect(log.shouldRotate()).toBe(false);
  });

  it('shouldRotate returns true once the file exceeds maxBytes', () => {
    const log = new DecisionLog(logPath, { maxBytes: 10 });
    writeFileSync(logPath, 'x'.repeat(50), 'utf-8');
    expect(log.shouldRotate()).toBe(true);
  });

  it('rotate renames the active file to a timestamped archive and leaves active empty', async () => {
    const log = new DecisionLog(logPath, { maxBytes: 10 });
    await log.record({
      action: 'publish.x', storySlug: 's', platform: 'x', reason: '', result: result('x'),
    });
    const sizeBefore = statSync(logPath).size;
    const info = log.rotate();
    expect(info.rotatedTo).toMatch(/decisions-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.jsonl$/);
    expect(info.bytes).toBe(sizeBefore);
    expect(existsSync(info.rotatedTo)).toBe(true);
    expect(existsSync(logPath)).toBe(false);
    const archives = readdirSync(dir).filter(f => f !== 'decisions.jsonl');
    expect(archives.length).toBe(1);
  });

  it('rotate is a no-op when the active file is missing', () => {
    const log = new DecisionLog(logPath, { maxBytes: 10 });
    const info = log.rotate();
    expect(info.rotatedTo).toBe('');
    expect(info.bytes).toBe(0);
  });

  it('record triggers automatic rotation when the file exceeds maxBytes', async () => {
    const log = new DecisionLog(logPath, { maxBytes: 50 });
    writeFileSync(logPath, 'x'.repeat(100), 'utf-8');
    await log.record({
      action: 'publish.x', storySlug: 's', platform: 'x', reason: '', result: result('x'),
    });
    // The active file now contains just the new entry; the old content went to an archive.
    const active = readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean);
    expect(active).toHaveLength(1);
    const archives = readdirSync(dir).filter(f => f.startsWith('decisions-') && f.endsWith('.jsonl'));
    expect(archives.length).toBe(1);
    const archived = readFileSync(join(dir, archives[0]!), 'utf-8');
    expect(archived.length).toBeGreaterThanOrEqual(100);
  });

  it('list() only reads the active file, not rotated archives', async () => {
    const archive = join(dir, 'decisions-2020-01-01T00-00-00.jsonl');
    writeFileSync(archive,
      JSON.stringify({
        id: 'old', createdAt: '2020-01-01T00:00:00Z',
        action: 'publish.x', storySlug: 'old-slug', platform: 'x', reason: '',
        result: result('x'),
      }) + '\n',
      'utf-8',
    );
    const log = new DecisionLog(logPath, { maxBytes: 10_000 });
    await log.record({
      action: 'publish.x', storySlug: 'new-slug', platform: 'x', reason: '', result: result('x'),
    });
    const entries = log.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.storySlug).toBe('new-slug');
  });

  it('listArchives returns metadata for each rotated file, sorted newest-first', () => {
    const older = join(dir, 'decisions-2020-01-01T00-00-00.jsonl');
    const newer = join(dir, 'decisions-2021-02-03T04-05-06.jsonl');
    writeFileSync(older,
      JSON.stringify({
        id: 'a', createdAt: '2020-01-01T00:00:00.000Z',
        action: 'publish.x', storySlug: 's', platform: 'x', reason: '', result: result('x'),
      }) + '\n' +
      JSON.stringify({
        id: 'b', createdAt: '2020-01-02T00:00:00.000Z',
        action: 'publish.x', storySlug: 's', platform: 'x', reason: '', result: result('x'),
      }) + '\n',
      'utf-8',
    );
    writeFileSync(newer,
      JSON.stringify({
        id: 'c', createdAt: '2021-02-03T04:05:06.000Z',
        action: 'publish.x', storySlug: 's', platform: 'x', reason: '', result: result('x'),
      }) + '\n',
      'utf-8',
    );
    const log = new DecisionLog(logPath);
    const archives = log.listArchives();
    expect(archives).toHaveLength(2);
    expect(archives[0]!.path).toBe(newer);
    expect(archives[1]!.path).toBe(older);
    expect(archives[0]!.sizeBytes).toBeGreaterThan(0);
    expect(archives[1]!.earliestTs).toBe('2020-01-01T00:00:00.000Z');
    expect(archives[1]!.latestTs).toBe('2020-01-02T00:00:00.000Z');
  });

  it('listArchives returns an empty array when no archives exist', () => {
    const log = new DecisionLog(logPath);
    expect(log.listArchives()).toEqual([]);
  });
});
