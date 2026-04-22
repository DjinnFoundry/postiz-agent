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

function payloadFor(treatmentId: string, aspect: { width: number; height: number }) {
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
});
