import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { AudioKidsReader } from './audiokids/reader.js';
import { SubtitleGenerator, type WordEntry } from './media/subtitles.js';
import { getPublisher } from './platforms/registry.js';
import { DecisionLog } from './decisions/log.js';
import type { CaptionStatus, Platform, PublishResult } from './types.js';

export interface PublishOptions {
  storySlug: string;
  platforms: Platform[];
  dryRun?: boolean;
  skipTranscription?: boolean;
  allowNoCaptions?: boolean;
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
      const publisher = getPublisher(platform);
      const result = await publisher.publish({ assets, workDir, words, dryRun: opts.dryRun });
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
