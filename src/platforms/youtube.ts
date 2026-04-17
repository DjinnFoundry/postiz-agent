import { existsSync } from 'node:fs';
import { config } from '../config.js';
import { run } from '../lib/process.js';
import type { StoryAssets } from '../types.js';

export interface YoutubeUploadInput {
  videoPath: string;
  title: string;
  description: string;
  tags?: string[];
  privacy?: 'private' | 'unlisted' | 'public';
  publishAt?: string;
  categoryId?: string;
}

export interface YoutubeUploadResult {
  videoId: string;
  url: string;
}

/**
 * Delegates YouTube publishing to YouTubeCLI (the user's existing superior tool).
 */
export class YoutubeAdapter {
  constructor(private readonly projectPath: string = config.youtubecli.path) {}

  async upload(input: YoutubeUploadInput): Promise<YoutubeUploadResult> {
    if (!existsSync(input.videoPath))   throw new Error(`Video not found: ${input.videoPath}`);
    if (!existsSync(this.projectPath))  throw new Error(`YouTubeCLI path not found: ${this.projectPath}`);

    const args = [
      'run', 'youtube_cli', 'video', 'upload',
      '--file', input.videoPath,
      '--title', input.title,
      '--description', input.description,
      '--privacy', input.privacy ?? 'private',
    ];
    if (input.tags?.length) args.push('--tags', input.tags.join(','));
    if (input.publishAt)    args.push('--publish-at', input.publishAt);
    if (input.categoryId)   args.push('--category-id', input.categoryId);

    const { stdout } = await run('mix', args, { cwd: this.projectPath });
    const match = stdout.match(/videoId[:=\s]+([A-Za-z0-9_-]{11})/);
    if (!match) throw new Error(`Could not parse videoId from YouTubeCLI output: ${stdout.slice(-300)}`);
    return { videoId: match[1], url: `https://www.youtube.com/watch?v=${match[1]}` };
  }

  buildDescription(assets: StoryAssets): string {
    const m = assets.metadata;
    const vocab = m.vocabularioNuevo?.length ? `\n\nVocabulario nuevo: ${m.vocabularioNuevo.join(', ')}` : '';
    return (
      `${m.contenido.slice(0, 300).trim()}...\n\n` +
      `Un audiocuento de AudioKids para ${m.meta.name} (${m.meta.age} años).\n` +
      `Género: ${m.mood} · Duración: ~${m.meta.estimatedDurationMin} min${vocab}\n\n` +
      `#audiocuentos #cuentosinfantiles #${m.mood}`
    );
  }
}
