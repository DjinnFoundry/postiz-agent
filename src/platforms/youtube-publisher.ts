import type { PublishContext } from './base.js';
import { VideoPublisher } from './base.js';
import { YoutubeAdapter } from './youtube.js';
import { buildCaption } from '../copy/caption-builder.js';
import type { Platform, PublishResult } from '../types.js';

export class YoutubePublisher extends VideoPublisher {
  readonly platform: Platform = 'youtube';

  constructor(private readonly adapter: YoutubeAdapter = new YoutubeAdapter()) { super(); }

  protected async upload(mediaPath: string | null, ctx: PublishContext): Promise<Partial<PublishResult>> {
    if (!mediaPath) {
      throw new Error(`youtube requires a video file; bundle kind="${ctx.bundle.kind}" produced no media path`);
    }
    const title = ctx.bundle.text.title ?? ctx.bundle.id;
    const mood = ctx.bundle.theme?.mood ?? 'cuento';
    const out = await this.adapter.upload({
      videoPath: mediaPath,
      title,
      description: buildCaption({ bundle: ctx.bundle, platform: this.platform, ...(ctx.brand ? { brand: ctx.brand } : {}) }),
      privacy: 'unlisted',
      tags: ['audiocuento', 'cuentos infantiles', mood],
    });
    return { postId: out.videoId, url: out.url };
  }
}
