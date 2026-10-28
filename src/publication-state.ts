import type { DecisionLogEntry, PublicationOutcome, PublishResult } from './types.js';
import { isTransientError } from './lib/retry.js';

/** A successful operation is not necessarily a confirmed publication. */
export function publicationOutcome(result: PublishResult): PublicationOutcome {
  if ([result.url, result.postId].some(value => value !== undefined && typeof value !== 'string')) return 'unknown';
  if ([result.preview, result.dryRun, result.skipped].some(value => value !== undefined && typeof value !== 'boolean')) return 'unknown';
  if (result.preview || result.dryRun || result.outcome === 'preview' || /^file:/i.test(result.url?.trim() ?? '')) return 'preview';
  if (result.skipped || result.outcome === 'skipped') return 'skipped';
  if (result.outcome === 'unknown' || result.outcome === 'incomplete') return result.outcome;
  const hasReference = Boolean(result.postId?.trim()) || /^https?:\/\//i.test(result.url?.trim() ?? '');
  if (result.parts !== undefined) {
    if (!Array.isArray(result.parts) || result.parts.some(part => !part || typeof part !== 'object' || Array.isArray(part))) return 'incomplete';
    const parts = result.parts;
    const total = result.partTotal ?? parts[0]?.partTotal;
    const complete = Number.isInteger(total) && total! > 0 && parts.length === total
      && parts.every(p => p.platform === result.platform && p.partTotal === total
        && Number.isInteger(p.partIndex) && p.partIndex! >= 1 && p.partIndex! <= total!)
      && new Set(parts.map(p => p.partIndex)).size === total;
    const outcomes = parts.map(publicationOutcome);
    if (complete && outcomes.every(o => o === 'preview')) return 'preview';
    if (complete && result.success === true && result.outcome !== 'failed' && !result.error && outcomes.every(o => o === 'accepted' || o === 'published')) {
      return outcomes.every(o => o === 'published') ? 'published' : 'accepted';
    }
    return parts.length > 0 && !hasReference && outcomes.every(o => o === 'failed') ? 'failed' : 'incomplete';
  }
  if (result.success !== true || result.outcome === 'failed' || result.error) {
    if (hasReference || (result.outcome !== 'failed' && isTransientError({ message: result.error }))) return 'unknown';
    return result.success === false || result.outcome === 'failed' ? 'failed' : 'unknown';
  }
  if (hasReference) return result.outcome === 'published' ? 'published' : 'accepted';
  return 'unknown';
}

export function normalizePublishResult(result: PublishResult, dryRun = false, platform = result.platform): PublishResult {
  const checked = result.platform === platform ? result : { ...result, platform, success: false, outcome: 'unknown' as const };
  const marked = dryRun ? { ...checked, preview: true, dryRun: true } : { ...checked };
  if (Array.isArray(marked.parts) && marked.parts.every(p => p && typeof p === 'object' && !Array.isArray(p))) {
    marked.parts = marked.parts.map(p => normalizePublishResult(p, dryRun, platform));
  }
  const outcome = publicationOutcome(marked);
  return {
    ...marked,
    outcome,
    success: marked.success === true && ['preview', 'accepted', 'published', 'skipped'].includes(outcome),
    ...(outcome === 'preview' ? { preview: true, dryRun: true } : {}),
  };
}

function isPublicationEvent(entry: DecisionLogEntry): boolean {
  const action = `publish.${entry.platform}`;
  return entry.result?.platform === entry.platform
    && (entry.action === action || (entry.action.startsWith(`${action}.part`) && /^\d+$/.test(entry.action.slice(`${action}.part`.length))));
}

/** Only a whole-operation event with explicit adapter delivery confirmation counts. */
export function isPublishedDecision(entry: DecisionLogEntry): boolean {
  return isPublicationEvent(entry) && entry.action === `publish.${entry.platform}`
    && !entry.result.partIndex && !(entry.result.partTotal && entry.result.partTotal > 1)
    && publicationOutcome(entry.result) === 'published';
}

/** Pending/ambiguous remote work must not be automatically sent again. */
export function requiresPublicationReconciliation(entry: DecisionLogEntry): boolean {
  if (!isPublicationEvent(entry)) return false;
  const outcome = publicationOutcome(entry.result);
  return outcome === 'accepted' || outcome === 'unknown' || outcome === 'incomplete'
    || (outcome === 'published' && !isPublishedDecision(entry));
}
