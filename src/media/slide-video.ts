import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { config } from '../config.js';
import { run } from '../lib/process.js';
import { SubtitleGenerator } from './subtitles.js';
import { parseWhisperJson, flattenWords } from './whisper-json.js';
import type { Mood, Platform, StoryAssets } from '../types.js';

export interface SlideDimensions {
  width: number;
  height: number;
}

const CANVAS: Record<Platform, SlideDimensions | null> = {
  x:         { width: 1080, height: 1080 },
  tiktok:    { width: 1080, height: 1920 },
  instagram: { width: 1080, height: 1920 },
  youtube:   { width: 1920, height: 1080 },
  spotify:   null,
};

/**
 * When a mood template is missing we fall back to this one. Keep in sync with
 * hyperframes/templates/.
 */
const FALLBACK_MOOD: Mood = 'fantasia';

export interface BuildInput {
  platform: Platform;
  assets: StoryAssets;
  outputPath: string;
  /** Pre-computed words (skip whisper if provided). */
  words?: Array<{ text: string; start: number; end: number }>;
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

/**
 * Generates a slide-based video by driving the HyperFrames project:
 *   1. Transcribe narration MP3 → word-level JSON (or reuse pre-computed)
 *   2. Stage MP3 + transcript into hyperframes/assets & hyperframes/transcript.json
 *   3. Pipe story JSON into templates/{mood}.mjs which writes index.html
 *   4. Run `npx hyperframes render` to produce MP4
 *   5. Move output to the requested path
 */
export class SlideVideoBuilder {
  private readonly projectDir = resolve(config.paths.projectRoot, 'hyperframes');
  private readonly subs = new SubtitleGenerator();

  async build(input: BuildInput): Promise<BuildResult> {
    const dims = CANVAS[input.platform];
    if (!dims) throw new Error(`Platform ${input.platform} has no slide video variant`);
    const warnings: string[] = [];
    const warn = (m: string) => { warnings.push(m); input.onWarn?.(m); console.warn(m); };

    const words = input.words ?? await this.transcribe(input.assets);
    const { mood, fallbackFrom } = this.resolveMood(input.assets.metadata.mood);
    if (fallbackFrom) {
      warn(`⚠ No template for mood=${fallbackFrom}, falling back to ${mood}`);
    }
    const clipStart = input.clipStartSec ?? 0;
    const clipDuration = input.clipDurationSec ?? (words.at(-1)?.end ?? 0) - clipStart;
    const clippedWords = clipWords(words, clipStart, clipStart + clipDuration);
    const storyPayload = this.buildStoryPayload(input, clippedWords, dims, clipDuration);

    await this.stageAssets(input.assets, clippedWords, clipStart, clipDuration);
    await this.runTemplate(mood, storyPayload);
    const rendered = await this.renderVideo(input.assets.slug, input.platform, input.partIndex);

    mkdirSync(dirname(input.outputPath), { recursive: true });
    copyFileSync(rendered, input.outputPath);
    return { outputPath: input.outputPath, warnings };
  }

  private async transcribe(assets: StoryAssets) {
    const tmpDir = join(config.paths.tmpDir, assets.slug);
    mkdirSync(tmpDir, { recursive: true });
    const base = basename(assets.audioMp3Path).replace(/\.[^.]+$/, '');
    const jsonPath = join(tmpDir, `${base}.json`);

    if (!existsSync(jsonPath)) {
      // `whisper` CLI writes <base>.json beside other formats when output_format=json
      await run('whisper', [
        assets.audioMp3Path,
        '--model', 'base',
        '--language', assets.metadata.meta.locale.split('-')[0] ?? 'es',
        '--output_format', 'json',
        '--output_dir', tmpDir,
        '--word_timestamps', 'True',
        '--verbose', 'False',
      ]);
    }
    const data = parseWhisperJson(jsonPath);
    return flattenWords(data).map(w => ({ text: w.word, start: w.start, end: w.end }));
  }

  private buildStoryPayload(
    input: BuildInput,
    words: BuildInput['words'],
    dims: SlideDimensions,
    clipDurationSec: number,
  ) {
    const m = input.assets.metadata;
    const payload: Record<string, unknown> = {
      title: m.titulo,
      byline: `${m.meta.name} · ${m.meta.age} años`,
      mood: m.mood,
      audioSrc: 'assets/narration.mp3',
      words,
      width: dims.width,
      height: dims.height,
      clipStartSec: input.clipStartSec ?? 0,
      clipDurationSec: clipDurationSec,
    };
    if (input.partIndex && input.partTotal && input.partTotal > 1) {
      payload.partIndex = input.partIndex;
      payload.partTotal = input.partTotal;
    }
    return payload;
  }

  private async stageAssets(assets: StoryAssets, words: BuildInput['words'], clipStartSec: number, clipDurationSec: number): Promise<void> {
    const assetsDir = join(this.projectDir, 'assets');
    mkdirSync(assetsDir, { recursive: true });
    const narrationOut = join(assetsDir, 'narration.mp3');
    const isClipped = clipStartSec > 0 || (isFinite(clipDurationSec) && clipDurationSec > 0 && !isWholeFile(words, clipStartSec, clipDurationSec));
    if (isClipped) {
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
    writeFileSync(join(this.projectDir, 'transcript.json'), JSON.stringify(words, null, 2));
  }

  private resolveMood(requested: Mood): { mood: Mood; fallbackFrom?: Mood } {
    const templatePath = join(this.projectDir, 'templates', `${requested}.mjs`);
    if (existsSync(templatePath)) return { mood: requested };
    return { mood: FALLBACK_MOOD, fallbackFrom: requested };
  }

  private async runTemplate(mood: Mood, payload: object): Promise<void> {
    const templatePath = join(this.projectDir, 'templates', `${mood}.mjs`);
    if (!existsSync(templatePath)) {
      throw new Error(`No HyperFrames template for mood=${mood} at ${templatePath}`);
    }
    // Pipe the payload as JSON on stdin so the template runs deterministically.
    await runWithStdin('node', [templatePath], JSON.stringify(payload), { cwd: this.projectDir });
    // Lint before render (catches silent-audio bugs etc.)
    await run('npx', ['hyperframes', 'lint'], { cwd: this.projectDir });
  }

  private async renderVideo(slug: string, platform: Platform, partIndex?: number): Promise<string> {
    const suffix = partIndex ? `-part${partIndex}` : '';
    const renderOut = join(this.projectDir, 'renders', `${slug}-${platform}${suffix}.mp4`);
    rmSync(renderOut, { force: true });
    mkdirSync(dirname(renderOut), { recursive: true });
    await run('npx', ['hyperframes', 'render', '--output', renderOut, '--quiet'], { cwd: this.projectDir });
    if (!existsSync(renderOut)) throw new Error(`hyperframes render produced no output at ${renderOut}`);
    return renderOut;
  }
}

function isWholeFile(
  words: Array<{ text: string; start: number; end: number }> | undefined,
  startSec: number,
  durSec: number,
): boolean {
  if (!words || words.length === 0) return startSec === 0;
  const lastEnd = words.at(-1)?.end ?? 0;
  return startSec === 0 && Math.abs(durSec - lastEnd) < 0.5;
}

function clipWords(
  words: Array<{ text: string; start: number; end: number }>,
  startSec: number,
  endSec: number,
): Array<{ text: string; start: number; end: number }> {
  if (startSec <= 0 && endSec >= (words.at(-1)?.end ?? 0)) return words;
  return words
    .filter(w => w.end > startSec && w.start < endSec)
    .map(w => ({
      text: w.text,
      start: Math.max(0, w.start - startSec),
      end: Math.max(0, Math.min(w.end, endSec) - startSec),
    }));
}

function runWithStdin(cmd: string, args: string[], stdin: string, opts: { cwd?: string } = {}): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    import('node:child_process').then(({ spawn }) => {
      const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: opts.cwd });
      let stderr = '';
      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.on('error', rejectPromise);
      proc.on('close', code => {
        if (code === 0) resolvePromise();
        else rejectPromise(new Error(`${cmd} exited ${code}: ${stderr.slice(-400)}`));
      });
      proc.stdin.write(stdin);
      proc.stdin.end();
    });
  });
}
