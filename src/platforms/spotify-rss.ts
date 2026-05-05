import { existsSync, statSync } from 'node:fs';
import { config } from '../config.js';
import { probeDurationSec } from '../lib/ffprobe.js';
import { AudioKidsAdapter } from '../adapters/audiokids.js';

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
  imageUrl: string;
  durationSec: number;
  pubDate: string;
  mp3SizeBytes: number;
}

export class SpotifyRssBuilder {
  constructor(
    private readonly channel: PodcastChannelMeta,
    private readonly audiokidsDir: string = config.audiokids.outputDir,
    private readonly publicFeedBase: string = config.spotify.publicFeedUrl.replace(/\/feed\.xml$/, ''),
    private readonly excludeSlugs: Set<string> = parseExcludes(process.env.SPOTIFY_RSS_EXCLUDE_SLUGS),
    private readonly probeDuration: (mp3Path: string) => Promise<number> = probeDurationSec,
  ) {}

  async build(): Promise<string> {
    const episodes = await this.collectEpisodes();
    episodes.sort((a, b) => b.pubDate.localeCompare(a.pubDate));
    return this.renderXml(episodes);
  }

  private async collectEpisodes(): Promise<EpisodeItem[]> {
    if (!existsSync(this.audiokidsDir)) return [];
    const adapter = new AudioKidsAdapter(this.audiokidsDir);
    const candidates = adapter.listCandidates();
    const episodes: EpisodeItem[] = [];

    for (const c of candidates) {
      if (this.excludeSlugs.has(c.slug)) continue;
      let bundle;
      try {
        bundle = adapter.loadBundle(c.slug);
      } catch {
        continue; // skip malformed stories without breaking the whole feed
      }
      if (!bundle.primaryMedia || !existsSync(bundle.primaryMedia)) continue;

      const stat = statSync(bundle.primaryMedia);
      const duration = await this.probeDuration(bundle.primaryMedia);

      // Prefer the AudioKids-emitted generatedAt (stable across re-renders) over
      // file mtime (unstable; would reorder the feed + re-notify subscribers on
      // any file touch). Adapter pulls it from sourceMeta.generatedAt for both
      // v1 (meta.generatedAt) and v2 (parsed from the slug timestamp suffix).
      const generatedAt = bundle.sourceMeta?.generatedAt as string | undefined;
      const pubSource = generatedAt
        ? new Date(generatedAt)
        : new Date(c.mtimeMs);

      episodes.push({
        slug: c.slug,
        title: bundle.text.title ?? c.slug,
        description: buildTeaser(bundle.text.body),
        audioUrl: `${this.publicFeedBase}/audio/${c.slug}.mp3`,
        imageUrl: `${this.publicFeedBase}/covers/${c.slug}.png`,
        durationSec: Math.round(duration),
        pubDate: pubSource.toUTCString(),
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
      <itunes:image href="${esc(e.imageUrl)}" />
      <itunes:duration>${e.durationSec}</itunes:duration>
      <itunes:explicit>false</itunes:explicit>
    </item>`;
  }
}

function parseExcludes(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(raw.split(',').map(s => s.trim()).filter(Boolean));
}

/**
 * Teaser description: first two sentences of `contenido`. If sentence-split
 * yields too little text (< 20 chars), fall back to the first 300 characters.
 */
export function buildTeaser(contenido: string): string {
  const trimmed = contenido.trim();
  if (!trimmed) return '';
  const sentences = splitSentences(trimmed).slice(0, 2).join(' ').trim();
  if (sentences.length >= 20) return sentences;
  return trimmed.slice(0, 300);
}

function splitSentences(text: string): string[] {
  // Capture the punctuation so we don't lose it when joining.
  const out: string[] = [];
  const re = /[^.!?…]+[.!?…]+(?=\s|$)/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push(m[0].trim());
  }
  // If no terminal punctuation at all, return the whole string as one sentence.
  if (out.length === 0) out.push(text);
  return out;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
