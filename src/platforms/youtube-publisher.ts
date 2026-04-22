import type { PublishContext } from './base.js';
import { VideoPublisher } from './base.js';
import { YoutubeAdapter } from './youtube.js';
import { buildCaption } from '../copy/caption-builder.js';
import type { Platform, PublishResult } from '../types.js';

export class YoutubePublisher extends VideoPublisher {
  readonly platform: Platform = 'youtube';

  constructor(private readonly adapter: YoutubeAdapter = new YoutubeAdapter()) { super(); }

  protected async upload(videoPath: string, ctx: PublishContext): Promise<Partial<PublishResult>> {
    const title = ctx.bundle.text.title ?? ctx.bundle.id;
    const mood = ctx.bundle.theme?.mood ?? 'cuento';
    const out = await this.adapter.upload({
      videoPath,
      title,
      description: buildCaption({ bundle: ctx.bundle, platform: this.platform }),
      privacy: 'unlisted',
      tags: ['audiocuento', 'cuentos infantiles', mood],
    });
    return { postId: out.videoId, url: out.url };
  }
}
