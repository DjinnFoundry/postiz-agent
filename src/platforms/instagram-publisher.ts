import { join } from 'node:path';
import type { PublishContext } from './base.js';
import { PostizVideoPublisher } from './postiz-video-publisher.js';
import { SlideVideoBuilder } from '../media/slide-video.js';
import { PostizClient } from './postiz.js';
import { probeDurationSec } from '../lib/ffprobe.js';
import { splitIntoParts, type PartSpec } from './instagram-split.js';
import { classifyError, buildClassifiedFailure } from '../core/errors.js';
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
    postiz: PostizClient | (() => PostizClient) = () => new PostizClient(),
    /** Audio duration probe — injectable for testing. */
    private readonly probeDuration: (p: string) => Promise<number> = probeDurationSec,
    slides?: SlideVideoBuilder,
  ) {
    super(postiz, slides);
  }

  override async publish(ctx: PublishContext): Promise<PublishResult> {
    const ts = new Date().toISOString();
    // Multi-part splitting only applies to audio-story bundles. For video,
    // image-post, and text the agent is responsible for fitting platform caps;
    // we just delegate to the base path which handles them via media-strategy.
    if (ctx.bundle.kind !== 'audio-story') return super.publish(ctx);

    const media = ctx.bundle.primaryMedia;
    if (!media) return super.publish(ctx);
    const duration = await this.probeDuration(media);
    if (duration <= IG_REELS_MAX_SEC) {
      return super.publish(ctx);
    }

    const parts = splitIntoParts(duration, ctx.bundle.beats ?? [], ctx.words ?? []);
    if (parts.length <= 1) return super.publish(ctx);

    let previousScheduledMs: number | undefined;
    const partResults: PublishResult[] = [];
    for (const part of parts) {
      const completed = ctx.dryRun ? undefined : ctx.completedParts?.find(p =>
        p.success && p.partIndex === part.partIndex && p.partTotal === part.partTotal,
      );
      if (completed) {
        partResults.push({ ...completed, skipped: true, reason: 'part already published' });
        const scheduled = Date.parse(completed.scheduledDate ?? completed.timestamp);
        if (Number.isFinite(scheduled)) previousScheduledMs = Math.max(previousScheduledMs ?? 0, scheduled);
        continue;
      }
      const result = await this.publishPart(ctx, part, previousScheduledMs);
      // Persist before another upload can start, including before retries.
      await ctx.onPartPublished?.(result);
      partResults.push(result);
      if (!result.success) break;
      previousScheduledMs = Date.parse(result.scheduledDate ?? result.timestamp);
    }

    const every = partResults.every(p => p.success);
    const errors = partResults.filter(p => !p.success).map(p => p.error).filter(Boolean);
    const failure = partResults.find(p => !p.success);
    return {
      platform: this.platform,
      success: every,
      timestamp: ts,
      parts: partResults,
      ...(every ? {} : { error: errors.join(' | ') || 'one or more parts failed' }),
      ...(failure?.errorClass ? { errorClass: failure.errorClass, remediation: failure.remediation } : {}),
    };
  }

  private async publishPart(ctx: PublishContext, part: PartSpec, previousScheduledMs?: number): Promise<PublishResult> {
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
      const scheduledDate = new Date(Math.max(
        Date.now(),
        previousScheduledMs == null ? 0 : previousScheduledMs + PART_STAGGER_MINUTES * 60_000,
      )).toISOString();
      const rich = buildCaptionRich({
        bundle: ctx.bundle,
        platform: this.platform,
        part: { index: part.partIndex, total: part.partTotal },
        ...(ctx.brand ? { brand: ctx.brand } : {}),
      });
      const posted = await this.postiz.createPost({
        platform: this.platform,
        integrationId: integration.id,
        providerIdentifier: integration.providerIdentifier,
        text: rich.caption,
        videoPath: build.outputPath,
        scheduledDate,
      });
      return {
        platform: this.platform,
        success: true,
        postId: posted.postId,
        url: posted.url,
        scheduledDate: posted.scheduledDate,
        ...(rich.ctaVariantId ? { ctaVariant: rich.ctaVariantId } : {}),
        timestamp: ts,
        partIndex: part.partIndex,
        partTotal: part.partTotal,
        ...warnings,
      };
    } catch (err) {
      const classified = classifyError(err, { origin: 'postiz' });
      console.error(`  instagram part ${part.partIndex}/${part.partTotal} failed (${classified.kind}): ${classified.message}`);
      return buildClassifiedFailure(this.platform, err, {
        origin: 'postiz',
        extras: {
          timestamp: ts,
          partIndex: part.partIndex,
          partTotal: part.partTotal,
        },
      });
    }
  }

}
