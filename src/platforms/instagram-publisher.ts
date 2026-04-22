import { join } from 'node:path';
import type { PublishContext } from './base.js';
import { PostizVideoPublisher } from './postiz-video-publisher.js';
import { PostizClient } from './postiz.js';
import { probeDurationSec } from '../lib/ffprobe.js';
import { splitIntoParts, type PartSpec } from './instagram-split.js';
import { classifyError } from '../core/errors.js';
import { buildCaptionRich } from '../copy/caption-builder.js';
import type { Platform, PublishResult } from '../types.js';

/** Instagram Reels maximum video length (seconds). */
const IG_REELS_MAX_SEC = 180;
/** Stagger interval between parts when scheduling a multi-part publish. */
const PART_STAGGER_MINUTES = 5;

/**
 * Instagram has a 3-minute Reels cap. For cuentos below that limit this behaves
 * exactly like the shared PostizVideoPublisher. Above it, `publish()` splits the
 * audio into ≤170s windows (aligned to beats when possible), renders one video
 * per part, and uploads each with "· Parte i de N" appended to the caption plus
 * a scheduledDate staggered 5 minutes apart so they land in order.
 */
export class InstagramPublisher extends PostizVideoPublisher {
  readonly platform: Platform = 'instagram';

  constructor(
    postiz: PostizClient = new PostizClient(),
    /** Audio duration probe — injectable for testing. */
    private readonly probeDuration: (p: string) => Promise<number> = probeDurationSec,
  ) {
    super(postiz);
  }

  override async publish(ctx: PublishContext): Promise<PublishResult> {
    const ts = new Date().toISOString();
    const media = ctx.bundle.primaryMedia;
    if (!media) return super.publish(ctx);
    const duration = await this.probeDuration(media);
    if (duration <= IG_REELS_MAX_SEC) {
      return super.publish(ctx);
    }

    const parts = splitIntoParts(duration, ctx.bundle.beats ?? [], ctx.words ?? []);
    if (parts.length <= 1) return super.publish(ctx);

    const startTs = Date.now();
    const partResults: PublishResult[] = [];
    for (const part of parts) {
      partResults.push(await this.publishPart(ctx, part, startTs));
    }

    const every = partResults.every(p => p.success);
    const errors = partResults.filter(p => !p.success).map(p => p.error).filter(Boolean);
    return {
      platform: this.platform,
      success: every,
      timestamp: ts,
      parts: partResults,
      ...(every ? {} : { error: errors.join(' | ') || 'one or more parts failed' }),
    };
  }

  private async publishPart(ctx: PublishContext, part: PartSpec, startTs: number): Promise<PublishResult> {
    const ts = new Date().toISOString();
    const videoPath = join(ctx.workDir, `${ctx.bundle.id}-${this.platform}-part${part.partIndex}.mp4`);
    try {
      const build = await this.slides.build({
        platform: this.platform,
        bundle: ctx.bundle,
        outputPath: videoPath,
        words: ctx.words,
        clipStartSec: part.clipStartSec,
        clipDurationSec: part.clipDurationSec,
        partIndex: part.partIndex,
        partTotal: part.partTotal,
      });
      const warnings = build.warnings.length ? { warnings: build.warnings } : {};
      if (ctx.dryRun) {
        return {
          platform: this.platform,
          success: true,
          url: `file://${build.outputPath}`,
          timestamp: ts,
          partIndex: part.partIndex,
          partTotal: part.partTotal,
          ...warnings,
        };
      }
      const integration = await this.postiz.findIntegration(this.platform);
      const scheduledDate = new Date(startTs + (part.partIndex - 1) * PART_STAGGER_MINUTES * 60_000).toISOString();
      const rich = buildCaptionRich({
        bundle: ctx.bundle,
        platform: this.platform,
        part: { index: part.partIndex, total: part.partTotal },
      });
      const posted = await this.postiz.createPost({
        platform: this.platform,
        integrationId: integration.id,
        text: rich.caption,
        videoPath: build.outputPath,
        scheduledDate,
      });
      return {
        platform: this.platform,
        success: true,
        postId: posted.postId,
        url: posted.url,
        ...(rich.ctaVariantId ? { ctaVariant: rich.ctaVariantId } : {}),
        timestamp: ts,
        partIndex: part.partIndex,
        partTotal: part.partTotal,
        ...warnings,
      };
    } catch (err) {
      const classified = classifyError(err, { origin: 'postiz' });
      console.error(`  instagram part ${part.partIndex}/${part.partTotal} failed (${classified.kind}): ${classified.message}`);
      return {
        platform: this.platform,
        success: false,
        error: classified.message,
        errorClass: classified.kind,
        ...(classified.remediation ? { remediation: classified.remediation } : {}),
        timestamp: ts,
        partIndex: part.partIndex,
        partTotal: part.partTotal,
      };
    }
  }

}
