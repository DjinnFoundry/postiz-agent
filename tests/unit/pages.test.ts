import { describe, expect, it } from 'vitest';
import { buildPages } from '../../hyperframes/templates/common.mjs';

const word = (text: string, start: number, end: number) => ({ text, start, end });

describe('buildPages (HyperFrames template helper)', () => {
  it('returns an empty array for empty input', () => {
    expect(buildPages([])).toEqual([]);
  });

  it('packs a short sentence into a single page', () => {
    const words = [
      word('Hola', 0, 0.4),
      word('mundo.', 0.4, 0.9),
    ];
    const pages = buildPages(words, { targetWordsPerPage: 18, maxWordsPerPage: 28, minWordsBeforeBreak: 8 });
    expect(pages).toHaveLength(1);
    expect(pages[0].tokens.map((t: { text: string }) => t.text)).toEqual(['Hola', 'mundo.']);
    expect(pages[0].startSec).toBe(0);
    expect(pages[0].endSec).toBeCloseTo(0.9);
  });

  it('breaks on sentence terminators once past the target-word threshold', () => {
    // 20 regular words (past target=18), then a period-ending word,
    // then a second sentence of 12 words so the tail is above minBeforeBreak
    // and does not merge back into page 0.
    const words = [
      ...Array.from({ length: 20 }, (_, i) => word(`w${i}`, i * 0.3, i * 0.3 + 0.25)),
      word('fin.', 6.0, 6.3),
      ...Array.from({ length: 12 }, (_, i) => word(`b${i}`, 7 + i * 0.3, 7 + i * 0.3 + 0.25)),
      word('cierre.', 11.0, 11.4),
    ];
    const pages = buildPages(words);
    expect(pages.length).toBeGreaterThanOrEqual(2);
    const lastTokenOfFirst = pages[0].tokens.at(-1);
    expect(lastTokenOfFirst.text).toMatch(/[.!?…]$/);
  });

  it('enforces the hard word-cap even if no sentence break is found', () => {
    const runOn = Array.from({ length: 40 }, (_, i) => word(`palabra${i}`, i * 0.25, i * 0.25 + 0.2));
    const pages = buildPages(runOn, { targetWordsPerPage: 18, maxWordsPerPage: 28, minWordsBeforeBreak: 8 });
    for (const p of pages) expect(p.tokens.length).toBeLessThanOrEqual(28);
    // Expect at least two pages because 40 > 28
    expect(pages.length).toBeGreaterThanOrEqual(2);
  });

  it('merges an orphan tail shorter than minWordsBeforeBreak into the previous page', () => {
    const words = [
      ...Array.from({ length: 22 }, (_, i) => word(`w${i}`, i * 0.3, i * 0.3 + 0.25)),
      word('fin.', 6.6, 6.9),
      // 3-word tail; below the 8-word minimum, should merge
      word('cola', 7.0, 7.3),
      word('corta', 7.3, 7.6),
      word('aquí.', 7.6, 7.9),
    ];
    const pages = buildPages(words, { targetWordsPerPage: 18, maxWordsPerPage: 28, minWordsBeforeBreak: 8 });
    const texts = pages.flatMap(p => p.tokens.map((t: { text: string }) => t.text));
    // Every input word ends up in some page
    expect(texts).toContain('cola');
    expect(texts).toContain('aquí.');
    // The last page should not be a standalone 3-word orphan
    if (pages.length > 1) expect(pages.at(-1).tokens.length).toBeGreaterThanOrEqual(8);
  });
});
