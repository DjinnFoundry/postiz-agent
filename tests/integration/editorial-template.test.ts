import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadCatalog } from '../../src/theme/catalog.js';

const ROOT = resolve(__dirname, '..', '..');
const TEMPLATE = resolve(ROOT, 'hyperframes', 'templates', 'editorial.mjs');

const WORDS = [
  { text: 'Había', start: 0.0, end: 0.3 },
  { text: 'una', start: 0.3, end: 0.45 },
  { text: 'vez', start: 0.45, end: 0.7 },
  { text: 'un', start: 0.7, end: 0.85 },
  { text: 'dragón', start: 0.85, end: 1.3 },
  { text: 'curioso', start: 1.3, end: 2.0 },
];

function runEditorial(payload: unknown): { html: string; stdout: string } {
  const workspace = mkdtempSync(join(tmpdir(), 'editorial-test-'));
  try {
    const result = spawnSync('node', [TEMPLATE], {
      cwd: workspace,
      input: JSON.stringify(payload),
      encoding: 'utf-8',
      timeout: 10_000,
    });
    if (result.status !== 0) {
      throw new Error(`editorial.mjs exited ${result.status}: ${result.stderr}`);
    }
    const html = readFileSync(join(workspace, 'index.html'), 'utf-8');
    return { html, stdout: result.stdout };
  } finally {
    try { rmSync(workspace, { recursive: true, force: true }); } catch { /* noop */ }
  }
}

function payloadFor(
  treatmentId: string,
  aspect: { width: number; height: number },
  extra: Record<string, unknown> = {},
) {
  const catalog = loadCatalog();
  const treatment = catalog.treatments.find(t => t.id === treatmentId)!;
  const palette = catalog.palettes.find(p => p.id === treatment.palettes[0])!;
  const fontPairing = catalog.pairings.find(p => p.id === treatment.fontPairing)!;
  return {
    title: 'El dragón curioso',
    byline: 'Marcos · 6 años',
    words: WORDS,
    audioSrc: 'assets/narration.mp3',
    width: aspect.width,
    height: aspect.height,
    theme: { treatment, palette, fontPairing, source: 'explicit' },
    ...extra,
  };
}

const ASPECTS = [
  { name: 'square-1-1',   width: 1080, height: 1080 },
  { name: 'vertical-9-16', width: 1080, height: 1920 },
  { name: 'landscape-16-9', width: 1920, height: 1080 },
];

describe('editorial.mjs renders every treatment × every aspect', () => {
  const catalog = loadCatalog();
  for (const treatment of catalog.treatments) {
    for (const aspect of ASPECTS) {
      it(`${treatment.id} @ ${aspect.name}`, () => {
        const { html } = runEditorial(payloadFor(treatment.id, aspect));
        expect(html).toContain('<!doctype html>');
        expect(html).toContain(`data-width="${aspect.width}"`);
        expect(html).toContain(`data-height="${aspect.height}"`);
        // Theme markers must be present
        expect(html).toContain(treatment.family);
        // Palette must be applied via CSS variables
        const palette = catalog.palettes.find(p => p.id === treatment.palettes[0])!;
        expect(html).toContain(palette.bg);
        expect(html).toContain(palette.ink);
        // No-small-fonts invariant: body-px should be >= 24 in vertical, >= 32 elsewhere
        const minExpected = aspect.height > aspect.width ? 24 : 32;
        const bodyPxMatch = html.match(/--body-px:\s*(\d+)px/);
        expect(bodyPxMatch).toBeTruthy();
        expect(Number(bodyPxMatch![1])).toBeGreaterThanOrEqual(minExpected);
      });
    }
  }
});

describe('editorial.mjs theme-specific markers', () => {
  it('terminal-crt emits scan lines and prompt glyphs', () => {
    const { html } = runEditorial(payloadFor('terminal-crt', ASPECTS[0]));
    expect(html).toContain('scanlines');
    expect(html).toContain('class="prompt"');
  });

  it('medieval-manuscript uses the illuminated drop cap with border', () => {
    const { html } = runEditorial(payloadFor('medieval-manuscript', ASPECTS[0]));
    expect(html).toContain('drop-cap');
    expect(html).toContain('border: 4px double');
  });

  it('rose-stamp emits a rotating stamp', () => {
    const { html } = runEditorial(payloadFor('rose-stamp', ASPECTS[0]));
    expect(html).toContain('stamp-rotate');
  });

  it('epic-cinematic emits letterbox bars', () => {
    const { html } = runEditorial(payloadFor('epic-cinematic', ASPECTS[0]));
    expect(html).toContain('letterbox-top');
    expect(html).toContain('letterbox-bottom');
  });

  it('bubble-pastel emits floating bubbles', () => {
    const { html } = runEditorial(payloadFor('bubble-pastel', ASPECTS[0]));
    expect(html).toContain('class="bubble"');
  });

  it('academic-dropcap emits a drop cap without border', () => {
    const { html } = runEditorial(payloadFor('academic-dropcap', ASPECTS[0]));
    expect(html).toContain('drop-cap');
    expect(html).not.toContain('border: 4px double');
  });

  it('medieval-manuscript emits SVG corner ornaments with the accent color', () => {
    const catalog = loadCatalog();
    const treatment = catalog.treatments.find(t => t.id === 'medieval-manuscript')!;
    const palette = catalog.palettes.find(p => p.id === treatment.palettes[0])!;
    const { html } = runEditorial(payloadFor('medieval-manuscript', ASPECTS[0]));
    expect(html).toContain('corner-ornament');
    expect(html).toContain('corner-ornament corner-ornament-tl');
    expect(html).toContain('corner-ornament corner-ornament-tr');
    expect(html).toContain('corner-ornament corner-ornament-bl');
    expect(html).toContain('corner-ornament corner-ornament-br');
    expect(html).toContain('<svg');
    expect(html).toContain(palette.accent);
  });

  it('mythic-scroll emits SVG scroll borders with laurel pattern', () => {
    const catalog = loadCatalog();
    const treatment = catalog.treatments.find(t => t.id === 'mythic-scroll')!;
    const palette = catalog.palettes.find(p => p.id === treatment.palettes[0])!;
    const { html } = runEditorial(payloadFor('mythic-scroll', ASPECTS[0]));
    expect(html).toContain('scroll-border');
    expect(html).toContain('scroll-border scroll-border-top');
    expect(html).toContain('scroll-border scroll-border-bottom');
    expect(html).toContain('<pattern');
    expect(html).toContain(palette.accent);
  });

  it('non-ornamental treatments do not emit corner ornaments or scroll borders', () => {
    for (const id of ['hero-display', 'midnight', 'rose-stamp', 'academic-dropcap', 'big-stat', 'storybook-pop', 'crayon-doodle', 'bubble-pastel', 'epic-cinematic', 'terminal-crt']) {
      const { html } = runEditorial(payloadFor(id, ASPECTS[0]));
      expect(html, `treatment=${id}`).not.toContain('corner-ornament');
      expect(html, `treatment=${id}`).not.toContain('scroll-border');
    }
  });
});

describe('editorial.mjs polish: terminal cursor, end-card, reduced motion', () => {
  it('terminal-crt emits a blinking cursor marker at the end of each page', () => {
    const { html } = runEditorial(payloadFor('terminal-crt', ASPECTS[0]));
    expect(html).toContain('terminal-cursor');
    expect(html).toContain('cursor-blink');
  });

  it('non-terminal treatments do not emit the terminal-cursor span', () => {
    for (const id of ['hero-display', 'midnight', 'rose-stamp', 'medieval-manuscript', 'bubble-pastel']) {
      const { html } = runEditorial(payloadFor(id, ASPECTS[0]));
      expect(html, `treatment=${id}`).not.toContain('<span class="terminal-cursor">');
    }
  });

  it('medieval-manuscript end-card says "fin" with crown ornament', () => {
    const { html } = runEditorial(payloadFor('medieval-manuscript', ASPECTS[0]));
    expect(html).toContain('end-card');
    expect(html).toContain('end-card-medieval');
    expect(html).toContain('fin');
  });

  it('mythic-scroll end-card says "·fin·"', () => {
    const { html } = runEditorial(payloadFor('mythic-scroll', ASPECTS[0]));
    expect(html).toContain('end-card-mythic');
    expect(html).toContain('·fin·');
  });

  it('storybook-pop end-card says "colorín colorado"', () => {
    const { html } = runEditorial(payloadFor('storybook-pop', ASPECTS[0]));
    expect(html).toContain('end-card-storybook');
    expect(html).toContain('colorado');
  });

  it('bubble-pastel end-card says "buenas noches" with a heart', () => {
    const { html } = runEditorial(payloadFor('bubble-pastel', ASPECTS[0]));
    expect(html).toContain('end-card-bubble');
    expect(html).toContain('buenas noches');
  });

  it('terminal-crt end-card says "> EOF" with cursor', () => {
    const { html } = runEditorial(payloadFor('terminal-crt', ASPECTS[0]));
    expect(html).toContain('end-card-terminal');
    expect(html).toContain('EOF');
  });

  it('default treatments use the audiokids brand end-card', () => {
    const { html } = runEditorial(payloadFor('hero-display', ASPECTS[0]));
    expect(html).toContain('end-card-default');
    expect(html).toContain('audiokids');
  });

  it('end-card is a clip scheduled in the last TAIL_SEC of the render', () => {
    const { html } = runEditorial(payloadFor('medieval-manuscript', ASPECTS[0]));
    const match = html.match(/class="clip end-card[^"]*"[^>]*data-start="([0-9.]+)"[^>]*data-duration="([0-9.]+)"/);
    expect(match).toBeTruthy();
    const start = Number(match![1]);
    const duration = Number(match![2]);
    expect(duration).toBeCloseTo(1.5, 2);
    expect(start).toBeGreaterThan(0);
  });

  it('old always-on brand bar is no longer rendered', () => {
    const { html } = runEditorial(payloadFor('hero-display', ASPECTS[0]));
    expect(html).not.toMatch(/<div class="clip brand"[^>]*>audiokids · cuentos a medida<\/div>/);
  });

  it('CSS includes prefers-reduced-motion guard', () => {
    const { html } = runEditorial(payloadFor('bubble-pastel', ASPECTS[0]));
    expect(html).toContain('prefers-reduced-motion: reduce');
  });

  it('rose-stamp CSS includes prefers-reduced-motion guard', () => {
    const { html } = runEditorial(payloadFor('rose-stamp', ASPECTS[0]));
    expect(html).toContain('prefers-reduced-motion: reduce');
  });
});

describe('editorial.mjs part-ribbon styling by treatment', () => {
  const multipart = { partIndex: 1, partTotal: 3 };

  it('medieval-manuscript multipart emits roman-numeral chapter ribbon', () => {
    const { html } = runEditorial(payloadFor('medieval-manuscript', ASPECTS[0], multipart));
    expect(html).toContain('part-ribbon-medieval');
    expect(html).toContain('CAPÍTULO I de III');
  });

  it('terminal-crt multipart emits monospace bracketed ribbon', () => {
    const { html } = runEditorial(payloadFor('terminal-crt', ASPECTS[0], multipart));
    expect(html).toContain('part-ribbon-terminal');
    expect(html).toContain('[PART 01/03]');
  });

  it('epic-cinematic multipart emits roman caps with middot separator', () => {
    const { html } = runEditorial(payloadFor('epic-cinematic', ASPECTS[0], multipart));
    expect(html).toContain('part-ribbon-epic');
    expect(html).toContain('PARTE I · III');
  });

  it('storybook-pop multipart emits rounded pop ribbon', () => {
    const { html } = runEditorial(payloadFor('storybook-pop', ASPECTS[0], multipart));
    expect(html).toContain('part-ribbon-pop');
    expect(html).toContain('Parte 1 / 3');
  });

  it('crayon-doodle multipart emits rounded pop ribbon', () => {
    const { html } = runEditorial(payloadFor('crayon-doodle', ASPECTS[0], multipart));
    expect(html).toContain('part-ribbon-pop');
    expect(html).toContain('Parte 1 / 3');
  });

  it('mythic-scroll multipart emits italic scroll ribbon with adornments', () => {
    const { html } = runEditorial(payloadFor('mythic-scroll', ASPECTS[0], multipart));
    expect(html).toContain('part-ribbon-scroll');
    expect(html).toContain('~ parte 1 de 3 ~');
  });

  it('hero-display multipart falls back to default pill ribbon', () => {
    const { html } = runEditorial(payloadFor('hero-display', ASPECTS[0], multipart));
    expect(html).toContain('<div class="part-ribbon">');
    expect(html).toContain('PARTE 1 / 3');
    expect(html).not.toContain('<div class="part-ribbon part-ribbon-medieval">');
    expect(html).not.toContain('<div class="part-ribbon part-ribbon-terminal">');
    expect(html).not.toContain('<div class="part-ribbon part-ribbon-epic">');
    expect(html).not.toContain('<div class="part-ribbon part-ribbon-pop">');
    expect(html).not.toContain('<div class="part-ribbon part-ribbon-scroll">');
  });

  it('single-part payload emits no ribbon markup in any treatment', () => {
    const { html } = runEditorial(payloadFor('medieval-manuscript', ASPECTS[0]));
    expect(html).not.toMatch(/<div class="part-ribbon[^"]*">/);
  });
});

describe('editorial.mjs word highlighting weight + scale shift', () => {
  it('CSS defines an .w.active rule with bolder weight and slight scale', () => {
    const { html } = runEditorial(payloadFor('hero-display', ASPECTS[0]));
    expect(html).toMatch(/\.w\.active\s*{[^}]*font-weight:\s*700/);
    expect(html).toMatch(/\.w\.active\s*{[^}]*scale\(1\.05\)/);
  });

  it('GSAP timeline toggles the active class on word spans', () => {
    const { html } = runEditorial(payloadFor('hero-display', ASPECTS[0]));
    expect(html).toMatch(/tl\.set\("#page-\d+ \[data-word='\d+'\]", \{ className: "\+=active" \}/);
    expect(html).toMatch(/tl\.set\("#page-\d+ \[data-word='\d+'\]", \{ className: "-=active" \}/);
  });
});
