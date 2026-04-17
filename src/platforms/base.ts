import { join } from 'node:path';
import { SlideVideoBuilder } from '../media/slide-video.js';
import type { Platform, PublishResult, StoryAssets, WordEntry } from '../types.js';

export type { WordEntry };

export interface PublishContext {
  assets: StoryAssets;
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
      const videoPath = await this.buildVideo(ctx);
      if (ctx.dryRun) {
        console.log(`  [dry-run] would publish to ${this.platform}: ${videoPath}`);
        return { platform: this.platform, success: true, url: `file://${videoPath}`, timestamp: ts };
      }
      const result = await this.upload(videoPath, ctx);
      return { platform: this.platform, success: true, ...result, timestamp: ts };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ${this.platform} failed: ${msg}`);
      return { platform: this.platform, success: false, error: msg, timestamp: ts };
    }
  }

  protected async buildVideo(ctx: PublishContext): Promise<string> {
    if (!ctx.words?.length) {
      throw new Error(
        `cannot build a slide video for ${this.platform} without a transcript. ` +
        `The orchestrator should either transcribe, abort, or pass --skip-transcription ` +
        `(which skips video generation entirely for slide-based publishers).`,
      );
    }
    const videoPath = join(ctx.workDir, `${ctx.assets.slug}-${this.platform}.mp4`);
    await this.slides.build({
      platform: this.platform,
      assets: ctx.assets,
      outputPath: videoPath,
      words: ctx.words,
    });
    return videoPath;
  }

  protected abstract upload(videoPath: string, ctx: PublishContext): Promise<Partial<PublishResult>>;
}
