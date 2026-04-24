import { describe, it, expect } from 'vitest';
import { hexToRgb, relativeLuminance, contrastRatio } from '../../src/lib/color.js';

describe('hexToRgb', () => {
  it('parses 6-digit hex with leading #', () => {
    expect(hexToRgb('#FF8040')).toEqual({ r: 255, g: 128, b: 64 });
  });

  it('parses 6-digit hex without leading #', () => {
    expect(hexToRgb('FF8040')).toEqual({ r: 255, g: 128, b: 64 });
  });

  it('is case-insensitive', () => {
    expect(hexToRgb('#ff8040')).toEqual({ r: 255, g: 128, b: 64 });
    expect(hexToRgb('#Ff8040')).toEqual({ r: 255, g: 128, b: 64 });
  });

  it('parses black and white', () => {
    expect(hexToRgb('#000000')).toEqual({ r: 0, g: 0, b: 0 });
    expect(hexToRgb('#FFFFFF')).toEqual({ r: 255, g: 255, b: 255 });
  });

  it('throws on invalid hex', () => {
    expect(() => hexToRgb('#ZZZZZZ')).toThrow();
    expect(() => hexToRgb('#1234')).toThrow();
    expect(() => hexToRgb('')).toThrow();
  });
});

describe('relativeLuminance', () => {
  it('is 0 for pure black', () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 6);
  });

  it('is 1 for pure white', () => {
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 6);
  });

  it('is ordered: black < gray < white', () => {
    const black = relativeLuminance({ r: 0, g: 0, b: 0 });
    const gray = relativeLuminance({ r: 128, g: 128, b: 128 });
    const white = relativeLuminance({ r: 255, g: 255, b: 255 });
    expect(black).toBeLessThan(gray);
    expect(gray).toBeLessThan(white);
  });
});

describe('contrastRatio', () => {
  it('returns 21 for black vs white', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 1);
  });

  it('returns 21 for white vs black (symmetric)', () => {
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 1);
  });

  it('returns 1 for identical colors', () => {
    expect(contrastRatio('#7F7F7F', '#7F7F7F')).toBeCloseTo(1, 6);
    expect(contrastRatio('#112233', '#112233')).toBeCloseTo(1, 6);
  });

  it('passes AA for a known high-contrast pair (#2B1B0F on #F1E8D8)', () => {
    expect(contrastRatio('#2B1B0F', '#F1E8D8')).toBeGreaterThanOrEqual(4.5);
  });

  it('passes AAA threshold (>=7) for near black on white', () => {
    expect(contrastRatio('#111111', '#FFFFFF')).toBeGreaterThanOrEqual(7.0);
  });
});
