import { DecisionLog } from '../decisions/log.js';
import { listCtas } from '../copy/ctas.js';
import type { DecisionLogEntry, Platform } from '../types.js';
import { filterPublishes, filterWindow, windowFromMs } from './decisions-window.js';

export interface CtaAbVariantReport {
  id: string;
  text: string;
  uses: number;
  success: number;
  failed: number;
  successRate: number;
  sampleUrls: string[];
  /** Present only when --ingest has been used to layer engagement on top of decision-log outcomes. */
  avgEngagement?: Record<string, number>;
}

export interface CtaAbPlatformReport {
  variants: CtaAbVariantReport[];
  // Publishes that reached the platform but had no ctaVariant recorded (pre-feature
  // history, or captions where the author inlined their own CTA).
  unknownCount: number;
}

export interface CtaAbReport {
  generatedAt: string;
  windowDays: number;
  from: string;
  to: string;
  platformFilter?: Platform;
  platforms: Partial<Record<Platform, CtaAbPlatformReport>>;
  ingestFile?: string;
  ingestApplied: boolean;
}

export interface CtaAbInput {
  now?: Date;
  decisions?: DecisionLogEntry[];
  days?: number;
  platform?: Platform;
  /**
   * Path to a JSONL file with `{postId, engagement: {...}, recordedAt}` records.
   * When present, the report will layer average engagement metrics on top of the
   * success/failed signal derived from the decision log. Not yet wired: the
   * ingester lives in a follow-up change so YouTubeCLI (and eventually the Meta
   * Graph + TikTok analytics APIs) can dump their metrics into a common format
   * without this CLI needing platform-specific credentials.
   */
  ingestFile?: string;
}

// Only `publish.*` entries carry ctaVariant, and skipped ones never hit the
// platform, so both filters keep the ratio honest.
export async function runCtaAb(input: CtaAbInput = {}): Promise<CtaAbReport> {
  const now = input.now ?? new Date();
  const days = input.days ?? 30;
  const decisions = input.decisions ?? new DecisionLog().list();
  const platformFilter = input.platform;

  const fromMs = windowFromMs({ now, days });
  const publishes = filterPublishes(
    filterWindow(decisions, { now, days, platform: platformFilter }),
  );

  const platforms: Partial<Record<Platform, CtaAbPlatformReport>> = {};

  for (const entry of publishes) {
    const result = entry.result;
    if (result?.skipped) continue;

    const p = entry.platform;
    const slot = platforms[p] ?? { variants: [], unknownCount: 0 };
    platforms[p] = slot;

    const variantId = result?.ctaVariant;
    if (!variantId) {
      slot.unknownCount += 1;
      continue;
    }

    let v = slot.variants.find(x => x.id === variantId);
    if (!v) {
      v = {
        id: variantId,
        text: resolveVariantText(p, variantId),
        uses: 0,
        success: 0,
        failed: 0,
        successRate: 0,
        sampleUrls: [],
      };
      slot.variants.push(v);
    }
    v.uses += 1;
    if (result?.success) v.success += 1;
    else v.failed += 1;

    // URL beats postId for operator triage (click-through); fall back so the
    // sample list is never empty just because Postiz didn't echo a URL back.
    const ref = result?.url ?? result?.postId;
    if (ref && v.sampleUrls.length < 3) v.sampleUrls.push(ref);
  }

  for (const p of Object.keys(platforms) as Platform[]) {
    for (const v of platforms[p]!.variants) {
      v.successRate = v.uses === 0 ? 0 : v.success / v.uses;
    }
    // Highest volume first, then worst rate: a failing variant with few uses
    // still surfaces at the top of its volume tier.
    platforms[p]!.variants.sort((a, b) => {
      if (b.uses !== a.uses) return b.uses - a.uses;
      return a.successRate - b.successRate;
    });
  }

  // TODO(ingest): when `input.ingestFile` is provided, open the JSONL, join on
  // `result.postId`, aggregate `engagement.*` fields per variant, and write
  // `avgEngagement` into each CtaAbVariantReport. The schema is intentionally
  // open-ended so YouTubeCLI's `{views, likes, comments}` and Meta Graph's
  // `{impressions, reach, plays}` can both land here without coupling.
  const ingestApplied = false;

  return {
    generatedAt: now.toISOString(),
    windowDays: days,
    from: new Date(fromMs).toISOString(),
    to: now.toISOString(),
    platformFilter,
    platforms,
    ingestFile: input.ingestFile,
    ingestApplied,
  };
}

function resolveVariantText(platform: Platform, id: string): string {
  const catalog = listCtas(platform);
  const match = catalog.find(v => v.id === id);
  return match?.text ?? '';
}

// No colors or unicode boxes: cron-friendly, greppable.
export function formatCtaAbReport(report: CtaAbReport): string {
  const out: string[] = [];
  const filter = report.platformFilter ? `, platform=${report.platformFilter}` : '';
  out.push(`── cta a/b (last ${report.windowDays} days${filter}) ──`);
  const platforms = Object.keys(report.platforms) as Platform[];
  if (platforms.length === 0) {
    out.push('  (none)');
    return out.join('\n');
  }
  for (const p of platforms.sort()) {
    const section = report.platforms[p]!;
    out.push('');
    out.push(`  ${p}  (unknown=${section.unknownCount})`);
    if (section.variants.length === 0) {
      out.push('    (no tagged variants in window)');
      continue;
    }
    for (const v of section.variants) {
      const rate = `${(v.successRate * 100).toFixed(1)}%`;
      out.push(`    ${v.uses.toString().padStart(3)} uses · ok=${v.success} fail=${v.failed} · ${rate.padStart(6)} · ${v.id}`);
      if (v.text) out.push(`        "${v.text}"`);
      if (v.sampleUrls.length > 0) out.push(`        samples: ${v.sampleUrls.join(' | ')}`);
    }
  }
  if (report.ingestFile && !report.ingestApplied) {
    out.push('');
    out.push(`  (--ingest ${report.ingestFile} accepted but engagement merge is not yet implemented)`);
  }
  return out.join('\n');
}
