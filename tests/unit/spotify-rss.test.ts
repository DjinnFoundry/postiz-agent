import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { SpotifyRssBuilder } from '../../src/platforms/spotify-rss.js';

const fixtureDir = resolve(__dirname, '..', 'fixtures', 'audiokids-output');

const channel = {
  title: 'AudioKids',
  description: 'Audiocuentos para niños',
  link: 'https://audiokids.app',
  author: 'AudioKids',
  email: 'hello@audiokids.app',
  imageUrl: 'https://audiokids.app/cover.png',
};

describe('SpotifyRssBuilder', () => {
  it('renders a valid iTunes feed with the fixture story', async () => {
    const builder = new SpotifyRssBuilder(channel, fixtureDir, 'https://example.com');
    const xml = await builder.build();
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<rss version="2.0"');
    expect(xml).toContain('<title>AudioKids</title>');
    expect(xml).toContain('<itunes:email>hello@audiokids.app</itunes:email>');
    // Our fixture story should be in there
    expect(xml).toContain('El dragón curioso');
    // Enclosure URL is derived from the public feed base + slug
    expect(xml).toContain('https://example.com/audio/dragon-marcos.mp3');
  });

  it('escapes XML-special characters in story fields', async () => {
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
