import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { config } from '../config.js';
import { run } from '../lib/process.js';
import type { ContentBundle } from '../core/content-bundle.js';
import { resolveTagline } from '../core/content-bundle.js';
import { resolveTheme } from '../theme/resolver.js';
import { VARIANTS, type Platform, type WordEntry } from '../types.js';
import { finalizeRender, persistStderr } from './render-output.js';

export interface SlideDimensions {
  width: number;
  height: number;
}

/** Template used for every bundle. The treatment is passed via the payload. */
const EDITORIAL_TEMPLATE = 'editorial.mjs';

export interface BuildInput {
  platform: Platform;
  bundle: ContentBundle;
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
  /** Optional warning sink. Also returned on BuildResult. */
  onWarn?: (msg: string) => void;
}

export interface BuildResult {
  outputPath: string;
  warnings: string[];
}

const HF_PROJECT = resolve(config.paths.projectRoot, 'hyperframes');
const HF_WORK_ROOT = join(HF_PROJECT, '.work');
const RENDER_LOG_DIR = config.paths.renderLogsDir;
/** Files copied into each per-render workspace so `npx hyperframes render` sees a complete project. */
const STATIC_PROJECT_ENTRIES = ['hyperframes.json', 'meta.json', 'templates'] as const;
/** Optional entries copied only if present in the project root. Fonts are bulky (MB) and */
/** only exist after the operator has run `pnpm fetch-fonts`; absence falls back to CDN URLs. */
const OPTIONAL_PROJECT_ENTRIES = ['assets/fonts'] as const;

/**
 * Generates a slide-based video by driving the HyperFrames project.
 *
 * Each `build()` call creates an isolated workspace under `hyperframes/.work/<id>-<platform>-<pid>-<ts>/`
 * so concurrent renders do NOT clobber each other's staged audio, transcript, or index.html.
 * The workspace is cleaned up on both success and failure, but any captured stderr from
 * hyperframes lint/render is first copied to `data/render-logs/<id>-<platform>-<ts>.log`
 * so we can diagnose failures after the workspace has been wiped.
 *
 * The final MP4 is written atomically (tmp + rename) and verified (size threshold +
 * ffprobe duration > 0) before we declare success. Corrupt outputs surface as errors
 * instead of silent empty files.
 */
export class SlideVideoBuilder {
  async build(input: BuildInput): Promise<BuildResult> {
    const dims = canvasFor(input.platform);
    if (!input.words || input.words.length === 0) {
      throw new Error(`SlideVideoBuilder.build requires a non-empty words[] for ${input.bundle.id}`);
    }
    const audioPath = input.bundle.primaryMedia;
    if (!audioPath) {
      throw new Error(`SlideVideoBuilder.build requires bundle.primaryMedia for ${input.bundle.id}`);
    }

    const warnings: string[] = [];

    const workspace = this.createWorkspace(input.bundle.id, input.platform, input.partIndex);
    const logFile = this.reserveRenderLog(input.bundle.id, input.platform, input.partIndex);
    try {
      this.assertEditorialTemplate(workspace);
      const theme = resolveTheme(input.bundle);

      const clipStart = input.clipStartSec ?? 0;
      const lastEnd = input.words.at(-1)?.end ?? 0;
      const clipDuration = input.clipDurationSec ?? Math.max(0, lastEnd - clipStart);
      const clippedWords = clipWords(input.words, clipStart, clipStart + clipDuration);

      await this.stageAssets(workspace, audioPath, clippedWords, clipStart, clipDuration);
      await this.runTemplate(
        workspace,
        this.buildStoryPayload(input, clippedWords, dims, clipDuration, theme),
        logFile,
      );
      const rendered = await this.renderVideo(workspace, input.bundle.id, input.platform, input.partIndex, logFile);

      await finalizeRender(rendered, input.outputPath);
      return { outputPath: input.outputPath, warnings };
    } catch (err) {
      persistStderr(err, logFile);
      throw err;
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }

  private createWorkspace(id: string, platform: Platform, partIndex?: number): string {
    mkdirSync(HF_WORK_ROOT, { recursive: true });
    const suffix = partIndex ? `-part${partIndex}` : '';
    const workspace = join(HF_WORK_ROOT, `${id}-${platform}${suffix}-${process.pid}-${Date.now()}`);
    mkdirSync(workspace, { recursive: true });
    for (const entry of STATIC_PROJECT_ENTRIES) {
      const src = join(HF_PROJECT, entry);
      if (!existsSync(src)) continue;
      cpSync(src, join(workspace, entry), { recursive: true });
    }
    for (const entry of OPTIONAL_PROJECT_ENTRIES) {
      const src = join(HF_PROJECT, entry);
      if (!existsSync(src)) continue;
      const dst = join(workspace, entry);
      mkdirSync(dirname(dst), { recursive: true });
      // `dereference: true` so a symlinked fonts dir copies real files into the
      // workspace (renders run in isolation and the cache dir may be symlinked
      // to an external location on some operator machines).
      cpSync(src, dst, { recursive: true, dereference: true });
    }
    return workspace;
  }

  private reserveRenderLog(id: string, platform: Platform, partIndex?: number): string {
    mkdirSync(RENDER_LOG_DIR, { recursive: true });
    const suffix = partIndex ? `-part${partIndex}` : '';
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    return join(RENDER_LOG_DIR, `${id}-${platform}${suffix}-${ts}.log`);
  }

  private assertEditorialTemplate(workspace: string): void {
    const editorial = join(workspace, 'templates', EDITORIAL_TEMPLATE);
    if (!existsSync(editorial)) {
      throw new Error(`HyperFrames template missing: ${editorial}`);
    }
  }

  private buildStoryPayload(
    input: BuildInput,
    words: WordEntry[],
    dims: SlideDimensions,
    clipDurationSec: number,
    theme: ReturnType<typeof resolveTheme>,
  ) {
    const b = input.bundle;
    const title = b.text.title ?? b.id;
    const byline = resolveTagline(b) ?? '';
    const payload: Record<string, unknown> = {
      title,
      byline,
      audioSrc: 'assets/narration.mp3',
      words,
      width: dims.width,
      height: dims.height,
      clipStartSec: input.clipStartSec ?? 0,
      clipDurationSec,
      theme: {
        treatment: theme.treatment,
        palette: theme.palette,
        fontPairing: theme.fontPairing,
        source: theme.source,
      },
    };
    if (input.partIndex && input.partTotal && input.partTotal > 1) {
      payload.partIndex = input.partIndex;
      payload.partTotal = input.partTotal;
    }
    return payload;
  }

  private async stageAssets(
    workspace: string,
    audioSrcPath: string,
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
        '-i', audioSrcPath,
        '-t', clipDurationSec.toFixed(3),
        '-acodec', 'copy',
        narrationOut,
      ]);
    } else {
      copyFileSync(audioSrcPath, narrationOut);
    }
    writeFileSync(join(workspace, 'transcript.json'), JSON.stringify(words, null, 2));
  }

  private async runTemplate(workspace: string, payload: object, logFile: string): Promise<void> {
    const templatePath = join(workspace, 'templates', EDITORIAL_TEMPLATE);
    if (!existsSync(templatePath)) {
      throw new Error(`No HyperFrames template at ${templatePath}`);
    }
    try {
      await run('node', [templatePath], { cwd: workspace, stdin: JSON.stringify(payload) });
      await run('npx', ['hyperframes', 'lint'], { cwd: workspace });
    } catch (err) {
      persistStderr(err, logFile);
      throw err;
    }
  }

  private async renderVideo(workspace: string, id: string, platform: Platform, partIndex: number | undefined, logFile: string): Promise<string> {
    const suffix = partIndex ? `-part${partIndex}` : '';
    const renderOut = join(workspace, 'renders', `${id}-${platform}${suffix}.mp4`);
    mkdirSync(dirname(renderOut), { recursive: true });
    try {
      await run('npx', ['hyperframes', 'render', '--output', renderOut, '--quiet'], { cwd: workspace });
    } catch (err) {
      persistStderr(err, logFile);
      throw err;
    }
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
