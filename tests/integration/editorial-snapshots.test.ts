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

const ASPECTS = [
  { name: 'square-1-1',     width: 1080, height: 1080 },
  { name: 'vertical-9-16',  width: 1080, height: 1920 },
  { name: 'landscape-16-9', width: 1920, height: 1080 },
];

function runEditorial(payload: unknown): string {
  const workspace = mkdtempSync(join(tmpdir(), 'editorial-snapshot-'));
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
    return readFileSync(join(workspace, 'index.html'), 'utf-8');
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

function normaliseHtml(html: string): string {
  return html
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd() + '\n';
}

describe('editorial.mjs HTML snapshot regression (treatment × aspect)', () => {
  const catalog = loadCatalog();
  for (const treatment of catalog.treatments) {
    for (const aspect of ASPECTS) {
      it(`${treatment.id} @ ${aspect.name}`, () => {
        const html = normaliseHtml(runEditorial(payloadFor(treatment.id, aspect)));
        expect(html).toMatchSnapshot();
      });
    }
  }
});
