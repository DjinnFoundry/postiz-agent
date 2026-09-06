import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { AudioKidsAdapter } from './adapters/audiokids.js';
import { AdapterRegistry, createDefaultRegistry, DEFAULT_ADAPTER, type BundleAdapter } from './adapters/registry.js';
import { SubtitleGenerator } from './media/subtitles.js';
import { getPublisher as defaultGetPublisher } from './platforms/registry.js';
import type { PlatformPublisher, PublishContext } from './platforms/base.js';
import { DecisionLog } from './decisions/log.js';
import { retry, isTransientError } from './lib/retry.js';
import { notifyFailure } from './lib/alerts.js';
import { wasRecentlyPublished, completedPublicationParts } from './idempotency.js';
import { PUBLISHED_WINDOW_MS, findStuckSlugs } from './dispatch.js';
import { validateSlug } from './lib/slug.js';
import { moderateWords } from './media/caption-moderation.js';
import type { ContentBundle } from './core/content-bundle.js';
import { ContentBundleSchema, getWordCount, getEstimatedDurationMin } from './core/content-bundle.js';
import { classifyError, buildClassifiedFailure } from './core/errors.js';
import { preflightPlatform, type PreflightResult } from './core/preflight.js';
import type { BrandContext } from './copy/brand.js';
import { platformOrigin } from './platforms/base.js';
import type { CaptionStatus, Platform, PublishResult, WordEntry } from './types.js';

export interface PublishOptions {
  /** Id of the bundle within the chosen adapter. The CLI's `--slug` flag is
   *  resolved into this same field upstream so callers (CLI, daemon, tests)
   *  speak one canonical name; `--slug` lives only at the user-facing layer. */
  id?: string;
  /** Which adapter to load the bundle from. Default 'audiokids'. Ignored when `bundle` is supplied. */
  adapter?: string;
  /** Inline bundle, bypasses the adapter entirely. Mutually exclusive with id. */
  bundle?: ContentBundle;

  platforms: Platform[];
  dryRun?: boolean;
  skipTranscription?: boolean;
  allowNoCaptions?: boolean;
  force?: boolean;
  disableModeration?: boolean;
  reason?: string;
  /** Per-tenant brand identity threaded through to the caption builder. */
  brand?: BrandContext;
}

export interface PublishReport {
  /** The bundle id used for this run. */
  slug: string;
  results: PublishResult[];
  /** Set to true when whisper failed and --allow-no-captions was NOT passed (orchestrator aborted). */
  fatalCaptionFailure?: boolean;
  /** UUID v4 minted at the start of this publish() call; shared by every decision log entry it emits. */
  runId?: string;
}

export interface OrchestratorDeps {
  /** New: full adapter registry. Use this for multi-tenant / multi-adapter setups. */
  adapters?: AdapterRegistry;
  /** Legacy: a single AudioKidsAdapter instance. If provided, wrapped into a registry with name 'audiokids'. */
  adapter?: AudioKidsAdapter;
  decisions?: DecisionLog;
  getPublisher?: (platform: Platform) => PlatformPublisher;
  preflight?: (bundle: ContentBundle, platform: Platform) => Promise<PreflightResult>;
  workDir?: string;
  alertWebhookUrl?: string;
}

/**
 * End-to-end pipeline: a ContentBundle → all requested platforms.
 *
 * The bundle can come from any registered adapter (default `audiokids`), or be
 * supplied inline by an external agent that already has a ContentBundle ready.
 * Every tool from transcription onward consumes ContentBundle exclusively.
 */
export class Orchestrator {
  private readonly adapters: AdapterRegistry;
  private readonly subs = new SubtitleGenerator();
  private readonly decisions: DecisionLog;
  private readonly getPublisher: (platform: Platform) => PlatformPublisher;
  private readonly preflight: (bundle: ContentBundle, platform: Platform) => Promise<PreflightResult>;
  private readonly workDir: string;
  private readonly alertWebhookUrl: string;
  private retainPublishLock = false;

  constructor(deps: OrchestratorDeps = {}) {
    if (deps.adapters) {
      this.adapters = deps.adapters;
    } else if (deps.adapter) {
      this.adapters = new AdapterRegistry().register(legacyAudioKidsBundleAdapter(deps.adapter));
    } else {
      this.adapters = createDefaultRegistry();
    }
    this.decisions = deps.decisions ?? new DecisionLog();
    this.getPublisher = deps.getPublisher ?? defaultGetPublisher;
    this.preflight = deps.preflight ?? preflightPlatform;
    this.workDir = deps.workDir ?? config.paths.tmpDir;
    this.alertWebhookUrl = deps.alertWebhookUrl ?? config.alerts.webhookUrl;
  }

  async publish(opts: PublishOptions): Promise<PublishReport> {
    const runId = randomUUID();
    const bundle = this.resolveBundle(opts);
    validateSlug(bundle.id);
    const platforms = [...new Set(opts.platforms)];
    if (!platforms.length) throw new Error('publish: at least one platform is required');
    const release = this.decisions.acquirePublishLock();
    this.retainPublishLock = false;
    try {
      return await this.publishBundle({ ...opts, platforms }, bundle, runId);
    } finally {
      if (!this.retainPublishLock) release();
    }
  }

  private async publishBundle(opts: PublishOptions, bundle: ContentBundle, runId: string): Promise<PublishReport> {
    const wordCount = getWordCount(bundle) ?? 0;
    const durationMin = getEstimatedDurationMin(bundle) ?? 0;
    console.error(`\nstory: "${bundle.text.title ?? bundle.id}" (${wordCount} words, ${durationMin}min)`);

    mkdirSync(this.workDir, { recursive: true });
    const workDir = mkdtempSync(join(this.workDir, 'publish-'));
    const earlyResults = new Map<Platform, PublishResult>();
    await Promise.all(opts.platforms.map(async platform => {
      const ctx: PublishContext = { bundle, workDir, words: [], dryRun: opts.dryRun };
      const reason = opts.reason ?? DEFAULT_PUBLISH_REASON;
      const result = await this.applyIdempotencyGuard(platform, ctx, opts, 'skipped', [], runId, reason)
        ?? await this.applyPreflight(platform, ctx, 'skipped', [], runId, reason);
      if (result) earlyResults.set(platform, result);
    }));
    if (earlyResults.size === opts.platforms.length) {
      return { slug: bundle.id, runId, results: opts.platforms.map(p => earlyResults.get(p)!) };
    }

    let words: WordEntry[] = [];
    let captionStatus: CaptionStatus = 'skipped';
    const baseWarnings: string[] = [];

    if (opts.skipTranscription || bundle.kind !== 'audio-story') {
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
          const results: PublishResult[] = [];
          for (const platform of opts.platforms) {
            const previous = earlyResults.get(platform);
            if (previous) { results.push(previous); continue; }
            const result = buildClassifiedFailure(platform, new Error(t.error), { origin: 'whisper', extras: { captionStatus: 'failed' } });
            await this.recordPublishDecision({ action: `publish.${platform}.transcription`, platform,
              ctx: { bundle, workDir, words: [], dryRun: opts.dryRun }, reason: opts.reason ?? DEFAULT_PUBLISH_REASON, result, runId });
            results.push(result);
          }
          return { slug: bundle.id, results, fatalCaptionFailure: true, runId };
        }
      }
    }

    const settled = await Promise.allSettled(
      opts.platforms.map(platform => earlyResults.get(platform) ?? this.publishPlatform(
        platform,
        opts,
        { bundle, workDir, words, dryRun: opts.dryRun, ...(opts.brand ? { brand: opts.brand } : {}) },
        captionStatus,
        baseWarnings,
        runId,
      )),
    );

    const results: PublishResult[] = settled.map((s, i) => {
      if (s.status === 'fulfilled') return s.value;
      const platform = opts.platforms[i];
      const error = s.reason instanceof Error ? s.reason.message : String(s.reason);
      return { platform, success: false, error, timestamp: new Date().toISOString() };
    });

    return { slug: bundle.id, results, runId };
  }

  /**
   * Pick the bundle for this publish call. Priority:
   *  1. Inline `bundle` (validated against ContentBundleSchema).
   *  2. `id` resolved through the named adapter (default 'audiokids').
   * Throws when neither is present, or both are.
   */
  private resolveBundle(opts: PublishOptions): ContentBundle {
    if (opts.bundle && opts.id) {
      throw new Error('publish: pass either bundle (inline) or id, not both');
    }
    if (opts.bundle) {
      return ContentBundleSchema.parse(opts.bundle);
    }
    if (!opts.id) {
      throw new Error('publish: one of bundle or id is required');
    }
    const adapterName = opts.adapter ?? DEFAULT_ADAPTER;
    return this.adapters.get(adapterName).loadBundle(opts.id);
  }

  private async publishPlatform(
    platform: Platform,
    opts: PublishOptions,
    ctx: PublishContext,
    captionStatus: CaptionStatus,
    baseWarnings: string[],
    runId: string,
  ): Promise<PublishResult> {
    console.error(`→ ${platform}: starting`);
    const reason = opts.reason ?? DEFAULT_PUBLISH_REASON;

    const recordedParts = new Set<number>();
    ctx = { ...ctx, completedParts: opts.force ? [] : completedPublicationParts(
      this.decisions.list({ storySlug: ctx.bundle.id, platform, includeArchives: true }),
      ctx.bundle.id, platform, new Date(), PUBLISHED_WINDOW_MS,
    ) };
    ctx.onPartPublished = async part => {
      await this.recordPublishDecision({ action: `publish.${platform}.part${part.partIndex ?? 0}`, platform, ctx, runId, reason,
        result: decorateResult(part, captionStatus, baseWarnings) });
      recordedParts.add(part.partIndex ?? 0);
      if (part.success && !ctx.dryRun) {
        ctx.completedParts = [...(ctx.completedParts ?? []).filter(p => p.partIndex !== part.partIndex), part];
      }
    };
    const result = await this.publishWithRetry(this.getPublisher(platform), ctx);
    const decorated = decorateResult(result, captionStatus, baseWarnings);
    if (opts.dryRun) { decorated.skipped = true; decorated.reason = 'dry-run'; }
    await this.recordDecisionEntries(decorated, platform, ctx, runId, reason, recordedParts);
    return decorated;
  }

  /** Run platform preflight; if it rejects, build the skip result, log it, and return it.
   *  Returns null when preflight clears so the caller proceeds to publish. */
  private async applyPreflight(
    platform: Platform,
    ctx: PublishContext,
    captionStatus: CaptionStatus,
    baseWarnings: string[],
    runId: string,
    reason: string,
  ): Promise<PublishResult | null> {
    const pre = await this.preflight(ctx.bundle, platform);
    if (pre.ok) return null;
    const result = buildSkipResult({
      platform,
      success: pre.kind === 'skip',
      reason: pre.reason,
      captionStatus,
      baseWarnings,
      ...(pre.kind !== 'skip' ? { errorClass: pre.kind, errorMessage: pre.reason } : {}),
      ...(pre.hint ? { remediation: { action: 'preflight-fix', humanHint: pre.hint } } : {}),
    });
    await this.recordPublishDecision({
      action: `publish.${platform}.preflight`, platform, ctx, reason, result, runId,
    });
    console.error(`  ${platform} preflight: ${pre.reason}`);
    return result;
  }

  /** Skip + log when a successful publish for (slug, platform) exists in the last
   *  24h. --force and --dry-run bypass; the latter still hits the publisher so
   *  preview renders show what a real publish would emit. */
  private async applyIdempotencyGuard(
    platform: Platform,
    ctx: PublishContext,
    opts: PublishOptions,
    captionStatus: CaptionStatus,
    baseWarnings: string[],
    runId: string,
    reason: string,
  ): Promise<PublishResult | null> {
    if (opts.force || opts.dryRun) return null;
    const history = this.decisions.list({ storySlug: ctx.bundle.id, platform, includeArchives: true });
    const uncertain = findStuckSlugs(history, [platform]).find(s => s.reason === 'publication-outcome-unknown');
    if (uncertain) {
      return buildSkipResult({ platform, success: false, reason: 'previous publication needs reconciliation',
        captionStatus, baseWarnings, errorClass: 'needs-human', errorMessage: 'Check the remote post, then reset attempts before retrying',
        remediation: uncertain.lastRemediation });
    }
    const check = wasRecentlyPublished(history, ctx.bundle.id, platform);
    if (!check.recent) return null;
    console.error(`  ${platform} skipped: already published in the last 24h (${check.entry?.createdAt})`);
    const result = buildSkipResult({
      platform,
      success: true,
      reason: 'already published today',
      captionStatus,
      baseWarnings,
    });
    await this.recordPublishDecision({
      action: `publish.${platform}.skipped`, platform, ctx, reason, result, runId,
    });
    return result;
  }

  /** Multi-part publishes (IG split) emit one entry per part so dispatch + stats
   *  see them individually; single-shot publishes emit one combined entry. */
  private async recordDecisionEntries(
    decorated: PublishResult,
    platform: Platform,
    ctx: PublishContext,
    runId: string,
    reason: string,
    recordedParts: Set<number>,
  ): Promise<void> {
    if (decorated.parts?.length) {
      for (const part of decorated.parts) {
        if (recordedParts.has(part.partIndex ?? 0) || part.skipped) continue;
        await this.recordPublishDecision({
          action: `publish.${platform}.part${part.partIndex ?? 0}`,
          platform, ctx, reason, result: part, runId,
        });
      }
      return;
    }
    await this.recordPublishDecision({
      action: `publish.${platform}`, platform, ctx, reason, result: decorated, runId,
    });
  }

  /** Append a single decision-log entry for a publish-related action. The
   *  storySlug field always equals ctx.bundle.id; centralising this writer
   *  removes the per-call repetition of the same five literals (action,
   *  storySlug, platform, reason, result, runId). */
  private async recordPublishDecision(input: {
    action: string;
    platform: Platform;
    ctx: PublishContext;
    reason: string;
    result: PublishResult;
    runId: string;
  }): Promise<void> {
    if (input.ctx.dryRun) return;
    try {
      await this.decisions.record({
        action: input.action,
        storySlug: input.ctx.bundle.id,
        platform: input.platform,
        reason: input.reason,
        result: input.result,
        runId: input.runId,
      });
    } catch (err) {
      if ((input.result.success && !input.result.skipped) || input.result.remediation?.action === 'reconcile-post') {
        this.retainPublishLock = true;
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Remote publication needs reconciliation because its decision could not be recorded (${message}). The publication lock was retained; inspect the remote posts before removing it.`);
      }
      throw err;
    }
  }

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
          const result = (err as { result?: PublishResult }).result;
          if (result?.errorClass) return result.errorClass === 'transient';
          if (result?.parts?.some(p => !p.success && p.errorClass !== 'transient')) return false;
          return isTransientError(err);
        },
        onRetry: (err, attempt, delayMs) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`  ${publisher.platform} attempt ${attempt} failed (${msg}); retrying in ${delayMs}ms`);
        },
      });
    } catch (err) {
      const classified = classifyError(err, { origin: platformOrigin(publisher.platform) });
      void notifyFailure(
        { slug: ctx.bundle.id, platform: publisher.platform, error: classified.message, attempts: attemptsSeen },
        ctx.dryRun ? undefined : this.alertWebhookUrl || undefined,
      );
      if (lastResult) return lastResult;
      return buildClassifiedFailure(publisher.platform, err, {
        origin: platformOrigin(publisher.platform),
      });
    }
  }

  private async tryTranscribe(audioPath: string, workDir: string, locale: string): Promise<
    | { ok: true; words: WordEntry[] }
    | { ok: false; error: string }
  > {
    console.error(`\ntranscribing audio...`);
    try {
      const { words, jsonPath } = await this.subs.generate({
        audioPath,
        outputDir: workDir,
        language: locale.split('-')[0] ?? 'es',
      });
      console.error(`  ${words.length} words → ${jsonPath}`);
      return { ok: true, words };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  transcription failed: ${msg}`);
      return { ok: false, error: msg };
    }
  }
}

/** Default reason recorded in the decision log when the caller did not supply one.
 *  Kept as a constant so dispatch/cron output stays consistent and greppable. */
const DEFAULT_PUBLISH_REASON = 'scheduled daily publication';

/** Layer caption status + base warnings on top of the publisher's PublishResult.
 *  Pure helper so it stays trivially testable and the publish flow reads top-down. */
function decorateResult(result: PublishResult, captionStatus: CaptionStatus, baseWarnings: string[]): PublishResult {
  return {
    ...result,
    captionStatus: result.captionStatus ?? captionStatus,
    warnings: mergeWarnings(result.warnings, baseWarnings),
  };
}

/**
 * Build a skip-shaped PublishResult — used when preflight rejects, when the
 * 24h idempotency guard fires, and any future "skip with logging" path. The
 * envelope was inlined twice in publishPlatform with identical baseWarnings
 * cloning and timestamp generation; this helper makes it impossible to drift.
 */
interface BuildSkipResultInput {
  platform: Platform;
  /** Whether the skip counts as a successful publish (preflight skip kind=skip,
   *  idempotency skip → true) or a failure recorded as skipped (preflight reject
   *  kinds → false). */
  success: boolean;
  reason: string;
  captionStatus: CaptionStatus;
  baseWarnings: string[];
  /** Optional classified-error fields when the skip is in fact a soft failure. */
  errorClass?: PublishResult['errorClass'];
  errorMessage?: string;
  remediation?: PublishResult['remediation'];
}

function buildSkipResult(input: BuildSkipResultInput): PublishResult {
  return {
    platform: input.platform,
    success: input.success,
    skipped: true,
    reason: input.reason,
    timestamp: new Date().toISOString(),
    captionStatus: input.captionStatus,
    ...(input.errorClass ? { errorClass: input.errorClass } : {}),
    ...(input.errorMessage ? { error: input.errorMessage } : {}),
    ...(input.remediation ? { remediation: input.remediation } : {}),
    warnings: input.baseWarnings.length ? [...input.baseWarnings] : undefined,
  };
}

function mergeWarnings(a?: string[], b?: string[]): string[] | undefined {
  const merged = [...(a ?? []), ...(b ?? [])];
  return merged.length ? merged : undefined;
}

/** Wrap a legacy AudioKidsAdapter instance into the BundleAdapter interface
 *  so the registry can hold it under the canonical 'audiokids' name. */
function legacyAudioKidsBundleAdapter(inner: AudioKidsAdapter): BundleAdapter {
  return {
    name: DEFAULT_ADAPTER,
    description: 'AudioKids adapter (injected via deps.adapter)',
    loadBundle: (id) => inner.loadBundle(id),
    listCandidates: () => inner.listCandidates().map(c => ({ id: c.slug, generatedAtMs: c.mtimeMs })),
  };
}

export type { ContentBundle };
