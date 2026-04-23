export interface TokenBucketOptions {
  ratePerSec: number;
  burst?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_ACQUIRE_TIMEOUT_MS = 30_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class TokenBucket {
  private readonly ratePerSec: number;
  private readonly burst: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly disabled: boolean;

  private availableTokens: number;
  private lastRefillAt: number;
  private readyAt: number;

  constructor(opts: TokenBucketOptions) {
    if (!Number.isFinite(opts.ratePerSec)) {
      throw new Error(`TokenBucket ratePerSec must be a finite number, got ${opts.ratePerSec}`);
    }
    this.ratePerSec = opts.ratePerSec;
    this.burst = opts.burst ?? Math.max(1, opts.ratePerSec);
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
    this.disabled = opts.ratePerSec <= 0;
    this.availableTokens = this.burst;
    this.lastRefillAt = this.now();
    this.readyAt = this.now();
  }

  async acquire(timeoutMs: number = DEFAULT_ACQUIRE_TIMEOUT_MS): Promise<void> {
    if (this.disabled) return;

    const callStart = this.now();
    const slot = Math.max(this.readyAt, callStart);

    this.refillUpTo(slot);

    if (this.availableTokens >= 1) {
      this.availableTokens -= 1;
      this.readyAt = slot;
      return;
    }

    const deficit = 1 - this.availableTokens;
    const waitMs = Math.ceil((deficit / this.ratePerSec) * 1000);
    const waitUntil = slot + waitMs;
    const totalWait = waitUntil - callStart;
    if (totalWait > timeoutMs) {
      throw new Error('rate-limit acquire timeout');
    }

    this.availableTokens -= 1;
    this.readyAt = waitUntil;
    const sleepFor = waitUntil - this.now();
    if (sleepFor > 0) await this.sleep(sleepFor);
    this.refillUpTo(this.now());
  }

  private refillUpTo(t: number): void {
    const elapsedMs = t - this.lastRefillAt;
    if (elapsedMs <= 0) return;
    const add = (elapsedMs / 1000) * this.ratePerSec;
    this.availableTokens = Math.min(this.burst, this.availableTokens + add);
    this.lastRefillAt = t;
  }
}
