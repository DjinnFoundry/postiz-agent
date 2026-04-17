import type { PublishContext } from './base.js';
import { VideoPublisher } from './base.js';
import { PostizClient } from './postiz.js';
import type { Platform, PublishResult, StoryAssets } from '../types.js';

export class InstagramPublisher extends VideoPublisher {
  readonly platform: Platform = 'instagram';

  constructor(private readonly postiz: PostizClient = new PostizClient()) { super(); }

  protected async upload(videoPath: string, ctx: PublishContext): Promise<Partial<PublishResult>> {
    const integration = await this.postiz.findIntegration(this.platform);
    const posted = await this.postiz.createPost({
      platform: this.platform,
      integrationId: integration.id,
      text: this.buildCaption(ctx.assets),
      videoPath,
    });
    return { postId: posted.postId, url: posted.url };
  }

  private buildCaption(assets: StoryAssets): string {
    const { titulo, mood, contenido } = assets.metadata;
    return `"${titulo}" · un audiocuento de AudioKids\n\n${contenido.slice(0, 160)}...\n\n#audiocuentos #${mood} #cuentosinfantiles`;
  }
}
