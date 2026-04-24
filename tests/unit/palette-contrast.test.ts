import { describe, it, expect } from 'vitest';
import { loadCatalog } from '../../src/theme/catalog.js';
import { contrastRatio } from '../../src/lib/color.js';

const CATALOG = loadCatalog();

const INK_BG_MIN = 4.5;
const MUTED_BG_MIN = 3.0;
const ACCENT_BG_MIN = 3.0;

describe('palette contrast (WCAG)', () => {
  it('has palettes to check', () => {
    expect(CATALOG.palettes.length).toBeGreaterThan(0);
  });

  for (const palette of CATALOG.palettes) {
    describe(`palette ${palette.id}`, () => {
      it(`ink/bg ratio >= ${INK_BG_MIN} (AA normal text)`, () => {
        const ratio = contrastRatio(palette.ink, palette.bg);
        expect(
          ratio,
          `palette "${palette.id}": ink=${palette.ink} bg=${palette.bg} ratio=${ratio.toFixed(2)} (min ${INK_BG_MIN})`,
        ).toBeGreaterThanOrEqual(INK_BG_MIN);
      });

      it(`muted/bg ratio >= ${MUTED_BG_MIN} (AA large / UI secondary)`, () => {
        const ratio = contrastRatio(palette.muted, palette.bg);
        expect(
          ratio,
          `palette "${palette.id}": muted=${palette.muted} bg=${palette.bg} ratio=${ratio.toFixed(2)} (min ${MUTED_BG_MIN})`,
        ).toBeGreaterThanOrEqual(MUTED_BG_MIN);
      });

      it(`accent/bg ratio >= ${ACCENT_BG_MIN} (UI component)`, () => {
        const ratio = contrastRatio(palette.accent, palette.bg);
        expect(
          ratio,
          `palette "${palette.id}": accent=${palette.accent} bg=${palette.bg} ratio=${ratio.toFixed(2)} (min ${ACCENT_BG_MIN})`,
        ).toBeGreaterThanOrEqual(ACCENT_BG_MIN);
      });
    });
  }
});
