import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { config } from '../config.js';
import { run } from '../lib/process.js';
import { VARIANTS, type Mood, type Platform, type StoryAssets, type WordEntry } from '../types.js';

export interface SlideDimensions {
  width: number;
  height: number;
}

/** When a mood template is missing we fall back to this one. Keep in sync with hyperframes/templates/. */
const FALLBACK_MOOD: Mood = 'fantasia';

export interface BuildInput {
  platform: Platform;
  assets: StoryAssets;
  outputPath: string;
  /** Word-level transcript. Always supplied by the orchestrator; never re-transcribed here. */
  words: WordEntry[];
  /** Multi-part: start offset inside the original audio (seconds). */
  clipStartSec?: number;
  /** Multi-part: duration of this clip (seconds). Default: full audio. */
  clipDurationSec?: number;
  /** 1-based part index (IG multi-part). */
  partIndex?: number;
  partTotal?: number;
  /** Optional warning sink (mood fallback, etc.). Also returned on BuildResult. */
  onWarn?: (msg: string) => void;
}

export interface BuildResult {
  outputPath: string;
  warnings: string[];
}

const HF_PROJECT = resolve(config.paths.projectRoot, 'hyperframes');
const HF_WORK_ROOT = join(HF_PROJECT, '.work');
/** Files copied into each per-render workspace so `npx hyperframes render` sees a complete project. */
const STATIC_PROJECT_ENTRIES = ['hyperframes.json', 'meta.json', 'templates'] as const;

/**
 * Generates a slide-based video by driving the HyperFrames project.
 *
 * Each `build()` call creates an isolated workspace under `hyperframes/.work/<slug>-<platform>-<pid>-<ts>/`
 * so concurrent renders do NOT clobber each other's staged audio, transcript, or index.html.
 * The workspace is cleaned up on both success and failure.
 *
 * Multi-part publishes (IG Reels over 3min) call build() N times with different
 * clipStartSec/clipDurationSec/partIndex. Mood fallbacks (e.g. `calma` to `fantasia`) are
 * surfaced via the BuildResult.warnings[] array for the publisher + decision log.
 */
export class SlideVideoBuilder {
  async build(input: BuildInput): Promise<BuildResult> {
    const dims = canvasFor(input.platform);
    if (!input.words || input.words.length === 0) {
      throw new Error(`SlideVideoBuilder.build requires a non-empty words[] for ${input.assets.slug}`);
    }

    const warnings: string[] = [];
    const warn = (m: string) => { warnings.push(m); input.onWarn?.(m); console.warn(m); };

    const workspace = this.createWorkspace(input.assets.slug, input.platform, input.partIndex);
    try {
      const { mood, fallbackFrom } = this.resolveMood(workspace, input.assets.metadata.mood);
      if (fallbackFrom) {
        warn(`⚠ No template for mood=${fallbackFrom}, falling back to ${mood}`);
      }

      const clipStart = input.clipStartSec ?? 0;
      const lastEnd = input.words.at(-1)?.end ?? 0;
      const clipDuration = input.clipDurationSec ?? Math.max(0, lastEnd - clipStart);
      const clippedWords = clipWords(input.words, clipStart, clipStart + clipDuration);

      await this.stageAssets(workspace, input.assets, clippedWords, clipStart, clipDuration);
      await this.runTemplate(workspace, mood, this.buildStoryPayload(input, clippedWords, dims, clipDuration));
      const rendered = await this.renderVideo(workspace, input.assets.slug, input.platform, input.partIndex);

      mkdirSync(dirname(input.outputPath), { recursive: true });
      copyFileSync(rendered, input.outputPath);
      return { outputPath: input.outputPath, warnings };
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }

  private createWorkspace(slug: string, platform: Platform, partIndex?: number): string {
    mkdirSync(HF_WORK_ROOT, { recursive: true });
    const suffix = partIndex ? `-part${partIndex}` : '';
    const workspace = join(HF_WORK_ROOT, `${slug}-${platform}${suffix}-${process.pid}-${Date.now()}`);
    mkdirSync(workspace, { recursive: true });
    for (const entry of STATIC_PROJECT_ENTRIES) {
      const src = join(HF_PROJECT, entry);
      if (!existsSync(src)) continue;
      cpSync(src, join(workspace, entry), { recursive: true });
    }
    return workspace;
  }

  private resolveMood(workspace: string, requested: Mood): { mood: Mood; fallbackFrom?: Mood } {
    const templatePath = join(workspace, 'templates', `${requested}.mjs`);
    if (existsSync(templatePath)) return { mood: requested };
    return { mood: FALLBACK_MOOD, fallbackFrom: requested };
  }

  private buildStoryPayload(
    input: BuildInput,
    words: WordEntry[],
    dims: SlideDimensions,
    clipDurationSec: number,
  ) {
    const m = input.assets.metadata;
    const payload: Record<string, unknown> = {
      title: m.title,
      byline: buildByline(m.meta),
      brand: m.meta.brand ?? config.content.brand,
      mood: m.mood,
      audioSrc: 'assets/narration.mp3',
      words,
      width: dims.width,
      height: dims.height,
      clipStartSec: input.clipStartSec ?? 0,
      clipDurationSec,
    };
    if (input.partIndex && input.partTotal && input.partTotal > 1) {
      payload.partIndex = input.partIndex;
      payload.partTotal = input.partTotal;
    }
    return payload;
  }

  private async stageAssets(
    workspace: string,
    assets: StoryAssets,
    words: WordEntry[],
    clipStartSec: number,
    clipDurationSec: number,
  ): Promise<void> {
    const assetsDir = join(workspace, 'assets');
    mkdirSync(assetsDir, { recursive: true });
    const narrationOut = join(assetsDir, 'narration.mp3');
    const lastEnd = words.at(-1)?.end ?? 0;
    const isClip = clipStartSec > 0 || (isFinite(clipDurationSec) && clipDurationSec > 0 && Math.abs(clipDurationSec - lastEnd) > 0.5);
    if (isClip) {
      // Trim the source MP3 to the requested window with ffmpeg (stream copy for speed).
      await run('ffmpeg', [
        '-y', '-loglevel', 'error',
        '-ss', clipStartSec.toFixed(3),
        '-i', assets.audioMp3Path,
        '-t', clipDurationSec.toFixed(3),
        '-acodec', 'copy',
        narrationOut,
      ]);
    } else {
      copyFileSync(assets.audioMp3Path, narrationOut);
    }
    writeFileSync(join(workspace, 'transcript.json'), JSON.stringify(words, null, 2));
  }

  private async runTemplate(workspace: string, mood: Mood, payload: object): Promise<void> {
    const templatePath = join(workspace, 'templates', `${mood}.mjs`);
    if (!existsSync(templatePath)) {
      throw new Error(`No HyperFrames template for mood=${mood} at ${templatePath}`);
    }
    await run('node', [templatePath], { cwd: workspace, stdin: JSON.stringify(payload) });
    await run('npx', ['hyperframes', 'lint'], { cwd: workspace });
  }

  private async renderVideo(workspace: string, slug: string, platform: Platform, partIndex?: number): Promise<string> {
    const suffix = partIndex ? `-part${partIndex}` : '';
    const renderOut = join(workspace, 'renders', `${slug}-${platform}${suffix}.mp4`);
    mkdirSync(dirname(renderOut), { recursive: true });
    await run('npx', ['hyperframes', 'render', '--output', renderOut, '--quiet'], { cwd: workspace });
    if (!existsSync(renderOut)) throw new Error(`hyperframes render produced no output at ${renderOut}`);
    return renderOut;
  }
}

function canvasFor(platform: Platform): SlideDimensions {
  const variant = VARIANTS[platform];
  if (!variant) throw new Error(`Platform ${platform} has no slide video variant`);
  return { width: variant.width, height: variant.height };
}

function clipWords(words: WordEntry[], startSec: number, endSec: number): WordEntry[] {
  if (startSec <= 0 && endSec >= (words.at(-1)?.end ?? 0)) return words;
  return words
    .filter(w => w.end > startSec && w.start < endSec)
    .map(w => ({
      text: w.text,
      start: Math.max(0, w.start - startSec),
      end: Math.max(0, Math.min(w.end, endSec) - startSec),
    }));
}

function buildByline(meta: Record<string, unknown>): string {
  if (typeof meta.byline === 'string' && meta.byline.trim()) return meta.byline.trim();
  if (typeof meta.author === 'string' && meta.author.trim()) return meta.author.trim();
  const audienceName = typeof meta.audienceName === 'string' ? meta.audienceName.trim() : '';
  const audienceAge = typeof meta.audienceAge === 'number' ? `${meta.audienceAge} años` : '';
  const audience = [audienceName, audienceAge].filter(Boolean).join(' · ');
  return audience || config.content.brand;
}
