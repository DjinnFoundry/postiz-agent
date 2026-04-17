import { describe, expect, it, vi } from 'vitest';
import { retry, isTransientError } from '../../src/lib/retry.js';

const noSleep = () => Promise.resolve();
const fixedRandom = () => 0.5;

describe('retry()', () => {
  it('returns immediately on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await retry(fn, { sleep: noSleep, random: fixedRandom });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries N times then succeeds', async () => {
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 3) throw new Error('500 upstream');
      return 'ok';
    });
    const result = await retry(fn, { attempts: 3, sleep: noSleep, random: fixedRandom });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws the final error after exhausting attempts', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('500 bad gateway'));
    await expect(retry(fn, { attempts: 3, sleep: noSleep, random: fixedRandom })).rejects.toThrow('500 bad gateway');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry a non-retryable error (4xx)', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('HTTP 401 unauthorized'));
    await expect(retry(fn, { attempts: 3, sleep: noSleep, random: fixedRandom })).rejects.toThrow('401');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries network errors by error code', async () => {
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 2) {
        const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        throw err;
      }
      return 'ok';
    });
    const result = await retry(fn, { attempts: 3, sleep: noSleep, random: fixedRandom });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('honours custom isRetryable', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('anything'));
    await expect(
      retry(fn, { attempts: 3, sleep: noSleep, random: fixedRandom, isRetryable: () => false }),
    ).rejects.toThrow('anything');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('applies exponential backoff with jitter clamped to 2s base', async () => {
    const sleepCalls: number[] = [];
    const sleep = (ms: number) => { sleepCalls.push(ms); return Promise.resolve(); };
    const fn = vi.fn().mockRejectedValue(new Error('503'));
    await expect(retry(fn, { attempts: 3, baseMs: 2000, sleep, random: fixedRandom })).rejects.toThrow();
    // fixedRandom=0.5 → jitter factor = 0 (2*0.5-1 = 0). So delays are exactly 2000, 4000.
    expect(sleepCalls).toEqual([2000, 4000]);
  });
});

describe('isTransientError()', () => {
  it('treats 5xx errors as retryable', () => {
    expect(isTransientError(new Error('HTTP 502 bad gateway'))).toBe(true);
    expect(isTransientError(new Error('status 503'))).toBe(true);
  });
  it('treats 4xx errors as non-retryable', () => {
    expect(isTransientError(new Error('HTTP 400'))).toBe(false);
    expect(isTransientError(new Error('403 forbidden'))).toBe(false);
  });
  it('treats known network codes as retryable', () => {
    expect(isTransientError(Object.assign(new Error(''), { code: 'ECONNRESET' }))).toBe(true);
    expect(isTransientError(Object.assign(new Error(''), { code: 'ETIMEDOUT' }))).toBe(true);
    expect(isTransientError(Object.assign(new Error(''), { code: 'EAI_AGAIN' }))).toBe(true);
  });
  it('is conservative with unknown errors', () => {
    expect(isTransientError(new Error('bad input'))).toBe(false);
    expect(isTransientError(null)).toBe(false);
  });
});
