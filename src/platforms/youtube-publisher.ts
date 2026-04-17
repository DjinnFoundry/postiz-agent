import type { PublishContext } from './base.js';
import { VideoPublisher } from './base.js';
import { YoutubeAdapter } from './youtube.js';
import type { Platform, PublishResult } from '../types.js';

export class YoutubePublisher extends VideoPublisher {
  readonly platform: Platform = 'youtube';

  constructor(private readonly adapter: YoutubeAdapter = new YoutubeAdapter()) { super(); }

  // YouTube keeps the title off the video (no title card baked in) since YT shows it natively.
  protected titleText(_ctx: PublishContext): string { return ''; }

  protected async upload(videoPath: string, ctx: PublishContext): Promise<Partial<PublishResult>> {
    const out = await this.adapter.upload({
      videoPath,
      title: ctx.assets.metadata.titulo,
      description: this.adapter.buildDescription(ctx.assets),
      privacy: 'unlisted',
      tags: ['audiocuento', 'cuentos infantiles', ctx.assets.metadata.mood],
    });
    return { postId: out.videoId, url: out.url };
  }
}
