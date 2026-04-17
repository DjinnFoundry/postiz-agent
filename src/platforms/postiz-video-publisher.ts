import type { PublishContext } from './base.js';
import { VideoPublisher } from './base.js';
import { PostizClient } from './postiz.js';
import type { PublishResult, StoryAssets } from '../types.js';

/**
 * Common base for every publisher that uploads a video through Postiz (X, TikTok, IG).
 * Subclasses only decide what the post's caption says; the find-integration + upload
 * dance is shared.
 */
export abstract class PostizVideoPublisher extends VideoPublisher {
  constructor(protected readonly postiz: PostizClient = new PostizClient()) {
    super();
  }

  protected abstract buildCaption(assets: StoryAssets): string;

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
}
