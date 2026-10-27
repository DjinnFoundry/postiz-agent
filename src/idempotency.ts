import type { DecisionLogEntry, Platform } from './types.js';
import { isPublishedDecision, requiresPublicationReconciliation } from './publication-state.js';

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Has the given content item already been successfully published to the given platform
 * within the lookback window? Pure function; the orchestrator feeds it the
 * decision log entries so it can be unit-tested without touching disk.
 */
export function wasRecentlyPublished(
  entries: DecisionLogEntry[],
  contentSlug: string,
  platform: Platform,
  now: Date = new Date(),
  windowMs: number = DEFAULT_WINDOW_MS,
): { recent: boolean; entry?: DecisionLogEntry } {
  const cutoffMs = now.getTime() - windowMs;
  // Walk newest-to-oldest: small lists → fine to iterate.
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e) continue;
    const entrySlug = e.contentSlug ?? e.storySlug;
    if (entrySlug !== contentSlug || e.platform !== platform) continue;
    if (!isPublishedDecision(e)) continue;
    const createdMs = Date.parse(e.createdAt);
    if (!Number.isFinite(createdMs)) continue;
    if (createdMs < cutoffMs) continue;
    return { recent: true, entry: e };
  }
  return { recent: false };
}

/** Holds do not expire: a timeout or queued post is not permission to duplicate it. */
export function findPublicationHold(
  entries: DecisionLogEntry[], contentSlug: string, platform: Platform,
): DecisionLogEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if ((entry.contentSlug ?? entry.storySlug) !== contentSlug || entry.platform !== platform) continue;
    if (isPublishedDecision(entry)) return undefined;
    if (requiresPublicationReconciliation(entry)) return entry;
  }
  return undefined;
}
