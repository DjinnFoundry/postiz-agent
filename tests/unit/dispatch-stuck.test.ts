import { describe, expect, it } from 'vitest';
import { findStuckSlugs, selectNextStory, type DispatchCandidate } from '../../src/dispatch.js';
import type { DecisionLogEntry, Platform } from '../../src/types.js';

const NOW = new Date('2026-04-22T12:00:00Z');

function failAt(hoursAgo: number, errorClass: DecisionLogEntry['result']['errorClass'], platform: Platform = 'tiktok', slug = 'dragon'): DecisionLogEntry {
  return {
    id: `${slug}-${platform}-${hoursAgo}-${errorClass}`,
    action: `publish.${platform}`,
    storySlug: slug,
    platform,
    reason: 'test',
    createdAt: new Date(NOW.getTime() - hoursAgo * 3600_000).toISOString(),
    result: {
      platform,
      success: false,
      error: 'boom',
      errorClass,
      timestamp: new Date(NOW.getTime() - hoursAgo * 3600_000).toISOString(),
    },
  };
}

function resetAt(hoursAgo: number, platform: Platform = 'tiktok', slug = 'dragon'): DecisionLogEntry {
  return {
    id: `reset-${slug}-${platform}-${hoursAgo}`,
    action: `reset-attempts.${platform}`,
    storySlug: slug,
    platform,
    reason: 'manual reset',
    createdAt: new Date(NOW.getTime() - hoursAgo * 3600_000).toISOString(),
    result: {
      platform,
      success: true,
      skipped: true,
      reason: 'reset-attempts',
      timestamp: new Date(NOW.getTime() - hoursAgo * 3600_000).toISOString(),
    },
  };
}

describe('findStuckSlugs', () => {
  const platforms: Platform[] = ['tiktok', 'instagram'];

  it('returns empty when no failures', () => {
    expect(findStuckSlugs([], platforms, NOW)).toEqual([]);
  });

  it('does not mark a slug stuck with 2 permanent failures', () => {
    const log = [failAt(10, 'permanent'), failAt(5, 'permanent')];
    expect(findStuckSlugs(log, platforms, NOW)).toEqual([]);
  });

  it('marks a slug stuck with 3 permanent failures in 72h', () => {
    const log = [failAt(50, 'permanent'), failAt(20, 'permanent'), failAt(2, 'permanent')];
    const stuck = findStuckSlugs(log, platforms, NOW);
    expect(stuck).toHaveLength(1);
    expect(stuck[0].reason).toBe('too-many-permanent-failures');
    expect(stuck[0].permanentCount).toBe(3);
  });

  it('ignores failures older than 72h', () => {
    const log = [failAt(100, 'permanent'), failAt(90, 'permanent'), failAt(80, 'permanent')];
    expect(findStuckSlugs(log, platforms, NOW)).toEqual([]);
  });

  it('treats needs-config, needs-human, unknown as permanent for counting', () => {
    const log = [failAt(10, 'needs-config'), failAt(5, 'needs-human'), failAt(1, 'unknown')];
    const stuck = findStuckSlugs(log, platforms, NOW);
    expect(stuck).toHaveLength(1);
    expect(stuck[0].reason).toBe('too-many-permanent-failures');
  });

  it('applies transient backoff: single recent transient → stuck until 1h elapsed', () => {
    const log = [failAt(0.5, 'transient')]; // 30 minutes ago
    const stuck = findStuckSlugs(log, platforms, NOW);
    expect(stuck).toHaveLength(1);
    expect(stuck[0].reason).toBe('within-transient-backoff');
    expect(stuck[0].nextEligibleAt).toBeDefined();
  });

  it('transient backoff grows with consecutive failures (4h after 2nd)', () => {
    const log = [failAt(5, 'transient'), failAt(2, 'transient')];
    const stuck = findStuckSlugs(log, platforms, NOW);
    expect(stuck).toHaveLength(1);
    expect(stuck[0].reason).toBe('within-transient-backoff');
  });

  it('transient backoff expires after the ladder step', () => {
    const log = [failAt(2, 'transient')]; // 2 hours ago, 1h backoff → eligible again
    expect(findStuckSlugs(log, platforms, NOW)).toEqual([]);
  });

  it('reset-attempts marker clears prior failures for that (slug, platform)', () => {
    const log = [
      failAt(50, 'permanent'),
      failAt(20, 'permanent'),
      failAt(10, 'permanent'),
      resetAt(5), // reset 5h ago
    ];
    expect(findStuckSlugs(log, platforms, NOW)).toEqual([]);
  });

  it('reset only affects failures before the reset timestamp', () => {
    const log = [
      failAt(50, 'permanent'),
      failAt(20, 'permanent'),
      failAt(10, 'permanent'),
      resetAt(8),
      failAt(5, 'permanent'),
      failAt(3, 'permanent'),
      failAt(1, 'permanent'),
    ];
    const stuck = findStuckSlugs(log, platforms, NOW);
    expect(stuck).toHaveLength(1);
    expect(stuck[0].permanentCount).toBe(3);
  });

  it('reset is scoped to platform', () => {
    const log = [
      failAt(20, 'permanent', 'tiktok'),
      failAt(10, 'permanent', 'tiktok'),
      failAt(5, 'permanent', 'tiktok'),
      resetAt(1, 'instagram'), // reset instagram, not tiktok
    ];
    const stuck = findStuckSlugs(log, platforms, NOW);
    expect(stuck).toHaveLength(1);
    expect(stuck[0].platform).toBe('tiktok');
  });
});

describe('selectNextStory with stuck filter', () => {
  const platforms: Platform[] = ['tiktok', 'instagram'];

  const cand = (slug: string, hoursAgo: number): DispatchCandidate => ({
    slug,
    generatedAtMs: NOW.getTime() - hoursAgo * 3600_000,
  });

  it('skips a candidate whose only pending platforms are all stuck', () => {
    const log = [
      failAt(50, 'permanent', 'tiktok', 'dragon'),
      failAt(20, 'permanent', 'tiktok', 'dragon'),
      failAt(5, 'permanent', 'tiktok', 'dragon'),
      failAt(48, 'permanent', 'instagram', 'dragon'),
      failAt(24, 'permanent', 'instagram', 'dragon'),
      failAt(2, 'permanent', 'instagram', 'dragon'),
    ];
    const candidates = [cand('dragon', 10), cand('unicorn', 20)];
    expect(selectNextStory(candidates, log, platforms, NOW)).toBe('unicorn');
  });

  it('still picks a candidate when at least one requested platform is NOT stuck', () => {
    const log = [
      failAt(20, 'permanent', 'tiktok', 'dragon'),
      failAt(10, 'permanent', 'tiktok', 'dragon'),
      failAt(2, 'permanent', 'tiktok', 'dragon'),
      // instagram is clean for dragon
    ];
    const candidates = [cand('dragon', 5)];
    expect(selectNextStory(candidates, log, platforms, NOW)).toBe('dragon');
  });
});
