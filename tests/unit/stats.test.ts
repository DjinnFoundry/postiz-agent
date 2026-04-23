import { describe, expect, it } from 'vitest';
import { runStats } from '../../src/cli/stats.js';
import type { DecisionLogEntry, Platform, PublishResult } from '../../src/types.js';

const NOW = new Date('2026-04-22T12:00:00Z');

function entry(opts: {
  slug: string;
  platform: Platform;
  hoursAgo: number;
  success: boolean;
  skipped?: boolean;
  errorClass?: PublishResult['errorClass'];
  remediationAction?: string;
  ctaVariant?: string;
  action?: string;
}): DecisionLogEntry {
  const ts = new Date(NOW.getTime() - opts.hoursAgo * 3600_000).toISOString();
  return {
    id: `${opts.slug}-${opts.platform}-${opts.hoursAgo}`,
    action: opts.action ?? `publish.${opts.platform}`,
    storySlug: opts.slug,
    platform: opts.platform,
    reason: 'test',
    createdAt: ts,
    result: {
      platform: opts.platform,
      success: opts.success,
      skipped: opts.skipped,
      errorClass: opts.errorClass,
      remediation: opts.remediationAction
        ? { action: opts.remediationAction, humanHint: 'hint' }
        : undefined,
      ctaVariant: opts.ctaVariant,
      timestamp: ts,
    },
  };
}

describe('runStats', () => {
  it('computes totals and per-platform breakdown within the window', async () => {
    const decisions: DecisionLogEntry[] = [
      entry({ slug: 'a', platform: 'x', hoursAgo: 1, success: true }),
      entry({ slug: 'b', platform: 'x', hoursAgo: 2, success: false, errorClass: 'permanent', remediationAction: 'manual-review' }),
      entry({ slug: 'c', platform: 'tiktok', hoursAgo: 3, success: true }),
      entry({ slug: 'd', platform: 'tiktok', hoursAgo: 4, success: true, skipped: true }),
      // Older than 7 days: should be excluded when days=7
      entry({ slug: 'old', platform: 'x', hoursAgo: 24 * 9, success: true }),
    ];
    const report = await runStats({
      now: NOW,
      decisions,
      days: 7,
    });
    expect(report.windowDays).toBe(7);
    expect(report.totals.success).toBe(2);
    expect(report.totals.failed).toBe(1);
    expect(report.totals.skipped).toBe(1);
    expect(report.totals.total).toBe(4);

    const x = report.byPlatform.x!;
    expect(x.success).toBe(1);
    expect(x.failed).toBe(1);
    expect(x.successRate).toBeCloseTo(0.5, 2);

    const tiktok = report.byPlatform.tiktok!;
    expect(tiktok.success).toBe(1);
    expect(tiktok.skipped).toBe(1);
    expect(tiktok.successRate).toBe(1);
  });

  it('filters by platform when requested', async () => {
    const decisions: DecisionLogEntry[] = [
      entry({ slug: 'a', platform: 'x', hoursAgo: 1, success: true }),
      entry({ slug: 'b', platform: 'tiktok', hoursAgo: 2, success: true }),
    ];
    const report = await runStats({
      now: NOW,
      decisions,
      days: 30,
      platform: 'x',
    });
    expect(report.totals.total).toBe(1);
    expect(Object.keys(report.byPlatform)).toEqual(['x']);
  });

  it('returns top remediations by count (up to 5)', async () => {
    const decisions: DecisionLogEntry[] = [
      entry({ slug: 'a', platform: 'x', hoursAgo: 1, success: false, errorClass: 'permanent', remediationAction: 'manual-review' }),
      entry({ slug: 'b', platform: 'x', hoursAgo: 2, success: false, errorClass: 'permanent', remediationAction: 'manual-review' }),
      entry({ slug: 'c', platform: 'tiktok', hoursAgo: 3, success: false, errorClass: 'needs-config', remediationAction: 'reconnect-integration' }),
      entry({ slug: 'd', platform: 'tiktok', hoursAgo: 4, success: false, errorClass: 'transient', remediationAction: 'retry' }),
    ];
    const report = await runStats({ now: NOW, decisions, days: 30 });
    expect(report.topRemediations[0]).toEqual({ action: 'manual-review', count: 2 });
    expect(report.topRemediations.map(r => r.action)).toEqual(
      expect.arrayContaining(['manual-review', 'reconnect-integration', 'retry']),
    );
    expect(report.topRemediations.length).toBeLessThanOrEqual(5);
  });

  it('reports top 3 stuck slugs', async () => {
    const decisions: DecisionLogEntry[] = [
      entry({ slug: 'dragon', platform: 'tiktok', hoursAgo: 50, success: false, errorClass: 'permanent' }),
      entry({ slug: 'dragon', platform: 'tiktok', hoursAgo: 20, success: false, errorClass: 'permanent' }),
      entry({ slug: 'dragon', platform: 'tiktok', hoursAgo: 2, success: false, errorClass: 'permanent' }),
    ];
    const report = await runStats({ now: NOW, decisions, days: 30 });
    expect(report.topStuck.length).toBeGreaterThan(0);
    expect(report.topStuck[0].slug).toBe('dragon');
    expect(report.topStuck[0].platform).toBe('tiktok');
    expect(report.topStuck.length).toBeLessThanOrEqual(3);
  });

  it('aggregates CTA variant distribution per platform', async () => {
    const decisions: DecisionLogEntry[] = [
      entry({ slug: 'a', platform: 'x', hoursAgo: 1, success: true, ctaVariant: 'follow-a' }),
      entry({ slug: 'b', platform: 'x', hoursAgo: 2, success: true, ctaVariant: 'follow-a' }),
      entry({ slug: 'c', platform: 'x', hoursAgo: 3, success: true, ctaVariant: 'share-b' }),
      entry({ slug: 'd', platform: 'tiktok', hoursAgo: 4, success: true, ctaVariant: 'follow-c' }),
    ];
    const report = await runStats({ now: NOW, decisions, days: 30 });
    expect(report.ctaVariants.x!['follow-a']).toBe(2);
    expect(report.ctaVariants.x!['share-b']).toBe(1);
    expect(report.ctaVariants.tiktok!['follow-c']).toBe(1);
  });

  it('ignores action entries that are not publish.* when computing totals', async () => {
    const decisions: DecisionLogEntry[] = [
      entry({ slug: 'a', platform: 'x', hoursAgo: 1, success: true }),
      // reset-attempts markers should NOT inflate totals
      entry({
        slug: 'dragon',
        platform: 'tiktok',
        hoursAgo: 1,
        success: true,
        skipped: true,
        action: 'reset-attempts.tiktok',
      }),
    ];
    const report = await runStats({ now: NOW, decisions, days: 30 });
    expect(report.totals.total).toBe(1);
  });

  it('handles empty log gracefully', async () => {
    const report = await runStats({ now: NOW, decisions: [], days: 30 });
    expect(report.totals.total).toBe(0);
    expect(report.topRemediations).toEqual([]);
    expect(report.topStuck).toEqual([]);
    expect(Object.keys(report.byPlatform)).toHaveLength(0);
  });
});
