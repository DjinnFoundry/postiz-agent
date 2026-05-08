import type { DecisionLogEntry, Platform } from './types.js';

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
    if (!e.result?.success) continue;
    // Skip entries whose result was itself a skip (don't double-skip forever).
    if (e.result.skipped) continue;
    const createdMs = Date.parse(e.createdAt);
    if (!Number.isFinite(createdMs)) continue;
    if (createdMs < cutoffMs) continue;
    return { recent: true, entry: e };
  }
  return { recent: false };
}
