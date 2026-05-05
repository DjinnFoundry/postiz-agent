import { SlideVideoBuilder } from '../media/slide-video.js';
import type { ContentBundle } from '../core/content-bundle.js';
import { classifyError, buildClassifiedFailure, type ErrorOrigin } from '../core/errors.js';
import { resolveMediaForPlatform } from '../core/media-strategy.js';
import type { BrandContext } from '../copy/brand.js';
import type { Platform, PublishResult, WordEntry } from '../types.js';

export type { WordEntry };

export interface PublishContext {
  bundle: ContentBundle;
  workDir: string;
  /**
   * Word-level transcript, always computed once at the orchestrator level.
   * Empty for non-audio-story bundles or when transcription is intentionally skipped.
   */
  words: WordEntry[];
  dryRun?: boolean;
  /** Per-tenant brand identity. Overrides AudioKids defaults in the caption builder. */
  brand?: BrandContext;
}

export interface PlatformPublisher {
  readonly platform: Platform;
  publish(ctx: PublishContext): Promise<PublishResult>;
}

/**
 * Base class for every Postiz / YouTube publisher. Resolves the correct media
 * for the bundle.kind (slide-render for audio-story, passthrough for video and
 * image-post, no media for text) and delegates the upload to the subclass.
 *
 * The class kept the `VideoPublisher` name for backward compat: subclasses
 * still implement `upload(mediaPath, ctx)`. `mediaPath` may be null for
 * text-only kinds; the subclass decides how to treat that.
 */
export abstract class VideoPublisher implements PlatformPublisher {
  abstract readonly platform: Platform;
  protected readonly slides = new SlideVideoBuilder();

  async publish(ctx: PublishContext): Promise<PublishResult> {
    const ts = new Date().toISOString();
    try {
      const { mediaPath, warnings } = await this.resolveMedia(ctx);
      if (ctx.dryRun) {
        const target = mediaPath ?? '(no media — text-only post)';
        console.log(`  [dry-run] would publish to ${this.platform}: ${target}`);
        return {
          platform: this.platform,
          success: true,
          url: mediaPath ? `file://${mediaPath}` : 'text-only-dry-run',
          timestamp: ts,
          ...(warnings.length ? { warnings } : {}),
        };
      }
      const result = await this.upload(mediaPath, ctx);
      return {
        platform: this.platform,
        success: true,
        ...result,
        timestamp: ts,
        ...(warnings.length ? { warnings: [...(result.warnings ?? []), ...warnings] } : {}),
      };
    } catch (err) {
      const classified = classifyError(err, { origin: platformOrigin(this.platform) });
      console.error(`  ${this.platform} failed (${classified.kind}/${classified.origin}): ${classified.message}`);
      return buildClassifiedFailure(this.platform, err, {
        origin: platformOrigin(this.platform),
        extras: { timestamp: ts },
      });
    }
  }

  protected async resolveMedia(ctx: PublishContext): Promise<{ mediaPath: string | null; warnings: string[] }> {
    if (ctx.bundle.kind === 'audio-story' && (!ctx.words || ctx.words.length === 0)) {
      throw new Error(
        `cannot build a slide video for ${this.platform} without a transcript. ` +
        `The orchestrator should either transcribe, abort, or pass --skip-transcription ` +
        `(which skips video generation entirely for slide-based publishers).`,
      );
    }
    const result = await resolveMediaForPlatform({
      bundle: ctx.bundle,
      platform: this.platform,
      words: ctx.words,
      slideBuilder: this.slides,
      workDir: ctx.workDir,
    });
    return { mediaPath: result.mediaPath, warnings: result.warnings };
  }

  protected abstract upload(mediaPath: string | null, ctx: PublishContext): Promise<Partial<PublishResult>>;
}

/** Map a target platform to the ErrorOrigin hint our classifier understands. */
export function platformOrigin(platform: Platform): ErrorOrigin {
  switch (platform) {
    case 'x':
    case 'tiktok':
    case 'instagram':
      return 'postiz';
    case 'youtube':
      return 'youtube-cli';
    default:
      return 'unknown';
  }
}
