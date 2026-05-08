import { describe, expect, it } from 'vitest';
import { selectNextContent, type DispatchCandidate } from '../../src/dispatch.js';
import type { DecisionLogEntry, Platform } from '../../src/types.js';

const NOW = new Date('2026-04-16T12:00:00Z');

function mkLog(over: Partial<DecisionLogEntry>): DecisionLogEntry {
  return {
    id: Math.random().toString(36).slice(2),
    action: 'publish.tiktok',
    contentSlug: 'dragon',
    platform: 'tiktok',
    reason: 'test',
    createdAt: new Date(NOW.getTime() - 60_000).toISOString(),
    result: {
      platform: 'tiktok',
      success: true,
      timestamp: new Date().toISOString(),
    },
    ...over,
  };
}

const cand = (slug: string, hoursAgo: number): DispatchCandidate => ({
  slug,
  generatedAtMs: NOW.getTime() - hoursAgo * 3600_000,
});

describe('selectNextContent()', () => {
  const platforms: Platform[] = ['tiktok', 'instagram'];

  it('returns null when no candidates', () => {
    expect(selectNextContent([], [], platforms, NOW)).toBeNull();
  });

  it('returns null when no platforms requested', () => {
    expect(selectNextContent([cand('a', 1)], [], [], NOW)).toBeNull();
  });

  it('returns the only candidate when log is empty', () => {
    expect(selectNextContent([cand('a', 1)], [], platforms, NOW)).toBe('a');
  });

  it('prefers the oldest candidate among pending stories', () => {
    const candidates = [
      cand('new', 1),
      cand('old', 72),
      cand('medium', 24),
    ];
    expect(selectNextContent(candidates, [], platforms, NOW)).toBe('old');
  });

  it('skips a story that is fully published to all targets', () => {
    const candidates = [cand('done', 72), cand('pending', 24)];
    const log = [
      mkLog({ contentSlug: 'done', platform: 'tiktok' }),
      mkLog({ contentSlug: 'done', platform: 'instagram' }),
    ];
    expect(selectNextContent(candidates, log, platforms, NOW)).toBe('pending');
  });

  it('still picks a story that has only one platform published', () => {
    const candidates = [cand('half', 24)];
    const log = [mkLog({ contentSlug: 'half', platform: 'tiktok' })];
    expect(selectNextContent(candidates, log, platforms, NOW)).toBe('half');
  });

  it('ignores log entries older than 30 days', () => {
    const candidates = [cand('story', 24)];
    const log = [
      mkLog({
        contentSlug: 'story',
        platform: 'tiktok',
        createdAt: new Date(NOW.getTime() - 31 * 24 * 3600_000).toISOString(),
      }),
      mkLog({
        contentSlug: 'story',
        platform: 'instagram',
        createdAt: new Date(NOW.getTime() - 31 * 24 * 3600_000).toISOString(),
      }),
    ];
    expect(selectNextContent(candidates, log, platforms, NOW)).toBe('story');
  });

  it('ignores failed log entries', () => {
    const candidates = [cand('story', 24)];
    const log = [
      mkLog({
        contentSlug: 'story',
        platform: 'tiktok',
        result: { platform: 'tiktok', success: false, error: 'boom', timestamp: new Date().toISOString() },
      }),
    ];
    expect(selectNextContent(candidates, log, platforms, NOW)).toBe('story');
  });

  it('returns null when every candidate is fully published to every platform', () => {
    const candidates = [cand('a', 48), cand('b', 12)];
    const log = [
      mkLog({ contentSlug: 'a', platform: 'tiktok' }),
      mkLog({ contentSlug: 'a', platform: 'instagram' }),
      mkLog({ contentSlug: 'b', platform: 'tiktok' }),
      mkLog({ contentSlug: 'b', platform: 'instagram' }),
    ];
    expect(selectNextContent(candidates, log, platforms, NOW)).toBeNull();
  });
});
