import type { Platform } from '../types.js';

export interface FailurePayload {
  slug: string;
  platform: Platform;
  error: string;
  attempts: number;
  timestamp: string;
}

export interface NotifyFailureInput {
  slug: string;
  platform: Platform;
  error: string;
  attempts?: number;
  timestamp?: string;
}

/**
 * Pure payload builder (split out so it can be unit-tested without touching
 * fetch). Defaults attempts to 1 and timestamp to now-ISO.
 */
export function buildFailurePayload(input: NotifyFailureInput): FailurePayload {
  return {
    slug: input.slug,
    platform: input.platform,
    error: input.error,
    attempts: input.attempts ?? 1,
    timestamp: input.timestamp ?? new Date().toISOString(),
  };
}

/**
 * Fire-and-forget webhook notification with a 5s timeout. Swallows every error:
 * the orchestrator must NEVER be blocked or failed by an alert delivery issue.
 *
 * When no webhookUrl is passed, this is a no-op that returns `false`.
 */
export async function notifyFailure(
  input: NotifyFailureInput,
  webhookUrl?: string,
  deps: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<boolean> {
  if (!webhookUrl) return false;
  const payload = buildFailurePayload(input);
  const timeoutMs = deps.timeoutMs ?? 5000;
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
    return res.ok;
  } catch {
    // Intentionally swallow — alerts are best-effort.
    return false;
  } finally {
    clearTimeout(timer);
  }
}
