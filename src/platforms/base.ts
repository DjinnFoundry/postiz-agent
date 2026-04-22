import { join } from 'node:path';
import { SlideVideoBuilder } from '../media/slide-video.js';
import type { ContentBundle } from '../core/content-bundle.js';
import { classifyError, type ErrorOrigin } from '../core/errors.js';
import type { Platform, PublishResult, WordEntry } from '../types.js';

export type { WordEntry };

export interface PublishContext {
  bundle: ContentBundle;
  workDir: string;
  /**
   * Word-level transcript, always computed once at the orchestrator level.
   * If transcription is unavailable (e.g. whisper failed, or --skip-transcription),
   * the orchestrator must decide whether to abort or surface an empty array here.
   */
  words: WordEntry[];
  dryRun?: boolean;
}

export interface PlatformPublisher {
  readonly platform: Platform;
  publish(ctx: PublishContext): Promise<PublishResult>;
}

/**
 * Base class for publishers that need a platform-specific slide video.
 * Handles the common steps: video build via HyperFrames, dry-run short-circuit,
 * error capture. Subclasses implement `upload(videoPath, ctx)`.
 */
export abstract class VideoPublisher implements PlatformPublisher {
  abstract readonly platform: Platform;
  protected readonly slides = new SlideVideoBuilder();

  async publish(ctx: PublishContext): Promise<PublishResult> {
    const ts = new Date().toISOString();
    try {
      const { videoPath, warnings } = await this.buildVideo(ctx);
      if (ctx.dryRun) {
        console.log(`  [dry-run] would publish to ${this.platform}: ${videoPath}`);
        return {
          platform: this.platform,
          success: true,
          url: `file://${videoPath}`,
          timestamp: ts,
          ...(warnings.length ? { warnings } : {}),
        };
      }
      const result = await this.upload(videoPath, ctx);
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
      return {
        platform: this.platform,
        success: false,
        error: classified.message,
        errorClass: classified.kind,
        ...(classified.remediation ? { remediation: classified.remediation } : {}),
        timestamp: ts,
      };
    }
  }

  protected async buildVideo(ctx: PublishContext): Promise<{ videoPath: string; warnings: string[] }> {
    if (!ctx.words?.length) {
      throw new Error(
        `cannot build a slide video for ${this.platform} without a transcript. ` +
        `The orchestrator should either transcribe, abort, or pass --skip-transcription ` +
        `(which skips video generation entirely for slide-based publishers).`,
      );
    }
    const videoPath = join(ctx.workDir, `${ctx.bundle.id}-${this.platform}.mp4`);
    const result = await this.slides.build({
      platform: this.platform,
      bundle: ctx.bundle,
      outputPath: videoPath,
      words: ctx.words,
    });
    return { videoPath: result.outputPath, warnings: result.warnings };
  }

  protected abstract upload(videoPath: string, ctx: PublishContext): Promise<Partial<PublishResult>>;
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
