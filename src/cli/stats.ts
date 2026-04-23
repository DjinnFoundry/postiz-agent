import { DecisionLog } from '../decisions/log.js';
import { findStuckSlugs, type StuckSlugInfo } from '../dispatch.js';
import type { DecisionLogEntry, Platform } from '../types.js';

export interface StatsCounts {
  success: number;
  failed: number;
  skipped: number;
  total: number;
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
  ctaVariants: Partial<Record<Platform, Record<string, number>>>;
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

  const fromMs = now.getTime() - days * 24 * 3600_000;
  const windowed = decisions.filter(d => {
    const t = Date.parse(d.createdAt);
    if (!Number.isFinite(t)) return false;
    if (t < fromMs) return false;
    if (platformFilter && d.platform !== platformFilter) return false;
    return true;
  });
  const publishes = windowed.filter(d => d.action.startsWith('publish.'));

  const totals = emptyCounts();
  const byPlatform: Partial<Record<Platform, StatsCounts>> = {};
  const ctaVariants: Partial<Record<Platform, Record<string, number>>> = {};
  const remediationCounts = new Map<string, number>();

  for (const entry of publishes) {
    const pc = byPlatform[entry.platform] ?? emptyCounts();
    tally(pc, entry);
    byPlatform[entry.platform] = pc;
    tally(totals, entry);

    const variant = entry.result?.ctaVariant;
    if (entry.result?.success && variant) {
      const bucket = ctaVariants[entry.platform] ?? {};
      bucket[variant] = (bucket[variant] ?? 0) + 1;
      ctaVariants[entry.platform] = bucket;
    }

    const action = entry.result?.remediation?.action;
    if (action && !entry.result?.success) {
      remediationCounts.set(action, (remediationCounts.get(action) ?? 0) + 1);
    }
  }

  finalizeRate(totals);
  for (const p of Object.keys(byPlatform) as Platform[]) finalizeRate(byPlatform[p]!);

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

  out.push('── cta variants ──');
  const ctaPlatforms = Object.keys(report.ctaVariants) as Platform[];
  if (ctaPlatforms.length === 0) {
    out.push('  (none)');
  } else {
    for (const p of ctaPlatforms.sort()) {
      const variants = report.ctaVariants[p]!;
      const entries = Object.entries(variants).sort((a, b) => b[1] - a[1]);
      out.push(`  ${p}:`);
      for (const [id, n] of entries) out.push(`    ${n.toString().padStart(4)} · ${id}`);
    }
  }
  return out.join('\n');
}
