import type { DecisionLogEntry, Platform, PublishResult } from './types.js';

export interface DispatchCandidate {
  /** Story slug (basename of the AudioKids output files, without extension). */
  slug: string;
  /** Ordering timestamp in ms since epoch. Prefer meta.generatedAt; fall back to file mtime. */
  generatedAtMs: number;
}

/** Lookback window for "already successfully published" idempotency. */
const PUBLISHED_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
/** Lookback window for counting permanent failures per slug. */
const FAILURE_WINDOW_MS = 72 * 60 * 60 * 1000; // 72 hours
/** Max permanent failures per slug in FAILURE_WINDOW_MS before we stop trying. */
const MAX_PERMANENT_FAILURES = 3;
/**
 * Backoff ladder for transient failures, in ms. Stepped so the nth retry only
 * fires after the nth entry has elapsed since the last failure.
 * 1h / 4h / 16h — gives a full day to recover from transient network/quota issues.
 */
const TRANSIENT_BACKOFF_LADDER_MS = [
  60 * 60 * 1000,
  4 * 60 * 60 * 1000,
  16 * 60 * 60 * 1000,
];

export interface StuckSlugInfo {
  slug: string;
  platform: Platform;
  reason: 'too-many-permanent-failures' | 'within-transient-backoff';
  permanentCount?: number;
  lastFailureAt?: string;
  nextEligibleAt?: string;
  lastRemediation?: PublishResult['remediation'];
}

/**
 * Inspect the decision log and report slugs currently blocked from dispatch.
 * Used by `decisions --stuck` and by `selectNextStory` to skip blocked candidates.
 */
export function findStuckSlugs(
  log: DecisionLogEntry[],
  platforms: Platform[],
  now: Date = new Date(),
): StuckSlugInfo[] {
  const failureCutoff = now.getTime() - FAILURE_WINDOW_MS;
  const out: StuckSlugInfo[] = [];

  // Any explicit reset-attempts marker clears failures recorded before its timestamp
  // for the same (slug, platform). Lets humans / agents unstick a slug after fixing
  // the underlying cause without deleting log history.
  const resetsByKey = new Map<string, number>();
  for (const e of log) {
    if (!e.action.startsWith('reset-attempts.')) continue;
    const t = Date.parse(e.createdAt);
    if (!Number.isFinite(t)) continue;
    const key = `${e.storySlug}::${e.platform}`;
    const prev = resetsByKey.get(key);
    if (prev == null || t > prev) resetsByKey.set(key, t);
  }

  const byKey = new Map<string, DecisionLogEntry[]>();
  for (const e of log) {
    if (!platforms.includes(e.platform)) continue;
    if (e.result?.success) continue;
    const key = `${e.storySlug}::${e.platform}`;
    const resetTs = resetsByKey.get(key);
    if (resetTs != null) {
      const created = Date.parse(e.createdAt);
      if (Number.isFinite(created) && created <= resetTs) continue;
    }
    const bucket = byKey.get(key);
    if (bucket) bucket.push(e); else byKey.set(key, [e]);
  }

  for (const [key, entries] of byKey) {
    const [slug, platform] = key.split('::') as [string, Platform];
    const recent = entries
      .filter(e => {
        const t = Date.parse(e.createdAt);
        return Number.isFinite(t) && t >= failureCutoff;
      })
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    if (recent.length === 0) continue;

    const permanentCount = recent.filter(e =>
      ['permanent', 'needs-config', 'needs-human', 'unknown'].includes(e.result?.errorClass ?? ''),
    ).length;
    if (permanentCount >= MAX_PERMANENT_FAILURES) {
      out.push({
        slug,
        platform,
        reason: 'too-many-permanent-failures',
        permanentCount,
        lastFailureAt: recent[0].createdAt,
        lastRemediation: recent[0].result?.remediation,
      });
      continue;
    }

    const transientFailures = recent.filter(e => e.result?.errorClass === 'transient');
    const lastTransient = transientFailures[0];
    if (lastTransient) {
      const transientIndex = Math.min(transientFailures.length - 1, TRANSIENT_BACKOFF_LADDER_MS.length - 1);
      const waitMs = TRANSIENT_BACKOFF_LADDER_MS[transientIndex];
      const lastFailureMs = Date.parse(lastTransient.createdAt);
      const nextEligibleMs = lastFailureMs + waitMs;
      if (now.getTime() < nextEligibleMs) {
        out.push({
          slug,
          platform,
          reason: 'within-transient-backoff',
          lastFailureAt: lastTransient.createdAt,
          nextEligibleAt: new Date(nextEligibleMs).toISOString(),
          lastRemediation: lastTransient.result?.remediation,
        });
      }
    }
  }

  return out;
}

/**
 * Select the oldest candidate that is NOT yet fully published (successful publish
 * within the last 30 days) to ALL requested platforms AND is not currently stuck
 * (too many permanent failures or still within transient backoff).
 *
 * Pure function: call sites pass in candidates, log, platforms, and `now`.
 */
export function selectNextStory(
  candidates: DispatchCandidate[],
  log: DecisionLogEntry[],
  platforms: Platform[],
  now: Date = new Date(),
): string | null {
  if (candidates.length === 0 || platforms.length === 0) return null;

  const publishedCutoffMs = now.getTime() - PUBLISHED_WINDOW_MS;
  const successByStory = new Map<string, Set<Platform>>();
  for (const e of log) {
    if (!e.result?.success) continue;
    const createdMs = Date.parse(e.createdAt);
    if (!Number.isFinite(createdMs) || createdMs < publishedCutoffMs) continue;
    let set = successByStory.get(e.storySlug);
    if (!set) { set = new Set(); successByStory.set(e.storySlug, set); }
    set.add(e.platform);
  }

  const stuck = findStuckSlugs(log, platforms, now);
  const stuckByKey = new Set(stuck.map(s => `${s.slug}::${s.platform}`));

  const sorted = [...candidates].sort((a, b) => a.generatedAtMs - b.generatedAtMs);
  for (const c of sorted) {
    const published = successByStory.get(c.slug) ?? new Set<Platform>();
    const pending = platforms.filter(p => !published.has(p));
    if (pending.length === 0) continue;
    const blocked = pending.every(p => stuckByKey.has(`${c.slug}::${p}`));
    if (blocked) continue;
    return c.slug;
  }
  return null;
}

