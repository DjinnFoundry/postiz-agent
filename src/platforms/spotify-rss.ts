import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { probeDurationSec } from '../lib/ffprobe.js';
import { StorySchema, type Story } from '../types.js';

export interface PodcastChannelMeta {
  title: string;
  description: string;
  link: string;
  author: string;
  email: string;
  imageUrl: string;
  language?: string;
  category?: string;
  explicit?: boolean;
}

export interface EpisodeItem {
  slug: string;
  title: string;
  description: string;
  audioUrl: string;
  durationSec: number;
  pubDate: string;
  mp3SizeBytes: number;
}

export class SpotifyRssBuilder {
  constructor(
    private readonly channel: PodcastChannelMeta,
    private readonly audiokidsDir: string = config.audiokids.outputDir,
    private readonly publicFeedBase: string = config.spotify.publicFeedUrl.replace(/\/feed\.xml$/, ''),
  ) {}

  async build(): Promise<string> {
    const episodes = await this.collectEpisodes();
    episodes.sort((a, b) => b.pubDate.localeCompare(a.pubDate));
    return this.renderXml(episodes);
  }

  private async collectEpisodes(): Promise<EpisodeItem[]> {
    if (!existsSync(this.audiokidsDir)) return [];
    const files = readdirSync(this.audiokidsDir).filter(f => f.endsWith('.json') && !f.startsWith('.'));
    const episodes: EpisodeItem[] = [];

    for (const jsonFile of files) {
      const slug = jsonFile.replace(/\.json$/, '');
      const mp3Path = join(this.audiokidsDir, `${slug}.mp3`);
      if (!existsSync(mp3Path)) continue;

      const raw = JSON.parse(readFileSync(join(this.audiokidsDir, jsonFile), 'utf-8'));
      let story: Story;
      try { story = StorySchema.parse(raw); } catch { continue; }

      const stat = statSync(mp3Path);
      const duration = await probeDurationSec(mp3Path);

      episodes.push({
        slug,
        title: story.titulo,
        description: story.contenido.slice(0, 500),
        audioUrl: `${this.publicFeedBase}/audio/${slug}.mp3`,
        durationSec: Math.round(duration),
        pubDate: new Date(stat.mtimeMs).toUTCString(),
        mp3SizeBytes: stat.size,
      });
    }
    return episodes;
  }

  private renderXml(episodes: EpisodeItem[]): string {
    const items = episodes.map(e => this.renderItem(e)).join('\n');
    const lang = this.channel.language ?? 'es-ES';
    const cat = this.channel.category ?? 'Kids &amp; Family';
    const exp = this.channel.explicit ? 'true' : 'false';
    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
     xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
     xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${esc(this.channel.title)}</title>
    <description>${esc(this.channel.description)}</description>
    <link>${esc(this.channel.link)}</link>
    <language>${lang}</language>
    <itunes:author>${esc(this.channel.author)}</itunes:author>
    <itunes:summary>${esc(this.channel.description)}</itunes:summary>
    <itunes:owner>
      <itunes:name>${esc(this.channel.author)}</itunes:name>
      <itunes:email>${esc(this.channel.email)}</itunes:email>
    </itunes:owner>
    <itunes:image href="${esc(this.channel.imageUrl)}" />
    <itunes:category text="${cat}" />
    <itunes:explicit>${exp}</itunes:explicit>
${items}
  </channel>
</rss>`;
  }

  private renderItem(e: EpisodeItem): string {
    return `    <item>
      <title>${esc(e.title)}</title>
      <description>${esc(e.description)}</description>
      <enclosure url="${esc(e.audioUrl)}" length="${e.mp3SizeBytes}" type="audio/mpeg" />
      <guid isPermaLink="false">${e.slug}</guid>
      <pubDate>${e.pubDate}</pubDate>
      <itunes:duration>${e.durationSec}</itunes:duration>
      <itunes:explicit>false</itunes:explicit>
    </item>`;
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

