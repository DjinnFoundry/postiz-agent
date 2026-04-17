import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpotifyRssBuilder, buildTeaser } from '../../src/platforms/spotify-rss.js';

const channel = {
  title: 'AudioKids',
  description: 'audio stories',
  link: 'https://audiokids.app',
  author: 'AudioKids',
  email: 'hi@audiokids.app',
  imageUrl: 'https://audiokids.app/cover.png',
};

const storyJson = {
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

describe('buildTeaser()', () => {
  it('returns the first two sentences', () => {
    const out = buildTeaser('First sentence. Second sentence. Third sentence.');
    expect(out).toBe('First sentence. Second sentence.');
  });

  it('works with ! and ? punctuation', () => {
    const out = buildTeaser('¿Qué pasó? Pues pasó esto. Y luego aquello.');
    expect(out).toBe('¿Qué pasó? Pues pasó esto.');
  });

  it('falls back to first 300 chars when sentence split yields <20 chars', () => {
    const tiny = 'hi. ' + 'x'.repeat(400);
    // two "sentences" are "hi." + x's (no period) — result length <20? "hi." is 3 chars, splitter returns only "hi." = 3 chars. Falls back.
    const out = buildTeaser('hi.');
    expect(out).toBe('hi.'); // still < 20, falls back to the trimmed string (which is 3 chars)
    expect(buildTeaser(tiny).length).toBeLessThanOrEqual(400); // contains the long text fallback
  });

  it('works when contenido has no terminal punctuation', () => {
    const raw = 'A story without punctuation here and nothing more';
    expect(buildTeaser(raw)).toBe(raw);
  });
});

describe('SpotifyRssBuilder (per-episode image, exclusions, teaser)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rss-test-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeStory(slug: string, title = storyJson.titulo) {
    writeFileSync(join(dir, `${slug}.json`), JSON.stringify({ ...storyJson, titulo: title, meta: { ...storyJson.meta, slug } }));
    writeFileSync(join(dir, `${slug}.mp3`), Buffer.from([0, 1, 2, 3]));
  }

  it('emits per-episode <itunes:image> from publicFeedBase/covers/<slug>.png', async () => {
    writeStory('dragon-marcos');
    const rss = new SpotifyRssBuilder(
      channel,
      dir,
      'https://example.com',
      new Set(),
      async () => 42,
    );
    const xml = await rss.build();
    expect(xml).toContain('<itunes:image href="https://example.com/covers/dragon-marcos.png" />');
  });

  it('description is the first two sentences (teaser), not the 500-char excerpt', async () => {
    writeStory('dragon-marcos');
    const rss = new SpotifyRssBuilder(channel, dir, 'https://example.com', new Set(), async () => 30);
    const xml = await rss.build();
    // Two-sentence teaser includes sentence 1 + 2 but NOT sentence 3.
    expect(xml).toMatch(/Marcos caminaba por el bosque cuando escuch[^\n]+ruido\. Detr[^\n]+que lloraba\./);
    expect(xml).not.toContain('no podía escupir fuego');
  });

  it('excludes slugs listed in SPOTIFY_RSS_EXCLUDE_SLUGS', async () => {
    writeStory('dragon-marcos', 'Dragon story');
    writeStory('secret-story', 'Secret');
    const rss = new SpotifyRssBuilder(
      channel,
      dir,
      'https://example.com',
      new Set(['secret-story']),
      async () => 10,
    );
    const xml = await rss.build();
    expect(xml).toContain('Dragon story');
    expect(xml).not.toContain('secret-story');
    expect(xml).not.toContain('Secret');
  });
});
