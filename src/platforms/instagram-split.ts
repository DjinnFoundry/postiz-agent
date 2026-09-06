import type { Beat } from '../types.js';

export interface SplitWordLite {
  start: number;
  end: number;
}

export interface PartSpec {
  /** 1-based part index. */
  partIndex: number;
  partTotal: number;
  clipStartSec: number;
  clipDurationSec: number;
}

export interface SplitOptions {
  /** Maximum per-part audio duration (inclusive). Default 170s (leaves headroom under the 180s IG Reels cap). */
  maxPartSec?: number;
  /** Tolerance for snapping a split point to the nearest beat boundary. Default 10s. */
  snapWindowSec?: number;
}

const DEFAULT_MAX_PART = 170;
const DEFAULT_SNAP_WINDOW = 10;

/**
 * Splits a cuento whose audio exceeds the IG Reels limit into ordered parts.
 *
 * Strategy (pure, side-effect-free):
 *   1. Compute the minimum number of parts N such that ceil(audioDuration / N) <= maxPart.
 *   2. Generate ideal split times evenly spaced at audioDuration / N.
 *   3. Snap each split to the nearest beat boundary within ±snapWindowSec, else to
 *      the nearest word boundary within the same window, else leave the ideal value.
 *   4. Emit PartSpec with {partIndex, partTotal, clipStartSec, clipDurationSec}.
 *
 * For audioDurationSec ≤ maxPart the function returns a SINGLE part (1 of 1) spanning
 * the whole audio; callers may still use the uniform part envelope.
 */
export function splitIntoParts(
  audioDurationSec: number,
  beats: Beat[] = [],
  words: SplitWordLite[] = [],
  opts: SplitOptions = {},
): PartSpec[] {
  if (!Number.isFinite(audioDurationSec)) throw new Error('audio duration must be finite');
  if (audioDurationSec <= 0) return [];
  const maxPart = opts.maxPartSec ?? DEFAULT_MAX_PART;
  const snapWindow = opts.snapWindowSec ?? DEFAULT_SNAP_WINDOW;
  if (!Number.isFinite(maxPart) || maxPart <= 0) throw new Error('maxPartSec must be positive and finite');
  if (!Number.isFinite(snapWindow) || snapWindow < 0) throw new Error('snapWindowSec must be non-negative and finite');

  const n = Math.max(1, Math.ceil(audioDurationSec / maxPart));
  if (n === 1) {
    return [{ partIndex: 1, partTotal: 1, clipStartSec: 0, clipDurationSec: audioDurationSec }];
  }

  // Beat boundaries (seconds) — internal only, not the 0 mark itself.
  const beatSecs = beats
    .map(b => b.t_ms / 1000)
    .filter(t => t > 0 && t < audioDurationSec)
    .sort((a, b) => a - b);

  // Word boundaries (end times) give finer-grained fallback snap targets.
  const wordEnds = words
    .map(w => w.end)
    .filter(t => t > 0 && t < audioDurationSec)
    .sort((a, b) => a - b);

  // Compute N-1 internal split points.
  const ideal: number[] = [];
  for (let i = 1; i < n; i++) ideal.push((audioDurationSec * i) / n);

  const splits = ideal.map(t => snapToBoundary(t, beatSecs, wordEnds, snapWindow));
  // Keep every part within the budget, including the tail left after a snap.
  const bounded: number[] = [];
  let lastBoundary = 0;
  const minPart = Math.min(1, audioDurationSec / n);
  for (let i = 0; i < splits.length; i++) {
    const remaining = n - i - 1;
    const lower = Math.max(lastBoundary + minPart, audioDurationSec - remaining * maxPart);
    const upper = Math.min(lastBoundary + maxPart, audioDurationSec - remaining * minPart);
    const v = Math.min(upper, Math.max(lower, splits[i]));
    bounded.push(v);
    lastBoundary = v;
  }

  const edges = [0, ...bounded, audioDurationSec];
  const parts: PartSpec[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const start = edges[i]!;
    const end = edges[i + 1]!;
    parts.push({
      partIndex: i + 1,
      partTotal: n,
      clipStartSec: start,
      clipDurationSec: Math.max(0, end - start),
    });
  }
  return parts;
}

function snapToBoundary(
  target: number,
  beats: number[],
  words: number[],
  window: number,
): number {
  const beat = nearestWithinWindow(target, beats, window);
  if (beat !== null) return beat;
  const word = nearestWithinWindow(target, words, window);
  if (word !== null) return word;
  return target;
}

function nearestWithinWindow(target: number, points: number[], window: number): number | null {
  let best: number | null = null;
  let bestDelta = Infinity;
  for (const p of points) {
    const delta = Math.abs(p - target);
    if (delta <= window && delta < bestDelta) {
      best = p;
      bestDelta = delta;
    }
  }
  return best;
}
