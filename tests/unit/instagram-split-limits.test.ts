import { describe, expect, it } from 'vitest';
import { splitIntoParts } from '../../src/platforms/instagram-split.js';

describe('Instagram hard split limits', () => {
  it('does not let adjacent beat snaps create an oversized middle part', () => {
    const parts = splitIntoParts(510, [{ t_ms: 160_000, type: 'beat' }, { t_ms: 350_000, type: 'beat' }]);
    expect(parts.every(part => part.clipDurationSec > 0 && part.clipDurationSec <= 170)).toBe(true);
    expect(parts.reduce((total, part) => total + part.clipDurationSec, 0)).toBeCloseTo(510);
  });

  it('rejects non-finite durations and invalid budgets without unbounded loops', () => {
    expect(() => splitIntoParts(Number.POSITIVE_INFINITY)).toThrow(/duration/i);
    expect(() => splitIntoParts(240, [], [], { maxPartSec: 0 })).toThrow(/maxPartSec/i);
  });
});
