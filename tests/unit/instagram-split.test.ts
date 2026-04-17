import { describe, expect, it } from 'vitest';
import { splitIntoParts } from '../../src/platforms/instagram-split.js';
import type { Beat } from '../../src/types.js';

describe('splitIntoParts()', () => {
  it('returns a single part when duration is <= maxPart', () => {
    const parts = splitIntoParts(120);
    expect(parts).toEqual([
      { partIndex: 1, partTotal: 1, clipStartSec: 0, clipDurationSec: 120 },
    ]);
  });

  it('splits a 240s cuento into exactly 2 parts', () => {
    const parts = splitIntoParts(240, [], [], { snapWindowSec: 10 });
    expect(parts).toHaveLength(2);
    expect(parts[0]!.partIndex).toBe(1);
    expect(parts[1]!.partTotal).toBe(2);
    const total = parts.reduce((a, p) => a + p.clipDurationSec, 0);
    expect(total).toBeCloseTo(240, 1);
    // First part must fit under 170s budget
    expect(parts[0]!.clipDurationSec).toBeLessThanOrEqual(170);
    expect(parts[1]!.clipDurationSec).toBeLessThanOrEqual(170);
  });

  it('splits a 500s cuento into 3 parts', () => {
    const parts = splitIntoParts(500);
    expect(parts).toHaveLength(3);
    const total = parts.reduce((a, p) => a + p.clipDurationSec, 0);
    expect(total).toBeCloseTo(500, 1);
    for (const p of parts) expect(p.clipDurationSec).toBeLessThanOrEqual(170);
  });

  it('snaps split points to a beat within the window', () => {
    // Ideal mid for 240s is 120. Beat at 118000ms (118s) should win over word boundary at 121s.
    const beats: Beat[] = [
      { t_ms: 0, type: 'intro' },
      { t_ms: 118_000, type: 'tension' },
      { t_ms: 240_000, type: 'resolution' },
    ];
    const words = [{ start: 120, end: 121 }];
    const parts = splitIntoParts(240, beats, words, { snapWindowSec: 10 });
    expect(parts[0]!.clipDurationSec).toBeCloseTo(118, 1);
    expect(parts[1]!.clipStartSec).toBeCloseTo(118, 1);
  });

  it('falls back to a word boundary when no beat is within the window', () => {
    const beats: Beat[] = [
      { t_ms: 0, type: 'intro' },
      { t_ms: 50_000, type: 'early' }, // 70s away from ideal 120
      { t_ms: 240_000, type: 'resolution' },
    ];
    const words = [
      { start: 119, end: 119.5 },
      { start: 120, end: 122 },
      { start: 125, end: 126 },
    ];
    const parts = splitIntoParts(240, beats, words, { snapWindowSec: 10 });
    // Nearest word.end to ideal 120 within window: 119.5 (delta 0.5) beats 122 (delta 2).
    expect(parts[0]!.clipDurationSec).toBeCloseTo(119.5, 1);
  });

  it('falls back to the ideal midpoint when no boundary is within the window', () => {
    const beats: Beat[] = [
      { t_ms: 0, type: 'intro' },
      { t_ms: 50_000, type: 'early' },
    ];
    const words = [{ start: 10, end: 11 }];
    const parts = splitIntoParts(240, beats, words, { snapWindowSec: 5 });
    expect(parts[0]!.clipDurationSec).toBeCloseTo(120, 1);
  });

  it('produces strictly increasing, non-overlapping parts', () => {
    const parts = splitIntoParts(500);
    for (let i = 0; i + 1 < parts.length; i++) {
      const cur = parts[i]!;
      const next = parts[i + 1]!;
      expect(next.clipStartSec).toBeCloseTo(cur.clipStartSec + cur.clipDurationSec, 1);
    }
  });

  it('labels parts 1..N of N', () => {
    const parts = splitIntoParts(500);
    expect(parts.map(p => [p.partIndex, p.partTotal])).toEqual([
      [1, 3], [2, 3], [3, 3],
    ]);
  });

  it('returns an empty array for zero or negative duration', () => {
    expect(splitIntoParts(0)).toEqual([]);
    expect(splitIntoParts(-1)).toEqual([]);
  });
});
