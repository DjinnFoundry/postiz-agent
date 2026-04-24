import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCtaAb, formatCtaAbReport } from '../../src/cli/cta-ab.js';
import type { DecisionLogEntry, Platform, PublishResult } from '../../src/types.js';

const NOW = new Date('2026-04-22T12:00:00Z');

function entry(opts: {
  slug: string;
  platform: Platform;
  hoursAgo: number;
  success: boolean;
  skipped?: boolean;
  ctaVariant?: string;
  postId?: string;
  url?: string;
  errorClass?: PublishResult['errorClass'];
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
      ctaVariant: opts.ctaVariant,
      postId: opts.postId,
      url: opts.url,
      errorClass: opts.errorClass,
      timestamp: ts,
    },
  };
}

describe('runCtaAb', () => {
  it('reports variants per platform with uses, success/failed, rate and sample urls', async () => {
    const decisions: DecisionLogEntry[] = [
      entry({ slug: 's1', platform: 'instagram', hoursAgo: 1, success: true, ctaVariant: 'ig-bio', url: 'https://ig/1' }),
      entry({ slug: 's2', platform: 'instagram', hoursAgo: 2, success: true, ctaVariant: 'ig-bio', url: 'https://ig/2' }),
      entry({ slug: 's3', platform: 'instagram', hoursAgo: 3, success: true, ctaVariant: 'ig-bio', url: 'https://ig/3' }),
      entry({ slug: 's4', platform: 'instagram', hoursAgo: 4, success: true, ctaVariant: 'ig-bio', url: 'https://ig/4' }),
      entry({ slug: 's5', platform: 'instagram', hoursAgo: 5, success: false, ctaVariant: 'ig-made', errorClass: 'permanent' }),
      entry({ slug: 's6', platform: 'instagram', hoursAgo: 6, success: true, ctaVariant: 'ig-made', url: 'https://ig/6' }),
    ];
    const report = await runCtaAb({ now: NOW, decisions, days: 30 });

    expect(report.windowDays).toBe(30);
    expect(report.platforms.instagram).toBeDefined();
    const ig = report.platforms.instagram!;
    const bio = ig.variants.find(v => v.id === 'ig-bio')!;
    expect(bio.uses).toBe(4);
    expect(bio.success).toBe(4);
    expect(bio.failed).toBe(0);
    expect(bio.successRate).toBe(1);
    expect(bio.sampleUrls.length).toBe(3);
    expect(bio.sampleUrls[0]).toBe('https://ig/1');
    expect(bio.text).toBeTruthy();

    const made = ig.variants.find(v => v.id === 'ig-made')!;
    expect(made.uses).toBe(2);
    expect(made.success).toBe(1);
    expect(made.failed).toBe(1);
    expect(made.successRate).toBeCloseTo(0.5, 3);
  });

  it('counts publishes without ctaVariant as unknownCount per platform', async () => {
    const decisions: DecisionLogEntry[] = [
      entry({ slug: 's1', platform: 'x', hoursAgo: 1, success: true, ctaVariant: 'x-try' }),
      entry({ slug: 's2', platform: 'x', hoursAgo: 2, success: true }),
      entry({ slug: 's3', platform: 'x', hoursAgo: 3, success: false, errorClass: 'permanent' }),
    ];
    const report = await runCtaAb({ now: NOW, decisions, days: 30 });
    const x = report.platforms.x!;
    expect(x.unknownCount).toBe(2);
    expect(x.variants.find(v => v.id === 'x-try')!.uses).toBe(1);
  });

  it('filters by platform when requested', async () => {
    const decisions: DecisionLogEntry[] = [
      entry({ slug: 'a', platform: 'x', hoursAgo: 1, success: true, ctaVariant: 'x-try' }),
      entry({ slug: 'b', platform: 'tiktok', hoursAgo: 2, success: true, ctaVariant: 'tk-ask' }),
    ];
    const report = await runCtaAb({ now: NOW, decisions, days: 30, platform: 'x' });
    expect(report.platformFilter).toBe('x');
    expect(Object.keys(report.platforms)).toEqual(['x']);
  });

  it('respects the window (days) filter', async () => {
    const decisions: DecisionLogEntry[] = [
      entry({ slug: 'fresh', platform: 'x', hoursAgo: 1, success: true, ctaVariant: 'x-try' }),
      entry({ slug: 'old', platform: 'x', hoursAgo: 24 * 40, success: true, ctaVariant: 'x-try' }),
    ];
    const report = await runCtaAb({ now: NOW, decisions, days: 7 });
    const x = report.platforms.x!;
    const xTry = x.variants.find(v => v.id === 'x-try')!;
    expect(xTry.uses).toBe(1);
  });

  it('ignores non-publish.* actions', async () => {
    const decisions: DecisionLogEntry[] = [
      entry({ slug: 'a', platform: 'x', hoursAgo: 1, success: true, ctaVariant: 'x-try' }),
      entry({
        slug: 'dragon',
        platform: 'x',
        hoursAgo: 1,
        success: true,
        skipped: true,
        action: 'reset-attempts.x',
      }),
    ];
    const report = await runCtaAb({ now: NOW, decisions, days: 30 });
    expect(report.platforms.x!.variants.find(v => v.id === 'x-try')!.uses).toBe(1);
    expect(report.platforms.x!.unknownCount).toBe(0);
  });

  it('skipped publishes do not count as uses', async () => {
    const decisions: DecisionLogEntry[] = [
      entry({ slug: 'a', platform: 'x', hoursAgo: 1, success: true, skipped: true, ctaVariant: 'x-try' }),
      entry({ slug: 'b', platform: 'x', hoursAgo: 2, success: true, ctaVariant: 'x-try', url: 'https://x/b' }),
    ];
    const report = await runCtaAb({ now: NOW, decisions, days: 30 });
    expect(report.platforms.x!.variants.find(v => v.id === 'x-try')!.uses).toBe(1);
  });

  it('resolves variant text from the CTA catalog when the id is known', async () => {
    const decisions: DecisionLogEntry[] = [
      entry({ slug: 'a', platform: 'x', hoursAgo: 1, success: true, ctaVariant: 'x-try', url: 'https://x/a' }),
    ];
    const report = await runCtaAb({ now: NOW, decisions, days: 30 });
    const v = report.platforms.x!.variants.find(x => x.id === 'x-try')!;
    expect(v.text).toContain('audiokids.app');
  });

  it('falls back to empty string text for unknown variant ids', async () => {
    const decisions: DecisionLogEntry[] = [
      entry({ slug: 'a', platform: 'x', hoursAgo: 1, success: true, ctaVariant: 'never-shipped' }),
    ];
    const report = await runCtaAb({ now: NOW, decisions, days: 30 });
    const v = report.platforms.x!.variants.find(x => x.id === 'never-shipped')!;
    expect(v.text).toBe('');
  });

  it('collects postId in sampleUrls when no url is attached', async () => {
    const decisions: DecisionLogEntry[] = [
      entry({ slug: 'a', platform: 'x', hoursAgo: 1, success: true, ctaVariant: 'x-try', postId: 'abc123' }),
    ];
    const report = await runCtaAb({ now: NOW, decisions, days: 30 });
    const v = report.platforms.x!.variants.find(x => x.id === 'x-try')!;
    expect(v.sampleUrls).toEqual(['abc123']);
  });

  it('handles empty log gracefully', async () => {
    const report = await runCtaAb({ now: NOW, decisions: [], days: 30 });
    expect(Object.keys(report.platforms)).toHaveLength(0);
  });
});

describe('formatCtaAbReport', () => {
  it('renders a human table with rates and sample urls', async () => {
    const decisions: DecisionLogEntry[] = [
      entry({ slug: 's1', platform: 'instagram', hoursAgo: 1, success: true, ctaVariant: 'ig-bio', url: 'https://ig/1' }),
      entry({ slug: 's2', platform: 'instagram', hoursAgo: 2, success: false, ctaVariant: 'ig-bio', errorClass: 'permanent' }),
    ];
    const report = await runCtaAb({ now: NOW, decisions, days: 30 });
    const text = formatCtaAbReport(report);
    expect(text).toContain('instagram');
    expect(text).toContain('ig-bio');
    expect(text).toContain('50.0%');
    expect(text).toContain('https://ig/1');
  });

  it('renders a friendly empty state when no data', async () => {
    const report = await runCtaAb({ now: NOW, decisions: [], days: 30 });
    const text = formatCtaAbReport(report);
    expect(text.toLowerCase()).toContain('none');
  });
});

function writeIngest(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'cta-ab-ingest-'));
  const file = join(dir, 'engagement.jsonl');
  writeFileSync(file, lines.join('\n') + '\n', 'utf-8');
  return file;
}

describe('runCtaAb --ingest', () => {
  it('merges engagement averages into the matching variant', async () => {
    const decisions: DecisionLogEntry[] = [
      entry({ slug: 's1', platform: 'instagram', hoursAgo: 1, success: true, ctaVariant: 'ig-bio', postId: 'p1', url: 'https://ig/1' }),
      entry({ slug: 's2', platform: 'instagram', hoursAgo: 2, success: true, ctaVariant: 'ig-bio', postId: 'p2', url: 'https://ig/2' }),
      entry({ slug: 's3', platform: 'instagram', hoursAgo: 3, success: true, ctaVariant: 'ig-bio', postId: 'p3', url: 'https://ig/3' }),
    ];
    const ingestFile = writeIngest([
      JSON.stringify({ postId: 'p1', platform: 'instagram', engagement: { views: 1000, likes: 30, comments: 2 }, recordedAt: '2026-04-20T10:00:00Z' }),
      JSON.stringify({ postId: 'p2', platform: 'instagram', engagement: { views: 2000, likes: 60, comments: 4 }, recordedAt: '2026-04-20T10:00:00Z' }),
      JSON.stringify({ postId: 'p3', platform: 'instagram', engagement: { views: 3000, likes: 90, comments: 6 }, recordedAt: '2026-04-20T10:00:00Z' }),
    ]);

    const report = await runCtaAb({ now: NOW, decisions, days: 30, ingestFile });
    expect(report.ingestApplied).toBe(true);
    expect(report.ingestFile).toBe(ingestFile);

    const bio = report.platforms.instagram!.variants.find(v => v.id === 'ig-bio')!;
    expect(bio.avgEngagement).toBeDefined();
    expect(bio.avgEngagement!.avgViews).toBe(2000);
    expect(bio.avgEngagement!.avgLikes).toBe(60);
    expect(bio.avgEngagement!.avgComments).toBe(4);
    expect(bio.avgEngagement!.sampleSize).toBe(3);
  });

  it('leaves avgEngagement undefined for variants without matching records', async () => {
    const decisions: DecisionLogEntry[] = [
      entry({ slug: 'a', platform: 'x', hoursAgo: 1, success: true, ctaVariant: 'x-try', postId: 'a1' }),
    ];
    const ingestFile = writeIngest([
      JSON.stringify({ postId: 'unrelated', platform: 'x', engagement: { views: 100 }, recordedAt: '2026-04-20T10:00:00Z' }),
    ]);
    const report = await runCtaAb({ now: NOW, decisions, days: 30, ingestFile });
    expect(report.ingestApplied).toBe(true);
    const xTry = report.platforms.x!.variants.find(v => v.id === 'x-try')!;
    expect(xTry.avgEngagement).toBeUndefined();
  });

  it('skips ingest records whose postId is not present in the decision log', async () => {
    const decisions: DecisionLogEntry[] = [
      entry({ slug: 'a', platform: 'instagram', hoursAgo: 1, success: true, ctaVariant: 'ig-bio', postId: 'known' }),
    ];
    const ingestFile = writeIngest([
      JSON.stringify({ postId: 'known', platform: 'instagram', engagement: { views: 1000, likes: 10 }, recordedAt: '2026-04-20T10:00:00Z' }),
      JSON.stringify({ postId: 'ghost', platform: 'instagram', engagement: { views: 9999, likes: 9999 }, recordedAt: '2026-04-20T10:00:00Z' }),
    ]);
    const warnings: string[] = [];
    const warnSpy = (msg: unknown) => { warnings.push(String(msg)); };
    const originalWarn = console.warn;
    console.warn = warnSpy;
    try {
      const report = await runCtaAb({ now: NOW, decisions, days: 30, ingestFile });
      const bio = report.platforms.instagram!.variants.find(v => v.id === 'ig-bio')!;
      expect(bio.avgEngagement!.sampleSize).toBe(1);
      expect(bio.avgEngagement!.avgViews).toBe(1000);
      expect(warnings.some(w => w.includes('ghost'))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  it('skips malformed JSONL lines and processes the rest', async () => {
    const decisions: DecisionLogEntry[] = [
      entry({ slug: 'a', platform: 'instagram', hoursAgo: 1, success: true, ctaVariant: 'ig-bio', postId: 'p1' }),
    ];
    const ingestFile = writeIngest([
      '{not valid json',
      JSON.stringify({ postId: 'p1', platform: 'instagram', engagement: { views: 500, likes: 20 }, recordedAt: '2026-04-20T10:00:00Z' }),
      '',
    ]);
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: unknown) => { warnings.push(String(msg)); };
    try {
      const report = await runCtaAb({ now: NOW, decisions, days: 30, ingestFile });
      const bio = report.platforms.instagram!.variants.find(v => v.id === 'ig-bio')!;
      expect(bio.avgEngagement!.sampleSize).toBe(1);
      expect(bio.avgEngagement!.avgViews).toBe(500);
      expect(warnings.some(w => w.toLowerCase().includes('malformed') || w.toLowerCase().includes('invalid'))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  it('treats missing engagement keys as 0 for that metric in the average', async () => {
    const decisions: DecisionLogEntry[] = [
      entry({ slug: 's1', platform: 'instagram', hoursAgo: 1, success: true, ctaVariant: 'ig-bio', postId: 'p1' }),
      entry({ slug: 's2', platform: 'instagram', hoursAgo: 2, success: true, ctaVariant: 'ig-bio', postId: 'p2' }),
    ];
    const ingestFile = writeIngest([
      JSON.stringify({ postId: 'p1', platform: 'instagram', engagement: { views: 1000, likes: 40 }, recordedAt: '2026-04-20T10:00:00Z' }),
      JSON.stringify({ postId: 'p2', platform: 'instagram', engagement: {}, recordedAt: '2026-04-20T10:00:00Z' }),
    ]);
    const report = await runCtaAb({ now: NOW, decisions, days: 30, ingestFile });
    const bio = report.platforms.instagram!.variants.find(v => v.id === 'ig-bio')!;
    expect(bio.avgEngagement!.sampleSize).toBe(2);
    expect(bio.avgEngagement!.avgViews).toBe(500);
    expect(bio.avgEngagement!.avgLikes).toBe(20);
    expect(bio.avgEngagement!.avgComments).toBe(0);
  });

  it('formatCtaAbReport renders engagement line when avgEngagement is present', async () => {
    const decisions: DecisionLogEntry[] = [
      entry({ slug: 's1', platform: 'instagram', hoursAgo: 1, success: true, ctaVariant: 'ig-bio', postId: 'p1', url: 'https://ig/1' }),
    ];
    const ingestFile = writeIngest([
      JSON.stringify({ postId: 'p1', platform: 'instagram', engagement: { views: 1200, likes: 45, comments: 3 }, recordedAt: '2026-04-20T10:00:00Z' }),
    ]);
    const report = await runCtaAb({ now: NOW, decisions, days: 30, ingestFile });
    const text = formatCtaAbReport(report);
    expect(text).toContain('1200');
    expect(text).toContain('45');
    expect(text).toContain('n=1');
  });
});
