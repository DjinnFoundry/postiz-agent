import { describe, expect, it } from 'vitest';
import { wasRecentlyPublished } from '../../src/idempotency.js';
import type { DecisionLogEntry } from '../../src/types.js';

function mkEntry(over: Partial<DecisionLogEntry>): DecisionLogEntry {
  return {
    id: 'id',
    action: 'publish.tiktok',
    contentSlug: 'dragon-marcos',
    platform: 'tiktok',
    reason: 'test',
    createdAt: new Date().toISOString(),
    result: {
      platform: 'tiktok',
      success: true,
      timestamp: new Date().toISOString(),
    },
    ...over,
  };
}

const NOW = new Date('2026-04-16T12:00:00Z');

describe('wasRecentlyPublished()', () => {
  it('returns false when no entries', () => {
    const r = wasRecentlyPublished([], 'dragon-marcos', 'tiktok', NOW);
    expect(r.recent).toBe(false);
  });

  it('detects a successful publish within 24h', () => {
    const entries = [
      mkEntry({ createdAt: new Date(NOW.getTime() - 2 * 3600_000).toISOString() }),
    ];
    const r = wasRecentlyPublished(entries, 'dragon-marcos', 'tiktok', NOW);
    expect(r.recent).toBe(true);
    expect(r.entry?.id).toBe('id');
  });

  it('ignores entries older than 24h', () => {
    const entries = [
      mkEntry({ createdAt: new Date(NOW.getTime() - 25 * 3600_000).toISOString() }),
    ];
    expect(wasRecentlyPublished(entries, 'dragon-marcos', 'tiktok', NOW).recent).toBe(false);
  });

  it('ignores failed attempts', () => {
    const entries = [
      mkEntry({
        createdAt: new Date(NOW.getTime() - 1 * 3600_000).toISOString(),
        result: {
          platform: 'tiktok', success: false, error: 'boom',
          timestamp: new Date().toISOString(),
        },
      }),
    ];
    expect(wasRecentlyPublished(entries, 'dragon-marcos', 'tiktok', NOW).recent).toBe(false);
  });

  it('ignores entries from other stories and platforms', () => {
    const entries = [
      mkEntry({ contentSlug: 'other-story' }),
      mkEntry({ platform: 'x' }),
    ];
    expect(wasRecentlyPublished(entries, 'dragon-marcos', 'tiktok', NOW).recent).toBe(false);
  });

  it('ignores prior skipped entries (avoid double-skip loops)', () => {
    const entries = [
      mkEntry({
        createdAt: new Date(NOW.getTime() - 1 * 3600_000).toISOString(),
        result: {
          platform: 'tiktok', success: true, skipped: true, reason: 'already published today',
          timestamp: new Date().toISOString(),
        },
      }),
    ];
    expect(wasRecentlyPublished(entries, 'dragon-marcos', 'tiktok', NOW).recent).toBe(false);
  });

  it('honours a custom window', () => {
    const entries = [
      mkEntry({ createdAt: new Date(NOW.getTime() - 90 * 60_000).toISOString() }),
    ];
    // 1-hour window: this entry is 1.5h old → false
    expect(wasRecentlyPublished(entries, 'dragon-marcos', 'tiktok', NOW, 60 * 60_000).recent).toBe(false);
    // 3-hour window: true
    expect(wasRecentlyPublished(entries, 'dragon-marcos', 'tiktok', NOW, 3 * 60 * 60_000).recent).toBe(true);
  });
});
