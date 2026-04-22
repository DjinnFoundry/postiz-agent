import { existsSync } from 'node:fs';
import { config } from '../config.js';
import { run } from '../lib/process.js';
import type { ContentBundle } from '../core/content-bundle.js';
import { resolveTagline } from '../core/content-bundle.js';

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

  buildDescription(bundle: ContentBundle): string {
    const mood = bundle.theme?.mood ?? 'cuento';
    const tagline = resolveTagline(bundle);
    const forWhom = tagline ? `para ${tagline}` : 'hecho a medida';
    const durationMin = (bundle.sourceMeta?.estimatedDurationMin as number | undefined) ?? null;
    const vocab = Array.isArray(bundle.sourceMeta?.vocabularioNuevo) && (bundle.sourceMeta!.vocabularioNuevo as unknown[]).length
      ? `\n\nVocabulario nuevo: ${(bundle.sourceMeta!.vocabularioNuevo as string[]).join(', ')}`
      : '';
    const durationLine = durationMin != null ? ` · Duración: ~${durationMin} min` : '';
    return (
      `${bundle.text.body.slice(0, 300).trim()}...\n\n` +
      `Un audiocuento de AudioKids ${forWhom}.\n` +
      `Género: ${mood}${durationLine}${vocab}\n\n` +
      `#audiocuentos #cuentosinfantiles #${mood}`
    );
  }
}
