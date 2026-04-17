/**
 * Retry with exponential backoff and jitter.
 *
 * Defaults:
 *   attempts = 3, baseMs = 2000, delay = baseMs * 2^(attempt-1) ± 25% jitter.
 *   isRetryable = treat network errors and HTTP 5xx as transient; HTTP 4xx as
 *   permanent (no retry).
 *
 * The function returns the resolved value on the first successful attempt or
 * throws the last error after `attempts` failures / a non-retryable error.
 */

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  isRetryable?: (err: unknown) => boolean;
  /** Optional hook for tests / logging. Called before each sleep. */
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  /** Sleep function (override-able for tests). */
  sleep?: (ms: number) => Promise<void>;
  /** PRNG in [0, 1); override-able for deterministic tests. */
  random?: () => number;
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_MS = 2000;

const NETWORK_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EPIPE']);

export function isTransientError(err: unknown): boolean {
  if (!err) return false;
  const anyErr = err as { code?: string; message?: string };
  if (anyErr.code && NETWORK_CODES.has(anyErr.code)) return true;
  const msg = anyErr.message ?? String(err);
  // Detect 4xx explicitly → NOT retryable
  if (/\b4\d{2}\b/.test(msg)) return false;
  // Detect 5xx or the word '5' in a status-style context → retryable
  if (/\b5\d{2}\b/.test(msg)) return true;
  // Generic network-error shape in fetch: "fetch failed" / "network error"
  if (/network|socket hang up|timeout|temporarily unavailable/i.test(msg)) return true;
  return false;
}

export async function retry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? DEFAULT_ATTEMPTS;
  const baseMs = opts.baseMs ?? DEFAULT_BASE_MS;
  const isRetryable = opts.isRetryable ?? isTransientError;
  const sleep = opts.sleep ?? defaultSleep;
  const rand = opts.random ?? Math.random;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= attempts || !isRetryable(err)) throw err;
      const backoff = baseMs * Math.pow(2, attempt - 1);
      const jitter = backoff * 0.25 * (rand() * 2 - 1); // ±25%
      const delay = Math.max(0, Math.round(backoff + jitter));
      opts.onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }
  throw lastErr;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
