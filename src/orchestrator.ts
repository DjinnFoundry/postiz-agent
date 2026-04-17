import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { AudioKidsReader } from './audiokids/reader.js';
import { SubtitleGenerator, type WordEntry } from './media/subtitles.js';
import { getPublisher } from './platforms/registry.js';
import type { PlatformPublisher, PublishContext } from './platforms/base.js';
import { DecisionLog } from './decisions/log.js';
import { retry, isTransientError } from './lib/retry.js';
import { notifyFailure } from './lib/alerts.js';
import { wasRecentlyPublished } from './idempotency.js';
import { moderateWords } from './media/caption-moderation.js';
import type { CaptionStatus, Platform, PublishResult } from './types.js';

export interface PublishOptions {
  storySlug: string;
  platforms: Platform[];
  dryRun?: boolean;
  skipTranscription?: boolean;
  allowNoCaptions?: boolean;
  force?: boolean;
  disableModeration?: boolean;
  reason?: string;
}

export interface PublishReport {
  slug: string;
  results: PublishResult[];
  /** Set to true when whisper failed and --allow-no-captions was NOT passed (orchestrator aborted). */
  fatalCaptionFailure?: boolean;
}

/**
 * End-to-end pipeline: AudioKids story → all requested platforms.
 * - Reads story assets from AudioKids output
 * - Transcribes audio once (whisper word-level) and reuses across publishers
 * - Delegates each platform to its publisher (HyperFrames slide video + platform API)
 * - Records every decision in a JSONL log for later analysis
 */
export class Orchestrator {
  private readonly reader = new AudioKidsReader();
  private readonly subs = new SubtitleGenerator();
  private readonly decisions = new DecisionLog();

  async publish(opts: PublishOptions): Promise<PublishReport> {
    const assets = this.reader.readStory(opts.storySlug);
    const m = assets.metadata;
    console.log(`\nstory: "${m.titulo}" (${m.meta.wordCount} words, ${m.meta.estimatedDurationMin}min)`);

    const workDir = join(config.paths.tmpDir, opts.storySlug);
    mkdirSync(workDir, { recursive: true });

    let words: WordEntry[] | undefined;
    let captionStatus: CaptionStatus;
    const warnings: string[] = [];

    if (opts.skipTranscription) {
      captionStatus = 'skipped';
    } else {
      const t = await this.tryTranscribe(assets.audioMp3Path, workDir, m.meta.locale);
      if (t.ok) {
        words = t.words;
        captionStatus = 'ok';
        if (!opts.disableModeration) {
          const mod = moderateWords(words);
          words = mod.words;
          if (mod.replacements > 0) {
            warnings.push(`caption moderation: replaced ${mod.replacements} token(s) from the Spanish blocklist`);
          }
        }
      } else {
        captionStatus = 'failed';
        warnings.push(`transcription failed: ${t.error}`);
        if (!opts.allowNoCaptions) {
          console.error(`\n✗ whisper transcription failed and --allow-no-captions was not passed; aborting.`);
          return { slug: opts.storySlug, results: [], fatalCaptionFailure: true };
        }
      }
    }

    const results: PublishResult[] = [];
    for (const platform of opts.platforms) {
      console.log(`\n→ ${platform}`);

      // Idempotency: skip if we already successfully published in the last 24h.
      if (!opts.force && !opts.dryRun) {
        const history = this.decisions.list({ storySlug: opts.storySlug, platform });
        const check = wasRecentlyPublished(history, opts.storySlug, platform);
        if (check.recent) {
          console.log(`  skipped: already published in the last 24h (${check.entry?.createdAt})`);
          const skipped: PublishResult = {
            platform,
            success: true,
            skipped: true,
            reason: 'already published today',
            timestamp: new Date().toISOString(),
            captionStatus,
            warnings: warnings.length ? [...warnings] : undefined,
          };
          results.push(skipped);
          this.decisions.record({
            action: `publish.${platform}.skipped`,
            storySlug: opts.storySlug,
            platform,
            reason: opts.reason ?? 'scheduled daily publication',
            result: skipped,
          });
          continue;
        }
      }

      const publisher = getPublisher(platform);
      const ctx: PublishContext = { assets, workDir, words, dryRun: opts.dryRun };
      const result = await this.publishWithRetry(publisher, ctx);
      const decorated: PublishResult = {
        ...result,
        captionStatus: result.captionStatus ?? captionStatus,
        warnings: mergeWarnings(result.warnings, warnings),
      };
      results.push(decorated);
      this.decisions.record({
        action: `publish.${platform}`,
        storySlug: opts.storySlug,
        platform,
        reason: opts.reason ?? 'scheduled daily publication',
        result: decorated,
      });
    }

    return { slug: opts.storySlug, results };
  }

  /**
   * Calls `publisher.publish(ctx)` through the retry helper. Publishers catch their
   * errors internally and return `{success:false, error}`; we re-throw those into the
   * retry harness so transient failures (5xx, network errors) get retried. On final
   * failure we return the last failed PublishResult verbatim so the caller still sees
   * the original error string.
   */
  private async publishWithRetry(publisher: PlatformPublisher, ctx: PublishContext): Promise<PublishResult> {
    let lastResult: PublishResult | null = null;
    let attemptsSeen = 0;
    try {
      return await retry(async () => {
        attemptsSeen++;
        const result = await publisher.publish(ctx);
        lastResult = result;
        if (!result.success) {
          const err = new Error(result.error ?? 'publish failed');
          (err as Error & { result?: PublishResult }).result = result;
          throw err;
        }
        return result;
      }, {
        isRetryable: (err) => {
          const anyErr = err as { message?: string; code?: string };
          return isTransientError(anyErr);
        },
        onRetry: (err, attempt, delayMs) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`  ${publisher.platform} attempt ${attempt} failed (${msg}); retrying in ${delayMs}ms`);
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Fire-and-forget alert after retries exhausted. Awaited only to clear the
      // timeout handle; swallows its own errors so orchestrator is never blocked.
      void notifyFailure(
        { slug: ctx.assets.slug, platform: publisher.platform, error: msg, attempts: attemptsSeen },
        config.alerts.webhookUrl || undefined,
      );
      if (lastResult) return lastResult;
      return {
        platform: publisher.platform,
        success: false,
        error: msg,
        timestamp: new Date().toISOString(),
      };
    }
  }

  private async tryTranscribe(audioPath: string, workDir: string, locale: string): Promise<
    | { ok: true; words: WordEntry[] }
    | { ok: false; error: string }
  > {
    console.log(`\ntranscribing audio...`);
    try {
      const { words, jsonPath } = await this.subs.generate({
        audioPath,
        outputDir: workDir,
        language: locale.split('-')[0] ?? 'es',
      });
      console.log(`  ${words.length} words → ${jsonPath}`);
      return { ok: true, words };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  transcription failed: ${msg}`);
      return { ok: false, error: msg };
    }
  }
}

function mergeWarnings(a?: string[], b?: string[]): string[] | undefined {
  const merged = [...(a ?? []), ...(b ?? [])];
  return merged.length ? merged : undefined;
}
