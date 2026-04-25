import type { PublishContext } from './base.js';
import { VideoPublisher } from './base.js';
import { PostizClient } from './postiz.js';
import { buildCaptionRich } from '../copy/caption-builder.js';
import type { PublishResult } from '../types.js';

/**
 * Common base for every publisher that uploads through Postiz (X, TikTok, IG).
 * Subclasses only declare their `platform`; the caption, find-integration, and
 * upload dance are shared. `mediaPath` may be null for text-only bundles
 * (kind='text'); Postiz accepts text-only posts on every platform that allows
 * captions without media.
 */
export abstract class PostizVideoPublisher extends VideoPublisher {
  constructor(protected readonly postiz: PostizClient = new PostizClient()) {
    super();
  }

  protected async upload(mediaPath: string | null, ctx: PublishContext): Promise<Partial<PublishResult>> {
    const integration = await this.postiz.findIntegration(this.platform);
    const rich = buildCaptionRich({ bundle: ctx.bundle, platform: this.platform, ...(ctx.brand ? { brand: ctx.brand } : {}) });
    const posted = await this.postiz.createPost({
      platform: this.platform,
      integrationId: integration.id,
      text: rich.caption,
      ...(mediaPath ? { videoPath: mediaPath } : {}),
    });
    return {
      postId: posted.postId,
      url: posted.url,
      ...(rich.ctaVariantId ? { ctaVariant: rich.ctaVariantId } : {}),
    };
  }
}
