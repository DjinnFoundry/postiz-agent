import { DecisionLog } from '../decisions/log.js';
import { findStuckSlugs, type StuckSlugInfo } from '../dispatch.js';
import type { DecisionLogEntry, Platform } from '../types.js';
import { filterPublishes, filterWindow, windowFromMs } from './decisions-window.js';

export interface StatsCounts {
  success: number;
  failed: number;
  skipped: number;
  total: number;
  successRate: number;
}

export interface CtaVariantStats {
  success: number;
  failed: number;
  successRate: number;
}

export interface StatsReport {
  generatedAt: string;
  windowDays: number;
  from: string;
  to: string;
  platformFilter?: Platform;
  totals: StatsCounts;
  byPlatform: Partial<Record<Platform, StatsCounts>>;
  topRemediations: Array<{ action: string; count: number }>;
  topStuck: StuckSlugInfo[];
  // Breaking change vs v0.1: previously `Record<variantId, number>` (count only).
  // Now carries success/failed/rate so operators can spot a variant that correlates
  // with platform rejections (e.g. a CTA that pushes captions over length limits).
  ctaVariants: Partial<Record<Platform, Record<string, CtaVariantStats>>>;
}

export interface StatsInput {
  now?: Date;
  decisions?: DecisionLogEntry[];
  days?: number;
  platform?: Platform;
}

const ALL_PLATFORMS: Platform[] = ['x', 'tiktok', 'instagram', 'youtube', 'spotify'];

// Only `publish.*` entries feed totals and CTA variants so housekeeping markers
// (reset-attempts.*) cannot inflate them.
export async function runStats(input: StatsInput = {}): Promise<StatsReport> {
  const now = input.now ?? new Date();
  const days = input.days ?? 30;
  const decisions = input.decisions ?? new DecisionLog().list();
  const platformFilter = input.platform;

  const fromMs = windowFromMs({ now, days });
  const windowed = filterWindow(decisions, { now, days, platform: platformFilter });
  const publishes = filterPublishes(windowed);

  const totals = emptyCounts();
  const byPlatform: Partial<Record<Platform, StatsCounts>> = {};
  const ctaVariants: Partial<Record<Platform, Record<string, CtaVariantStats>>> = {};
  const remediationCounts = new Map<string, number>();

  for (const entry of publishes) {
    const pc = byPlatform[entry.platform] ?? emptyCounts();
    tally(pc, entry);
    byPlatform[entry.platform] = pc;
    tally(totals, entry);

    const variant = entry.result?.ctaVariant;
    // Skipped attempts never hit the platform; counting them would dilute the rate
    // and mask the failure-correlation signal this report exists to surface.
    if (variant && !entry.result?.skipped) {
      const bucket = ctaVariants[entry.platform] ?? {};
      const slot = bucket[variant] ?? { success: 0, failed: 0, successRate: 0 };
      if (entry.result?.success) slot.success += 1;
      else slot.failed += 1;
      bucket[variant] = slot;
      ctaVariants[entry.platform] = bucket;
    }

    const action = entry.result?.remediation?.action;
    if (action && !entry.result?.success) {
      remediationCounts.set(action, (remediationCounts.get(action) ?? 0) + 1);
    }
  }

  finalizeRate(totals);
  for (const p of Object.keys(byPlatform) as Platform[]) finalizeRate(byPlatform[p]!);
  for (const p of Object.keys(ctaVariants) as Platform[]) {
    const bucket = ctaVariants[p]!;
    for (const id of Object.keys(bucket)) {
      const s = bucket[id];
      const denom = s.success + s.failed;
      s.successRate = denom === 0 ? 0 : s.success / denom;
    }
  }

  const topRemediations = [...remediationCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([action, count]) => ({ action, count }));

  const platformsForStuck: Platform[] = platformFilter ? [platformFilter] : ALL_PLATFORMS;
  const topStuck = findStuckSlugs(decisions, platformsForStuck, now).slice(0, 3);

  return {
    generatedAt: now.toISOString(),
    windowDays: days,
    from: new Date(fromMs).toISOString(),
    to: now.toISOString(),
    platformFilter,
    totals,
    byPlatform,
    topRemediations,
    topStuck,
    ctaVariants,
  };
}

function emptyCounts(): StatsCounts {
  return { success: 0, failed: 0, skipped: 0, total: 0, successRate: 0 };
}

function tally(bucket: StatsCounts, entry: DecisionLogEntry): void {
  bucket.total += 1;
  const r = entry.result;
  if (r?.skipped) bucket.skipped += 1;
  else if (r?.success) bucket.success += 1;
  else bucket.failed += 1;
}

function finalizeRate(bucket: StatsCounts): void {
  // Skipped is excluded so the rate reflects real attempts, not idempotency short-circuits.
  const denom = bucket.success + bucket.failed;
  bucket.successRate = denom === 0 ? 0 : bucket.success / denom;
}

// No colors so cron mail stays readable.
export function formatStatsReport(report: StatsReport): string {
  const out: string[] = [];
  out.push(`── stats (last ${report.windowDays} days${report.platformFilter ? `, platform=${report.platformFilter}` : ''}) ──`);
  out.push(`  total:    ${report.totals.total}`);
  out.push(`  success:  ${report.totals.success}`);
  out.push(`  failed:   ${report.totals.failed}`);
  out.push(`  skipped:  ${report.totals.skipped}`);
  out.push(`  rate:     ${(report.totals.successRate * 100).toFixed(1)}%`);
  out.push('');

  out.push('── by platform ──');
  const platforms = Object.keys(report.byPlatform) as Platform[];
  platforms.sort();
  for (const p of platforms) {
    const c = report.byPlatform[p]!;
    out.push(`  ${p.padEnd(10)} total=${c.total} success=${c.success} failed=${c.failed} skipped=${c.skipped} rate=${(c.successRate * 100).toFixed(1)}%`);
  }
  out.push('');

  out.push('── top remediations ──');
  if (report.topRemediations.length === 0) {
    out.push('  (none)');
  } else {
    for (const r of report.topRemediations) {
      out.push(`  ${r.count.toString().padStart(4)} · ${r.action}`);
    }
  }
  out.push('');

  out.push('── top stuck slugs ──');
  if (report.topStuck.length === 0) {
    out.push('  (none)');
  } else {
    for (const s of report.topStuck) {
      out.push(`  ${s.slug} · ${s.platform} · ${s.reason}`);
    }
  }
  out.push('');

  out.push('── cta variants (success / failed · rate) ──');
  const ctaPlatforms = Object.keys(report.ctaVariants) as Platform[];
  if (ctaPlatforms.length === 0) {
    out.push('  (none)');
  } else {
    for (const p of ctaPlatforms.sort()) {
      const variants = report.ctaVariants[p]!;
      // Sort by volume first, then by lowest success rate so a correlated-failure
      // variant bubbles up visually even if it has fewer samples than the winners.
      const entries = Object.entries(variants).sort((a, b) => {
        const usesA = a[1].success + a[1].failed;
        const usesB = b[1].success + b[1].failed;
        if (usesB !== usesA) return usesB - usesA;
        return a[1].successRate - b[1].successRate;
      });
      out.push(`  ${p}:`);
      for (const [id, s] of entries) {
        const rate = `${(s.successRate * 100).toFixed(1)}%`;
        out.push(`    ${s.success.toString().padStart(3)} / ${s.failed.toString().padStart(3)} · ${rate.padStart(6)} · ${id}`);
      }
    }
  }
  return out.join('\n');
}
