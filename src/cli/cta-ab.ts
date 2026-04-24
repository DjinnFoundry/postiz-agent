import { existsSync, readFileSync } from 'node:fs';
import { DecisionLog } from '../decisions/log.js';
import { listCtas } from '../copy/ctas.js';
import type { DecisionLogEntry, Platform } from '../types.js';
import { filterPublishes, filterWindow, windowFromMs } from './decisions-window.js';

export interface EngagementRecord {
  postId: string;
  platform: Platform;
  engagement: {
    views?: number;
    likes?: number;
    comments?: number;
    shares?: number;
  };
  recordedAt: string;
}

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
   * Path to a JSONL file with `{postId, platform, engagement, recordedAt}` records.
   * When present, the report layers average engagement metrics on top of the
   * success/failed signal derived from the decision log. YouTubeCLI exports,
   * Meta Graph dumps, and TikTok analytics pulls can all land here: this CLI
   * never touches platform credentials directly, it just joins on postId.
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

  let ingestApplied = false;
  if (input.ingestFile) {
    const records = loadIngestFile(input.ingestFile);
    mergeEngagement(platforms, records, publishes);
    ingestApplied = true;
  }

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

export function loadIngestFile(path: string): EngagementRecord[] {
  if (!existsSync(path)) {
    console.warn(`[cta-ab] ingest file not found: ${path}`);
    return [];
  }
  const raw = readFileSync(path, 'utf-8');
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  const records: EngagementRecord[] = [];
  for (const [i, line] of lines.entries()) {
    try {
      const parsed = JSON.parse(line) as Partial<EngagementRecord>;
      if (!parsed || typeof parsed.postId !== 'string' || !parsed.postId) {
        console.warn(`[cta-ab] invalid record at line ${i + 1}: missing postId`);
        continue;
      }
      const engagement = parsed.engagement ?? {};
      records.push({
        postId: parsed.postId,
        platform: parsed.platform as Platform,
        engagement,
        recordedAt: parsed.recordedAt ?? '',
      });
    } catch {
      console.warn(`[cta-ab] malformed JSON at line ${i + 1}: skipped`);
    }
  }
  return records;
}

interface EngagementAccumulator {
  views: number;
  likes: number;
  comments: number;
  shares: number;
  count: number;
}

export function mergeEngagement(
  platforms: Partial<Record<Platform, CtaAbPlatformReport>>,
  records: EngagementRecord[],
  decisions: DecisionLogEntry[],
): void {
  const postIdIndex = new Map<string, { platform: Platform; variantId: string }>();
  for (const entry of decisions) {
    const postId = entry.result?.postId;
    const variantId = entry.result?.ctaVariant;
    if (postId && variantId) {
      postIdIndex.set(postId, { platform: entry.platform, variantId });
    }
  }

  const accumulators = new Map<string, EngagementAccumulator>();
  for (const record of records) {
    const match = postIdIndex.get(record.postId);
    if (!match) {
      console.warn(`[cta-ab] ingest record postId=${record.postId} has no matching decision; skipped`);
      continue;
    }
    const key = `${match.platform}::${match.variantId}`;
    const acc = accumulators.get(key) ?? { views: 0, likes: 0, comments: 0, shares: 0, count: 0 };
    acc.views += record.engagement.views ?? 0;
    acc.likes += record.engagement.likes ?? 0;
    acc.comments += record.engagement.comments ?? 0;
    acc.shares += record.engagement.shares ?? 0;
    acc.count += 1;
    accumulators.set(key, acc);
  }

  for (const [key, acc] of accumulators) {
    const [platform, variantId] = key.split('::') as [Platform, string];
    const section = platforms[platform];
    if (!section) continue;
    const variant = section.variants.find(v => v.id === variantId);
    if (!variant) continue;
    variant.avgEngagement = {
      avgViews: acc.views / acc.count,
      avgLikes: acc.likes / acc.count,
      avgComments: acc.comments / acc.count,
      avgShares: acc.shares / acc.count,
      sampleSize: acc.count,
    };
  }
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
      if (v.avgEngagement) {
        out.push(`        engagement: ${formatEngagementLine(v.avgEngagement)}`);
      }
    }
  }
  return out.join('\n');
}

function formatEngagementLine(eng: Record<string, number>): string {
  const parts: string[] = [];
  if (eng.avgViews !== undefined) parts.push(`${Math.round(eng.avgViews)} avg views`);
  if (eng.avgLikes !== undefined) parts.push(`${Math.round(eng.avgLikes)} avg likes`);
  if (eng.avgComments !== undefined) parts.push(`${Math.round(eng.avgComments)} avg comments`);
  if (eng.avgShares !== undefined && eng.avgShares > 0) parts.push(`${Math.round(eng.avgShares)} avg shares`);
  parts.push(`n=${eng.sampleSize}`);
  return parts.join(' · ');
}
