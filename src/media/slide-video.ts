import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { config } from '../config.js';
import { run } from '../lib/process.js';
import { VARIANTS, type Platform, type StoryAssets, type WordEntry } from '../types.js';

export interface SlideDimensions {
  width: number;
  height: number;
}

export interface BuildInput {
  platform: Platform;
  assets: StoryAssets;
  outputPath: string;
  /** Word-level transcript. Always supplied by the orchestrator; never re-transcribed here. */
  words: WordEntry[];
}

const HF_PROJECT = resolve(config.paths.projectRoot, 'hyperframes');
const HF_WORK_ROOT = join(HF_PROJECT, '.work');
// Files that must exist in each per-render workspace for `npx hyperframes render` to succeed.
const STATIC_PROJECT_ENTRIES = ['hyperframes.json', 'meta.json', 'templates'] as const;

/**
 * Generates a slide-based video by driving the HyperFrames project.
 *
 * Each `build()` call creates an isolated workspace under `hyperframes/.work/<slug>-<platform>-<pid>/`
 * so concurrent renders do NOT clobber each other's staged audio, transcript, or index.html.
 * The workspace is cleaned up on both success and failure.
 */
export class SlideVideoBuilder {
  async build(input: BuildInput): Promise<string> {
    const dims = canvasFor(input.platform);
    if (!input.words || input.words.length === 0) {
      throw new Error(`SlideVideoBuilder.build requires a non-empty words[] for ${input.assets.slug}`);
    }

    const workspace = this.createWorkspace(input.assets.slug, input.platform);
    try {
      this.stageAssets(workspace, input.assets, input.words);
      await this.runTemplate(workspace, input.assets.metadata.mood, this.buildStoryPayload(input.assets, input.words, dims));
      const rendered = await this.renderVideo(workspace, input.assets.slug, input.platform);
      mkdirSync(dirname(input.outputPath), { recursive: true });
      copyFileSync(rendered, input.outputPath);
      return input.outputPath;
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }

  private createWorkspace(slug: string, platform: Platform): string {
    mkdirSync(HF_WORK_ROOT, { recursive: true });
    const workspace = join(HF_WORK_ROOT, `${slug}-${platform}-${process.pid}-${Date.now()}`);
    mkdirSync(workspace, { recursive: true });
    // Copy the static project parts so `npx hyperframes render <workspace>` sees a complete project.
    for (const entry of STATIC_PROJECT_ENTRIES) {
      const src = join(HF_PROJECT, entry);
      if (!existsSync(src)) continue;
      cpSync(src, join(workspace, entry), { recursive: true });
    }
    return workspace;
  }

  private buildStoryPayload(assets: StoryAssets, words: WordEntry[], dims: SlideDimensions) {
    const m = assets.metadata;
    return {
      title: m.titulo,
      byline: `${m.meta.name} · ${m.meta.age} años`,
      mood: m.mood,
      audioSrc: 'assets/narration.mp3',
      words,
      width: dims.width,
      height: dims.height,
    };
  }

  private stageAssets(workspace: string, assets: StoryAssets, words: WordEntry[]) {
    const assetsDir = join(workspace, 'assets');
    mkdirSync(assetsDir, { recursive: true });
    copyFileSync(assets.audioMp3Path, join(assetsDir, 'narration.mp3'));
    writeFileSync(join(workspace, 'transcript.json'), JSON.stringify(words, null, 2));
  }

  private async runTemplate(workspace: string, mood: string, payload: object): Promise<void> {
    const templatePath = join(workspace, 'templates', `${mood}.mjs`);
    if (!existsSync(templatePath)) {
      throw new Error(`No HyperFrames template for mood=${mood} at ${templatePath}`);
    }
    await run('node', [templatePath], { cwd: workspace, stdin: JSON.stringify(payload) });
    await run('npx', ['hyperframes', 'lint'], { cwd: workspace });
  }

  private async renderVideo(workspace: string, slug: string, platform: Platform): Promise<string> {
    const renderOut = join(workspace, 'renders', `${slug}-${platform}.mp4`);
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
