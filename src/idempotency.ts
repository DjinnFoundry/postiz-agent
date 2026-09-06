import type { DecisionLogEntry, Platform, PublishResult } from './types.js';

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Has the given story already been successfully published to the given platform
 * within the lookback window? Pure function; the orchestrator feeds it the
 * decision log entries so it can be unit-tested without touching disk.
 */
export function wasRecentlyPublished(
  entries: DecisionLogEntry[],
  storySlug: string,
  platform: Platform,
  now: Date = new Date(),
  windowMs: number = DEFAULT_WINDOW_MS,
): { recent: boolean; entry?: DecisionLogEntry } {
  const recent = recentSuccesses(entries, storySlug, platform, now, windowMs);
  const single = recent.find(e => !e.result.partIndex && !e.result.parts?.length);
  if (single) return { recent: true, entry: single };
  const parts = completedPublicationParts(entries, storySlug, platform, now, windowMs);
  if (parts.length && parts.length === parts[0].partTotal) {
    return { recent: true, entry: recent[0] };
  }
  return { recent: false };
}

/** Successful parts survive a later failed attempt and can be resumed individually. */
export function completedPublicationParts(
  entries: DecisionLogEntry[],
  storySlug: string,
  platform: Platform,
  now: Date = new Date(),
  windowMs: number = DEFAULT_WINDOW_MS,
): PublishResult[] {
  const recent = recentSuccesses(entries, storySlug, platform, now, windowMs);
  const parts = recent.flatMap(e => e.result.parts ?? [e.result]).filter(p =>
    p.success && !p.skipped && Number.isInteger(p.partIndex) && Number.isInteger(p.partTotal)
    && p.partIndex! >= 1 && p.partIndex! <= p.partTotal!,
  );
  const total = parts[0]?.partTotal;
  const byIndex = new Map<number, PublishResult>();
  for (const part of parts) {
    if (part.partTotal === total && !byIndex.has(part.partIndex!)) byIndex.set(part.partIndex!, part);
  }
  return [...byIndex.values()].sort((a, b) => a.partIndex! - b.partIndex!);
}

function recentSuccesses(
  entries: DecisionLogEntry[], storySlug: string, platform: Platform, now: Date, windowMs: number,
): DecisionLogEntry[] {
  const cutoff = now.getTime() - windowMs;
  return entries.filter(e => {
    if (e.storySlug !== storySlug || e.platform !== platform || !e.action.startsWith('publish.')) return false;
    if (!e.result?.success || e.result.skipped) return false;
    // Historical previews were recorded as success before dry runs stopped writing the log.
    if (e.result.url?.startsWith('file://') || e.result.url === 'text-only-dry-run') return false;
    const created = Date.parse(e.createdAt);
    return Number.isFinite(created) && created >= cutoff && created <= now.getTime();
  }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}
