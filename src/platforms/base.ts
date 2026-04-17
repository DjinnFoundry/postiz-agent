import { join } from 'node:path';
import { SlideVideoBuilder } from '../media/slide-video.js';
import type { Platform, PublishResult, StoryAssets } from '../types.js';

export interface WordEntry {
  text: string;
  start: number;
  end: number;
}

export interface PublishContext {
  assets: StoryAssets;
  workDir: string;
  /** Word-level transcript, already computed at the orchestrator level */
  words?: WordEntry[];
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
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ${this.platform} failed: ${msg}`);
      return { platform: this.platform, success: false, error: msg, timestamp: ts };
    }
  }

  protected async buildVideo(ctx: PublishContext): Promise<{ videoPath: string; warnings: string[] }> {
    const videoPath = join(ctx.workDir, `${ctx.assets.slug}-${this.platform}.mp4`);
    const result = await this.slides.build({
      platform: this.platform,
      assets: ctx.assets,
      outputPath: videoPath,
      words: ctx.words,
    });
    return { videoPath: result.outputPath, warnings: result.warnings };
  }

  protected abstract upload(videoPath: string, ctx: PublishContext): Promise<Partial<PublishResult>>;
}
