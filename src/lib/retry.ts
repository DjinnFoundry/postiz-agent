import { classifyError } from '../core/errors.js';

/**
 * Retry with exponential backoff and jitter.
 *
 * Defaults:
 *   attempts = 3, baseMs = 2000, delay = baseMs * 2^(attempt-1) ± 25% jitter.
 *   isRetryable = delegated to classifyError (central taxonomy in core/errors.ts).
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

/**
 * Decide if a thrown error looks retryable. Thin wrapper over classifyError so
 * existing callers keep the same shape; the taxonomy lives in core/errors.ts.
 */
export function isTransientError(err: unknown): boolean {
  return classifyError(err).retryable;
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
