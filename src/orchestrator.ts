import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { AudioKidsReader } from './audiokids/reader.js';
import { SubtitleGenerator, type WordEntry } from './media/subtitles.js';
import { getPublisher } from './platforms/registry.js';
import { DecisionLog } from './decisions/log.js';
import type { Platform, PublishResult } from './types.js';

export interface PublishOptions {
  storySlug: string;
  platforms: Platform[];
  dryRun?: boolean;
  skipTranscription?: boolean;
  reason?: string;
}

export interface PublishReport {
  slug: string;
  results: PublishResult[];
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

    const words = opts.skipTranscription ? [] : (await this.tryTranscribe(assets.audioMp3Path, workDir, m.meta.locale)) ?? [];

    const results: PublishResult[] = [];
    for (const platform of opts.platforms) {
      console.log(`\n→ ${platform}`);
      const publisher = getPublisher(platform);
      const result = await publisher.publish({ assets, workDir, words, dryRun: opts.dryRun });
      results.push(result);
      this.decisions.record({
        action: `publish.${platform}`,
        storySlug: opts.storySlug,
        platform,
        reason: opts.reason ?? 'scheduled daily publication',
        result,
      });
    }

    return { slug: opts.storySlug, results };
  }

  private async tryTranscribe(audioPath: string, workDir: string, locale: string): Promise<WordEntry[] | undefined> {
    console.log(`\ntranscribing audio...`);
    try {
      const { words, jsonPath } = await this.subs.generate({
        audioPath,
        outputDir: workDir,
        language: locale.split('-')[0] ?? 'es',
      });
      console.log(`  ${words.length} words → ${jsonPath}`);
      return words;
    } catch (err) {
      console.warn(`  transcription failed (continuing without captions): ${err instanceof Error ? err.message : err}`);
      return undefined;
    }
  }
}
