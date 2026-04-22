import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { AudioKidsAdapter } from './adapters/audiokids.js';
import { SubtitleGenerator } from './media/subtitles.js';
import { getPublisher } from './platforms/registry.js';
import type { PlatformPublisher, PublishContext } from './platforms/base.js';
import { DecisionLog } from './decisions/log.js';
import { retry, isTransientError } from './lib/retry.js';
import { notifyFailure } from './lib/alerts.js';
import { wasRecentlyPublished } from './idempotency.js';
import { moderateWords } from './media/caption-moderation.js';
import type { ContentBundle } from './core/content-bundle.js';
import { classifyError } from './core/errors.js';
import { preflightPlatform } from './core/preflight.js';
import { platformOrigin } from './platforms/base.js';
import type { CaptionStatus, Platform, PublishResult, WordEntry } from './types.js';

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
 * End-to-end pipeline: a ContentBundle → all requested platforms.
 *
 * Today the orchestrator loads bundles via the AudioKids adapter; future pipelines
 * (a custom video pipeline, a data-driven post pipeline, etc.) will inject a different
 * adapter without changing downstream code. Every tool from transcription onward
 * consumes ContentBundle exclusively.
 */
export class Orchestrator {
  private readonly adapter = new AudioKidsAdapter();
  private readonly subs = new SubtitleGenerator();
  private readonly decisions = new DecisionLog();

  async publish(opts: PublishOptions): Promise<PublishReport> {
    const bundle = this.adapter.loadBundle(opts.storySlug);
    const wordCount = (bundle.sourceMeta?.wordCount as number | undefined) ?? 0;
    const durationMin = (bundle.sourceMeta?.estimatedDurationMin as number | undefined) ?? 0;
    console.log(`\nstory: "${bundle.text.title ?? bundle.id}" (${wordCount} words, ${durationMin}min)`);

    const workDir = join(config.paths.tmpDir, opts.storySlug);
    mkdirSync(workDir, { recursive: true });

    // ─── transcription + moderation ─────────────────────────────────────────
    let words: WordEntry[] = [];
    let captionStatus: CaptionStatus = 'skipped';
    const baseWarnings: string[] = [];

    if (opts.skipTranscription) {
      captionStatus = 'skipped';
    } else if (!bundle.primaryMedia) {
      captionStatus = 'skipped';
      baseWarnings.push('no primary media to transcribe');
    } else {
      const t = await this.tryTranscribe(bundle.primaryMedia, workDir, bundle.locale);
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
          return { slug: opts.storySlug, results: [], fatalCaptionFailure: true };
        }
      }
    }

    // ─── parallel publish ───────────────────────────────────────────────────
    // Platforms are independent: render + upload in parallel. allSettled
    // guarantees every platform is recorded even if one explodes. The decisions
    // log uses async atomic appends, safe under concurrent writers.
    const settled = await Promise.allSettled(
      opts.platforms.map(platform => this.publishPlatform(platform, opts, { bundle, workDir, words, dryRun: opts.dryRun }, captionStatus, baseWarnings)),
    );

    const results: PublishResult[] = settled.map((s, i) => {
      if (s.status === 'fulfilled') return s.value;
      const platform = opts.platforms[i];
      const error = s.reason instanceof Error ? s.reason.message : String(s.reason);
      return { platform, success: false, error, timestamp: new Date().toISOString() };
    });

    return { slug: opts.storySlug, results };
  }

  private async publishPlatform(
    platform: Platform,
    opts: PublishOptions,
    ctx: PublishContext,
    captionStatus: CaptionStatus,
    baseWarnings: string[],
  ): Promise<PublishResult> {
    console.log(`→ ${platform}: starting`);

    // Preflight: refuse early if this platform can't accept this bundle. Saves
    // 2-3 minutes of render time when the audio is too long, cover is missing,
    // or the target is spotify (RSS-only).
    const pre = await preflightPlatform(ctx.bundle, platform);
    if (!pre.ok) {
      const success = pre.kind === 'skip';
      const ts = new Date().toISOString();
      const result: PublishResult = {
        platform,
        success,
        skipped: true,
        reason: pre.reason,
        timestamp: ts,
        captionStatus,
        ...(pre.kind !== 'skip' ? { errorClass: pre.kind, error: pre.reason } : {}),
        ...(pre.hint ? { remediation: { action: 'preflight-fix', humanHint: pre.hint } } : {}),
        warnings: baseWarnings.length ? [...baseWarnings] : undefined,
      };
      await this.decisions.record({
        action: `publish.${platform}.preflight`,
        storySlug: opts.storySlug,
        platform,
        reason: opts.reason ?? 'scheduled daily publication',
        result,
      });
      console.log(`  ${platform} preflight: ${pre.reason}`);
      return result;
    }

    // Idempotency: skip if we already successfully published in the last 24h.
    if (!opts.force && !opts.dryRun) {
      const history = this.decisions.list({ storySlug: opts.storySlug, platform });
      const check = wasRecentlyPublished(history, opts.storySlug, platform);
      if (check.recent) {
        console.log(`  ${platform} skipped: already published in the last 24h (${check.entry?.createdAt})`);
        const skipped: PublishResult = {
          platform,
          success: true,
          skipped: true,
          reason: 'already published today',
          timestamp: new Date().toISOString(),
          captionStatus,
          warnings: baseWarnings.length ? [...baseWarnings] : undefined,
        };
        await this.decisions.record({
          action: `publish.${platform}.skipped`,
          storySlug: opts.storySlug,
          platform,
          reason: opts.reason ?? 'scheduled daily publication',
          result: skipped,
        });
        return skipped;
      }
    }

    const publisher = getPublisher(platform);
    const result = await this.publishWithRetry(publisher, ctx);
    const decorated: PublishResult = {
      ...result,
      captionStatus: result.captionStatus ?? captionStatus,
      warnings: mergeWarnings(result.warnings, baseWarnings),
    };

    if (decorated.parts && decorated.parts.length > 0) {
      // Multi-part (IG Reels split): log one decision entry per part.
      for (const part of decorated.parts) {
        await this.decisions.record({
          action: `publish.${platform}.part${part.partIndex ?? 0}`,
          storySlug: opts.storySlug,
          platform,
          reason: opts.reason ?? 'scheduled daily publication',
          result: part,
        });
      }
    } else {
      await this.decisions.record({
        action: `publish.${platform}`,
        storySlug: opts.storySlug,
        platform,
        reason: opts.reason ?? 'scheduled daily publication',
        result: decorated,
      });
    }

    return decorated;
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
        isRetryable: (err) => isTransientError(err as { message?: string; code?: string }),
        onRetry: (err, attempt, delayMs) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`  ${publisher.platform} attempt ${attempt} failed (${msg}); retrying in ${delayMs}ms`);
        },
      });
    } catch (err) {
      const classified = classifyError(err, { origin: platformOrigin(publisher.platform) });
      // Fire-and-forget alert after retries exhausted.
      void notifyFailure(
        { slug: ctx.bundle.id, platform: publisher.platform, error: classified.message, attempts: attemptsSeen },
        config.alerts?.webhookUrl || undefined,
      );
      if (lastResult) return lastResult;
      return {
        platform: publisher.platform,
        success: false,
        error: classified.message,
        errorClass: classified.kind,
        ...(classified.remediation ? { remediation: classified.remediation } : {}),
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

export type { ContentBundle };
