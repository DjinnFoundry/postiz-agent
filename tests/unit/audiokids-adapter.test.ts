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

const FIXTURE_DIR_V2 = resolve(__dirname, '../fixtures/audiokids-output-v2');
const V2_SLUG = 'mati-museo-sample-2026-05-01T10-00-00-000Z';

describe('AudioKidsAdapter.loadBundle (v2 subdir layout)', () => {
  const adapter = new AudioKidsAdapter(FIXTURE_DIR_V2);

  it('produces a schema-valid ContentBundle from the v2 layout', () => {
    const bundle = adapter.loadBundle(V2_SLUG);
    expect(() => ContentBundleSchema.parse(bundle)).not.toThrow();
  });

  it('maps v2 story.{title,content} into bundle.text and job.{locale,mood} into top-level fields', () => {
    const b = adapter.loadBundle(V2_SLUG);
    expect(b.id).toBe(V2_SLUG);
    expect(b.kind).toBe('audio-story');
    expect(b.text.title).toBe('La estrella que no quería esconderse');
    expect(b.text.body).toMatch(/Mati apretó la nariz contra el cristal/);
    expect(b.locale).toBe('es-ES');
    expect(b.theme?.mood).toBe('aventura');
    expect(b.primaryMedia).toMatch(new RegExp(`${V2_SLUG}\\.mp3$`));
  });

  it('derives recipient from job.childName + job.childAge with first-name-only consent', () => {
    const b = adapter.loadBundle(V2_SLUG);
    expect(b.recipient).toBeDefined();
    expect(b.recipient?.name).toBe('Mati');
    expect(b.recipient?.age).toBe(8);
    expect(b.recipient?.shareConsent).toBe('first-name-only');
    expect(b.recipient?.interests).toContain('museos');
  });

  it('passes v2 beats through (with new anchorWord/delivery fields tolerated)', () => {
    const b = adapter.loadBundle(V2_SLUG);
    expect(b.beats?.length).toBe(2);
    expect(b.beats?.[0].type).toBe('intro');
  });

  it('derives wordCount and sentenceCount from story.content (downstream back-compat)', () => {
    const b = adapter.loadBundle(V2_SLUG);
    expect(typeof b.sourceMeta?.wordCount).toBe('number');
    expect((b.sourceMeta?.wordCount as number) ?? 0).toBeGreaterThan(20);
    expect(typeof b.sourceMeta?.sentenceCount).toBe('number');
    expect((b.sourceMeta?.sentenceCount as number) ?? 0).toBeGreaterThanOrEqual(3);
  });

  it('preserves vocabulary as vocabularioNuevo for caption builder back-compat', () => {
    const b = adapter.loadBundle(V2_SLUG);
    expect(b.sourceMeta?.vocabularioNuevo).toEqual(['constelación', 'rotación', 'sureste']);
  });

  it('uses job.targetDurationMin when present for estimatedDurationMin', () => {
    const b = adapter.loadBundle(V2_SLUG);
    expect(b.sourceMeta?.estimatedDurationMin).toBe(5);
  });

  it('parses generatedAt back from the slug timestamp suffix', () => {
    const b = adapter.loadBundle(V2_SLUG);
    expect(b.sourceMeta?.generatedAt).toBe('2026-05-01T10:00:00.000Z');
  });

  it('marks sourceMeta.schemaVersion=v2 so future tools can branch on it', () => {
    const b = adapter.loadBundle(V2_SLUG);
    expect(b.sourceMeta?.schemaVersion).toBe('v2');
  });

  it('throws a clear error when slug does not exist in either layout', () => {
    expect(() => adapter.loadBundle('does-not-exist')).toThrowError(/v2.*v1/s);
  });

  it('throws when v2 dir has story.json but no .mp3 inside', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audiokids-v2-no-audio-'));
    try {
      const slug = 'broken-no-audio-2026-05-02T10-00-00-000Z';
      const storyDir = join(dir, slug);
      mkdirSync(storyDir, { recursive: true });
      writeFileSync(join(storyDir, 'story.json'), JSON.stringify({
        slug,
        job: { childName: 'Lia', childAge: 6, locale: 'es-ES', mood: 'fantasia' },
        story: { title: 'Sin audio', content: 'Texto.', vocabulary: [] },
      }));
      const adapter = new AudioKidsAdapter(dir);
      expect(() => adapter.loadBundle(slug)).toThrowError(/no \.mp3 inside/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('omits recipient when v2 childName is missing or null (e.g. anonymous test stories)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audiokids-v2-noname-'));
    try {
      const slug = 'anon-story-2026-05-02T11-00-00-000Z';
      const storyDir = join(dir, slug);
      mkdirSync(storyDir, { recursive: true });
      writeFileSync(join(storyDir, 'story.json'), JSON.stringify({
        slug,
        job: { childName: null, childAge: null, locale: 'es-ES', mood: 'fantasia' },
        story: { title: 'Anónima', content: 'Texto neutro sin destinatario.', vocabulary: [] },
      }));
      writeFileSync(join(storyDir, `${slug}.mp3`), Buffer.from([0x49, 0x44, 0x33]));
      const adapter = new AudioKidsAdapter(dir);
      const b = adapter.loadBundle(slug);
      expect(b.recipient).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('AudioKidsAdapter.listCandidates (mixed v1 + v2)', () => {
  it('lists v2 stories from a v2-only directory', () => {
    const adapter = new AudioKidsAdapter(FIXTURE_DIR_V2);
    const candidates = adapter.listCandidates();
    expect(candidates.length).toBe(1);
    expect(candidates[0].slug).toBe(V2_SLUG);
    expect(candidates[0].generatedAt).toBe('2026-05-01T10:00:00.000Z');
  });

  it('lists both v1 and v2 stories from a mixed directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audiokids-mixed-'));
    try {
      // v1 entry
      const v1Slug = 'legacy-flat';
      writeFileSync(join(dir, `${v1Slug}.json`), JSON.stringify({
        titulo: 'Flat', contenido: 'Body.', vocabularioNuevo: [], mood: 'fantasia',
        meta: {
          slug: v1Slug, age: 5, mood: 'fantasia', locale: 'es-ES', name: 'Ana',
          nivel: 1, model: 'test', wordCount: 1, sentenceCount: 1, estimatedDurationMin: 0.1,
        },
      }));
      writeFileSync(join(dir, `${v1Slug}.mp3`), Buffer.from([0x49, 0x44, 0x33]));
      // v2 entry
      const v2Slug = 'subdir-2026-05-02T12-00-00-000Z';
      const v2Dir = join(dir, v2Slug);
      mkdirSync(v2Dir, { recursive: true });
      writeFileSync(join(v2Dir, 'story.json'), JSON.stringify({
        slug: v2Slug,
        job: { childName: 'Leo', childAge: 7, locale: 'es-ES', mood: 'aventura' },
        story: { title: 'Sub', content: 'Body.', vocabulary: [] },
      }));
      writeFileSync(join(v2Dir, `${v2Slug}.mp3`), Buffer.from([0x49, 0x44, 0x33]));

      const adapter = new AudioKidsAdapter(dir);
      const candidates = adapter.listCandidates();
      const slugs = candidates.map(c => c.slug).sort();
      expect(slugs).toEqual([v1Slug, v2Slug].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips v2 directories that lack story.json (e.g. an in-progress run)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audiokids-partial-'));
    try {
      const slug = 'in-progress-2026-05-02T13-00-00-000Z';
      mkdirSync(join(dir, slug, 'chunks'), { recursive: true });
      const adapter = new AudioKidsAdapter(dir);
      expect(adapter.listCandidates()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
