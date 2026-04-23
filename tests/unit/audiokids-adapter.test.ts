import { describe, it, expect, afterEach } from 'vitest';
import { resolve, join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { AudioKidsAdapter } from '../../src/adapters/audiokids.js';
import { ContentBundleSchema, resolveTagline } from '../../src/core/content-bundle.js';

const FIXTURE_DIR = resolve(__dirname, '../fixtures/audiokids-output');

describe('AudioKidsAdapter.loadBundle', () => {
  const adapter = new AudioKidsAdapter(FIXTURE_DIR);

  it('produces a schema-valid ContentBundle', () => {
    const bundle = adapter.loadBundle('dragon-marcos');
    expect(() => ContentBundleSchema.parse(bundle)).not.toThrow();
  });

  it('maps core AudioKids fields into bundle fields (not sourceMeta)', () => {
    const b = adapter.loadBundle('dragon-marcos');
    expect(b.id).toBe('dragon-marcos');
    expect(b.kind).toBe('audio-story');
    expect(b.text.title).toBe('El dragón curioso');
    expect(b.text.body).toMatch(/Marcos caminaba por el bosque/);
    expect(b.locale).toBe('es-ES');
    expect(b.theme?.mood).toBe('fantasia');
    expect(b.primaryMedia).toMatch(/dragon-marcos\.mp3$/);
    expect(b.cover).toMatch(/dragon-marcos(-cover)?\.png$/);
  });

  it('derives recipient from AudioKids meta.name + meta.age with first-name-only consent', () => {
    const b = adapter.loadBundle('dragon-marcos');
    expect(b.recipient).toBeDefined();
    expect(b.recipient?.name).toBe('Marcos');
    expect(b.recipient?.age).toBe(6);
    expect(b.recipient?.shareConsent).toBe('first-name-only');
  });

  it('preserves beats for multi-part splitting', () => {
    const b = adapter.loadBundle('dragon-marcos');
    expect(b.beats?.length).toBe(5);
    expect(b.beats?.[0].type).toBe('intro');
  });

  it('keeps AudioKids-specific fields in sourceMeta as escape hatch', () => {
    const b = adapter.loadBundle('dragon-marcos');
    expect(b.sourceMeta?.wordCount).toBe(145);
    expect(b.sourceMeta?.estimatedDurationMin).toBe(1.0);
  });

  it('resolveTagline respects first-name-only consent', () => {
    const b = adapter.loadBundle('dragon-marcos');
    const tagline = resolveTagline(b);
    expect(tagline).toBe('Marcos · 6 años');
  });

  it('throws a clear error when slug does not exist', () => {
    expect(() => adapter.loadBundle('does-not-exist')).toThrowError(/metadata not found/);
  });
});

describe('AudioKidsAdapter.loadBundle cover handling (optional)', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    while (tmpDirs.length) {
      const d = tmpDirs.pop();
      if (d && existsSync(d)) rmSync(d, { recursive: true, force: true });
    }
  });

  function buildCoverlessFixture(): { dir: string; slug: string } {
    const dir = mkdtempSync(join(tmpdir(), 'audiokids-adapter-'));
    tmpDirs.push(dir);
    const slug = 'sin-cover';
    const story = {
      titulo: 'Un cuento sin portada',
      contenido: 'Había una vez un cuento sin imagen de portada, pero con mucha imaginación.',
      vocabularioNuevo: [],
      mood: 'fantasia',
      meta: {
        slug,
        age: 5,
        mood: 'fantasia',
        locale: 'es-ES',
        name: 'Lucia',
        nivel: 1,
        model: 'test',
        wordCount: 12,
        sentenceCount: 1,
        avgSentenceLength: 12,
        estimatedDurationMin: 0.2,
      },
    };
    writeFileSync(join(dir, `${slug}.json`), JSON.stringify(story));
    writeFileSync(join(dir, `${slug}.mp3`), Buffer.from([0x49, 0x44, 0x33]));
    return { dir, slug };
  }

  it('returns a bundle WITHOUT cover when all candidates miss, instead of throwing', () => {
    const { dir, slug } = buildCoverlessFixture();
    const adapter = new AudioKidsAdapter(dir);
    const bundle = adapter.loadBundle(slug);
    expect(bundle.cover).toBeUndefined();
    expect(bundle.text.title).toBe('Un cuento sin portada');
    expect(() => ContentBundleSchema.parse(bundle)).not.toThrow();
  });

  it('placeholder NOT generated when flag is false (default)', () => {
    const { dir, slug } = buildCoverlessFixture();
    const adapter = new AudioKidsAdapter(dir);
    const bundle = adapter.loadBundle(slug);
    expect(bundle.cover).toBeUndefined();
    const expectedSvg = resolve(__dirname, '../..', 'data', 'covers', `${slug}.svg`);
    expect(existsSync(expectedSvg)).toBe(false);
  });

  it('placeholder generation produces an SVG when enabled', () => {
    const { dir, slug } = buildCoverlessFixture();
    const placeholderDir = mkdtempSync(join(tmpdir(), 'audiokids-covers-'));
    tmpDirs.push(placeholderDir);
    const adapter = new AudioKidsAdapter(dir, { generatePlaceholder: true, placeholderDir });
    const bundle = adapter.loadBundle(slug);
    expect(bundle.cover).toBeDefined();
    expect(bundle.cover).toMatch(/\.svg$/);
    expect(existsSync(bundle.cover!)).toBe(true);
    const svg = readFileSync(bundle.cover!, 'utf-8');
    expect(svg).toMatch(/Un cuento sin/);
    expect(svg).toMatch(/portada/);
    expect(svg).toMatch(/width="1080"/);
    expect(svg).toMatch(/height="1080"/);
  });

  it('still finds real cover next to the json when present (fixture path)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audiokids-adapter-real-'));
    tmpDirs.push(dir);
    const slug = 'con-cover';
    const story = {
      titulo: 'Con portada',
      contenido: 'Texto mínimo para validar el cuento con portada.',
      vocabularioNuevo: [],
      mood: 'aventura',
      meta: {
        slug, age: 5, mood: 'aventura', locale: 'es-ES', name: 'Leo', nivel: 1,
        model: 'test', wordCount: 8, sentenceCount: 1, avgSentenceLength: 8,
        estimatedDurationMin: 0.1,
      },
    };
    writeFileSync(join(dir, `${slug}.json`), JSON.stringify(story));
    writeFileSync(join(dir, `${slug}.mp3`), Buffer.from([0x49, 0x44, 0x33]));
    const fixtureCover = resolve(__dirname, '../fixtures/audiokids-output/dragon-marcos-cover.png');
    copyFileSync(fixtureCover, join(dir, `${slug}-cover.png`));
    const adapter = new AudioKidsAdapter(dir);
    const bundle = adapter.loadBundle(slug);
    expect(bundle.cover).toMatch(/con-cover-cover\.png$/);
  });
});

describe('generateCoverSvg (cover placeholder)', () => {
  it('produces a 1080x1080 SVG with the title embedded', async () => {
    const { generateCoverSvg } = await import('../../src/adapters/cover-placeholder.js');
    const svg = generateCoverSvg({ slug: 'abc', title: 'Hola Mundo', mood: 'fantasia' });
    expect(svg).toMatch(/<svg[^>]*width="1080"/);
    expect(svg).toMatch(/height="1080"/);
    expect(svg).toMatch(/Hola Mundo/);
    expect(svg).toMatch(/#F1E8D8/);
  });

  it('falls back to default palette for unknown mood', async () => {
    const { generateCoverSvg } = await import('../../src/adapters/cover-placeholder.js');
    const svg = generateCoverSvg({ slug: 'x', title: 'T', mood: 'mood-inexistente' });
    expect(svg).toMatch(/#F5ECDB/);
  });

  it('escapes XML-sensitive characters in title', async () => {
    const { generateCoverSvg } = await import('../../src/adapters/cover-placeholder.js');
    const svg = generateCoverSvg({ slug: 'x', title: 'A & B <C>', mood: 'calma' });
    expect(svg).toMatch(/A &amp; B &lt;C&gt;/);
    expect(svg).not.toMatch(/A & B <C>/);
  });
});

describe('AudioKidsAdapter.listCandidates', () => {
  const adapter = new AudioKidsAdapter(FIXTURE_DIR);

  it('lists every story with a matching .json + .mp3 pair', () => {
    const candidates = adapter.listCandidates();
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    const marcos = candidates.find(c => c.slug === 'dragon-marcos');
    expect(marcos).toBeDefined();
    expect(typeof marcos!.mtimeMs).toBe('number');
  });
});

describe('resolveTagline', () => {
  it('returns undefined when no recipient and no explicit tagline', () => {
    const b = {
      id: 't', kind: 'text' as const, text: { body: 'x' }, locale: 'es',
    };
    expect(resolveTagline(b as never)).toBeUndefined();
  });

  it('returns explicit tagline verbatim when present', () => {
    const b = {
      id: 't', kind: 'text' as const, text: { body: 'x', tagline: 'custom' }, locale: 'es',
    };
    expect(resolveTagline(b as never)).toBe('custom');
  });

  it('respects anonymous consent by hiding the name', () => {
    const b = {
      id: 't', kind: 'text' as const, text: { body: 'x' }, locale: 'es',
      recipient: { name: 'Ana', age: 5, shareConsent: 'anonymous' as const },
    };
    expect(resolveTagline(b as never)).toBe('para un niño de 5 años');
  });

  it('uses first name only when consent is first-name-only', () => {
    const b = {
      id: 't', kind: 'text' as const, text: { body: 'x' }, locale: 'es',
      recipient: { name: 'Ana María García', age: 7, shareConsent: 'first-name-only' as const },
    };
    expect(resolveTagline(b as never)).toBe('Ana · 7 años');
  });
});
