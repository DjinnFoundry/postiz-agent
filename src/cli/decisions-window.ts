import type { DecisionLogEntry, Platform } from '../types.js';

export interface WindowFilter {
  now: Date;
  days: number;
  platform?: Platform;
}

// Shared between `stats` and `cta-ab` so both CLIs honour the same window +
// platform predicate. Non-publish actions (e.g. `reset-attempts.*`) are kept
// here because some callers still need them (stats passes the full windowed
// slice to findStuckSlugs); use `filterPublishes` for publish-only views.
export function filterWindow(decisions: DecisionLogEntry[], f: WindowFilter): DecisionLogEntry[] {
  const fromMs = f.now.getTime() - f.days * 24 * 3600_000;
  return decisions.filter(d => {
    const t = Date.parse(d.createdAt);
    if (!Number.isFinite(t) || t < fromMs) return false;
    if (f.platform && d.platform !== f.platform) return false;
    return true;
  });
}

export function filterPublishes(decisions: DecisionLogEntry[]): DecisionLogEntry[] {
  return decisions.filter(d => d.action.startsWith('publish.'));
}

export function windowFromMs(f: Pick<WindowFilter, 'now' | 'days'>): number {
  return f.now.getTime() - f.days * 24 * 3600_000;
}
