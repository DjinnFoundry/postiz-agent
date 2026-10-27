import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { ContentReader } from './content/reader.js';
import { SubtitleGenerator } from './media/subtitles.js';
import { getPublisher } from './platforms/registry.js';
import type { PlatformPublisher, PublishContext } from './platforms/base.js';
import { DecisionLog } from './decisions/log.js';
import { retry, isTransientError } from './lib/retry.js';
import { notifyFailure } from './lib/alerts.js';
import { findPublicationHold, wasRecentlyPublished } from './idempotency.js';
import { normalizePublishResult, publicationOutcome } from './publication-state.js';
import { moderateWords } from './media/caption-moderation.js';
import type { CaptionStatus, Platform, PublishResult, WordEntry } from './types.js';

export interface PublishOptions {
  contentSlug: string;
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
 * End-to-end pipeline: source content → all requested platforms.
 * - Reads MP3, JSON metadata, and cover art from the configured content output
 * - Transcribes audio once (whisper word-level) and reuses across publishers
 * - Applies caption moderation to the word list before rendering
 * - Publishes platforms concurrently through the retry helper, with idempotency
 *   and alerting around each one
 * - Records every decision in a JSONL log for later analysis
 */
export class Orchestrator {
  private readonly reader = new ContentReader();
  private readonly subs = new SubtitleGenerator();
  private readonly decisions = new DecisionLog();

  async publish(opts: PublishOptions): Promise<PublishReport> {
    const assets = this.reader.readContent(opts.contentSlug);
    const m = assets.metadata;
    console.log(`\ncontent: "${m.title}" (${m.meta.wordCount} words, ${m.meta.estimatedDurationMin}min)`);

    const workDir = join(config.paths.tmpDir, opts.contentSlug);
    mkdirSync(workDir, { recursive: true });

    // ─── transcription + moderation ─────────────────────────────────────────
    let words: WordEntry[] = [];
    let captionStatus: CaptionStatus = 'skipped';
    const baseWarnings: string[] = [];

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
            baseWarnings.push(`caption moderation: replaced ${mod.replacements} token(s) from the Spanish blocklist`);
          }
        }
      } else {
        captionStatus = 'failed';
        baseWarnings.push(`transcription failed: ${t.error}`);
        if (!opts.allowNoCaptions) {
          console.error(`\n✗ whisper transcription failed and --allow-no-captions was not passed; aborting.`);
          return { slug: opts.contentSlug, results: [], fatalCaptionFailure: true };
        }
      }
    }

    // ─── parallel publish ───────────────────────────────────────────────────
    // Platforms are independent: render + upload in parallel. allSettled
    // guarantees every platform is recorded even if one explodes. The decisions
    // log uses async atomic appends, safe under concurrent writers.
    const settled = await Promise.allSettled(
      opts.platforms.map(platform => this.publishPlatform(platform, opts, { assets, workDir, words, dryRun: opts.dryRun }, captionStatus, baseWarnings)),
    );

    const results: PublishResult[] = settled.map((s, i) => {
      if (s.status === 'fulfilled') return s.value;
      const platform = opts.platforms[i];
      const error = s.reason instanceof Error ? s.reason.message : String(s.reason);
      return { platform, success: false, error, timestamp: new Date().toISOString() };
    });

    return { slug: opts.contentSlug, results };
  }

  private async publishPlatform(
    platform: Platform,
    opts: PublishOptions,
    ctx: PublishContext,
    captionStatus: CaptionStatus,
    baseWarnings: string[],
  ): Promise<PublishResult> {
    console.log(`→ ${platform}: starting`);

    // Confirmed publications have a 24h guard; unresolved remote attempts do not expire.
    if (!opts.force && !opts.dryRun) {
      const history = this.decisions.list({ contentSlug: opts.contentSlug, platform });
      const check = wasRecentlyPublished(history, opts.contentSlug, platform);
      const hold = findPublicationHold(history, opts.contentSlug, platform);
      if (check.recent || hold) {
        const reason = hold ? 'publication requires reconciliation' : 'already published today';
        console.log(`  ${platform} skipped: ${reason}`);
        const skipped: PublishResult = {
          platform,
          success: true,
          outcome: 'skipped',
          skipped: true,
          reason,
          ...(hold ? { postId: hold.result.postId, url: hold.result.url, parts: hold.result.parts } : {}),
          timestamp: new Date().toISOString(),
          captionStatus,
          warnings: baseWarnings.length ? [...baseWarnings] : undefined,
        };
        await this.decisions.record({
          action: `publish.${platform}.skipped`,
          contentSlug: opts.contentSlug,
          platform,
          reason: opts.reason ?? 'scheduled daily publication',
          result: skipped,
        });
        return skipped;
      }
    }

    const publisher = getPublisher(platform);
    const result = await this.publishWithRetry(publisher, ctx);
    const action = `${opts.dryRun ? 'render' : 'publish'}.${platform}`;
    const decorated: PublishResult = {
      ...result,
      captionStatus: result.captionStatus ?? captionStatus,
      warnings: mergeWarnings(result.warnings, baseWarnings),
    };

    if (decorated.parts && decorated.parts.length > 0) {
      // Multi-part (IG Reels split): log one decision entry per part.
      for (const part of decorated.parts) {
        await this.decisions.record({
          action: `${action}.part${part.partIndex ?? 0}`,
          contentSlug: opts.contentSlug,
          platform,
          reason: opts.reason ?? 'scheduled daily publication',
          result: part,
        });
      }
    }
    // The summary is authoritative for whole-operation completion; a part is not a whole post.
    await this.decisions.record({
      action,
      contentSlug: opts.contentSlug,
      platform,
      reason: opts.reason ?? 'scheduled daily publication',
      result: decorated,
    });

    return decorated;
  }

  /**
   * Retry only known failures without remote acceptance. Unknown upload outcomes
   * and incomplete multipart work must be reconciled, never automatically resent.
   * Preserve the last attempt's result and IDs, not a prior attempt's failure.
   */
  private async publishWithRetry(publisher: PlatformPublisher, ctx: PublishContext): Promise<PublishResult> {
    let lastResult: PublishResult | null = null;
    let attemptsSeen = 0;
    try {
      return await retry(async () => {
        attemptsSeen++;
        lastResult = null;
        const result = normalizePublishResult(await publisher.publish(ctx), ctx.dryRun, publisher.platform);
        lastResult = result;
        if (!result.success) {
          const err = new Error(result.error ?? 'publish failed');
          (err as Error & { result?: PublishResult }).result = result;
          throw err;
        }
        return result;
      }, {
        isRetryable: (err) => Boolean(lastResult && publicationOutcome(lastResult) === 'failed')
          && isTransientError(err as { message?: string; code?: string }),
        onRetry: (err, attempt, delayMs) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`  ${publisher.platform} attempt ${attempt} failed (${msg}); retrying in ${delayMs}ms`);
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Fire-and-forget alert after retries exhausted.
      void notifyFailure(
        { slug: ctx.assets.slug, platform: publisher.platform, error: msg, attempts: attemptsSeen },
        config.alerts?.webhookUrl || undefined,
      );
      if (lastResult) return lastResult;
      return normalizePublishResult({
        platform: publisher.platform,
        success: false,
        outcome: ctx.dryRun ? 'failed' : 'unknown',
        error: msg,
        timestamp: new Date().toISOString(),
      }, ctx.dryRun);
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
