import type { PublishContext } from './base.js';
import { VideoPublisher } from './base.js';
import { YoutubeAdapter } from './youtube.js';
import { buildCaption } from '../copy/caption-builder.js';
import { deriveHashtags } from '../copy/hashtags.js';
import type { Platform, PublishResult } from '../types.js';

const DEFAULT_YOUTUBE_TAGS = ['audiocuento', 'cuentos infantiles'];

export class YoutubePublisher extends VideoPublisher {
  readonly platform: Platform = 'youtube';

  constructor(private readonly adapter: YoutubeAdapter = new YoutubeAdapter()) { super(); }

  protected async upload(mediaPath: string | null, ctx: PublishContext): Promise<Partial<PublishResult>> {
    if (!mediaPath) {
      throw new Error(`youtube requires a video file; bundle kind="${ctx.bundle.kind}" produced no media path`);
    }
    const title = ctx.bundle.text.title ?? ctx.bundle.id;
    const out = await this.adapter.upload({
      videoPath: mediaPath,
      title,
      description: buildCaption({ bundle: ctx.bundle, platform: this.platform, ...(ctx.brand ? { brand: ctx.brand } : {}) }),
      privacy: 'unlisted',
      tags: this.resolveTags(ctx),
    });
    return { postId: out.videoId, url: out.url };
  }

  /** Tag pool sent to the YouTubeCLI uploader. Prefers the tenant brand's
   *  hashtag pool when present (so AudioKids vs ZetaRead vs anyone-else lands
   *  with their own tags); falls back to the AudioKids default + bundle mood
   *  for back-compat with single-tenant deployments. */
  private resolveTags(ctx: PublishContext): string[] {
    const mood = ctx.bundle.theme?.mood;
    const brandPool = ctx.brand?.hashtags;
    if (brandPool?.length) {
      const tags = [...brandPool];
      if (mood && !tags.includes(mood)) tags.push(mood);
      return tags;
    }
    const fallback = [...DEFAULT_YOUTUBE_TAGS];
    if (mood) fallback.push(mood);
    // deriveHashtags adds locale/keyword tags that complement the brand pool.
    for (const t of deriveHashtags(ctx.bundle)) if (!fallback.includes(t)) fallback.push(t);
    return fallback;
  }
}
