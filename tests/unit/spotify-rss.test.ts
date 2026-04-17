import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { SpotifyRssBuilder, buildTeaser } from '../../src/platforms/spotify-rss.js';

const fixtureDir = resolve(__dirname, '..', 'fixtures', 'audiokids-output');

const channel = {
  title: 'AudioKids',
  description: 'Audiocuentos para niños',
  link: 'https://audiokids.app',
  author: 'AudioKids',
  email: 'hello@audiokids.app',
  imageUrl: 'https://audiokids.app/cover.png',
};

// ─── buildTeaser (pure) ─────────────────────────────────────────────────────
describe('buildTeaser()', () => {
  it('returns the first two sentences', () => {
    expect(buildTeaser('First sentence. Second sentence. Third sentence.'))
      .toBe('First sentence. Second sentence.');
  });

  it('handles ? and ! punctuation', () => {
    expect(buildTeaser('¿Qué pasó? Pues pasó esto. Y luego aquello.'))
      .toBe('¿Qué pasó? Pues pasó esto.');
  });

  it('falls back to first 300 chars when the sentence split is too short', () => {
    // Single-char "sentence" will fall below the 20-char threshold → fallback to whole string (<300 chars)
    expect(buildTeaser('hi.')).toBe('hi.');
    const long = 'a. ' + 'x'.repeat(400);
    expect(buildTeaser(long).length).toBeLessThanOrEqual(400);
  });

  it('works when contenido has no terminal punctuation', () => {
    const raw = 'A story without punctuation here and nothing more';
    expect(buildTeaser(raw)).toBe(raw);
  });
});

// ─── SpotifyRssBuilder against the checked-in fixture ───────────────────────
describe('SpotifyRssBuilder (against tests/fixtures/audiokids-output)', () => {
  it('renders a valid iTunes feed for the fixture story', async () => {
    const builder = new SpotifyRssBuilder(channel, fixtureDir, 'https://example.com');
    const xml = await builder.build();
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<rss version="2.0"');
    expect(xml).toContain('<title>AudioKids</title>');
    expect(xml).toContain('<itunes:email>hello@audiokids.app</itunes:email>');
    expect(xml).toContain('El dragón curioso');
    expect(xml).toContain('https://example.com/audio/dragon-marcos.mp3');
  });

  it('escapes XML-special characters in channel fields', async () => {
    const builder = new SpotifyRssBuilder(
      { ...channel, title: 'Kids & Tales <podcast>' },
      fixtureDir,
      'https://example.com',
    );
    const xml = await builder.build();
    expect(xml).toContain('Kids &amp; Tales &lt;podcast&gt;');
    expect(xml).not.toContain('Kids & Tales <podcast>');
  });

  it('returns a feed shell with no items when the audiokids dir does not exist', async () => {
    const builder = new SpotifyRssBuilder(channel, '/this/path/does/not/exist', 'https://example.com');
    const xml = await builder.build();
    expect(xml).toContain('<rss');
    expect(xml).not.toContain('<item>');
  });
});

// ─── Features sprint additions (per-episode image, teaser, exclusions) ──────
const storyJsonBase = {
  titulo: 'El dragón curioso',
  contenido:
    'Marcos caminaba por el bosque cuando escuchó un ruido. Detrás de un árbol, encontró a un pequeño dragón que lloraba. El dragón no podía escupir fuego y estaba muy triste.',
  mood: 'fantasia',
  meta: {
    slug: 'dragon-marcos',
    age: 6,
    mood: 'fantasia',
    locale: 'es-ES',
    name: 'Marcos',
    nivel: 2,
    model: 'glm-5',
    wordCount: 30,
    sentenceCount: 3,
    estimatedDurationMin: 1,
  },
};

describe('SpotifyRssBuilder (per-episode image, exclusions, teaser)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rss-test-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function writeStory(slug: string, title = storyJsonBase.titulo) {
    writeFileSync(
      join(dir, `${slug}.json`),
      JSON.stringify({ ...storyJsonBase, titulo: title, meta: { ...storyJsonBase.meta, slug } }),
    );
    writeFileSync(join(dir, `${slug}.mp3`), Buffer.from([0, 1, 2, 3]));
  }

  it('emits per-episode <itunes:image> from publicFeedBase/covers/<slug>.png', async () => {
    writeStory('dragon-marcos');
    const rss = new SpotifyRssBuilder(channel, dir, 'https://example.com', new Set(), async () => 42);
    const xml = await rss.build();
    expect(xml).toContain('<itunes:image href="https://example.com/covers/dragon-marcos.png" />');
  });

  it('uses a 2-sentence teaser for <description>, not a 500-char excerpt', async () => {
    writeStory('dragon-marcos');
    const rss = new SpotifyRssBuilder(channel, dir, 'https://example.com', new Set(), async () => 30);
    const xml = await rss.build();
    expect(xml).toMatch(/Marcos caminaba por el bosque cuando escuch[^\n]+ruido\. Detr[^\n]+que lloraba\./);
    expect(xml).not.toContain('no podía escupir fuego');
  });

  it('excludes slugs listed in SPOTIFY_RSS_EXCLUDE_SLUGS', async () => {
    writeStory('dragon-marcos', 'Dragon story');
    writeStory('secret-story', 'Secret');
    const rss = new SpotifyRssBuilder(channel, dir, 'https://example.com', new Set(['secret-story']), async () => 10);
    const xml = await rss.build();
    expect(xml).toContain('Dragon story');
    expect(xml).not.toContain('secret-story');
    expect(xml).not.toContain('Secret');
  });
});
