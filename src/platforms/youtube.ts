import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config.js';
import { run } from '../lib/process.js';

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
 * Delegates YouTube publishing to the `youtube_cli` escript (register, then upload)
 * (the operator's existing tool). YouTube descriptions are built upstream by
 * `buildCaption({ platform: 'youtube', brand })` in caption-builder.ts so the
 * brand identity threads through; this adapter is only the shell-out layer.
 */
export class YoutubeAdapter {
  constructor(
    private readonly projectPath: string = config.youtubecli.path,
    private readonly channelId?: string,
  ) {}

  async upload(input: YoutubeUploadInput): Promise<YoutubeUploadResult> {
    if (!existsSync(input.videoPath))   throw new Error(`Video not found: ${input.videoPath}`);
    if (!existsSync(this.projectPath))  throw new Error(`YouTubeCLI path not found: ${this.projectPath}`);

    const executable = resolve(this.projectPath, 'youtube_cli');
    if (!existsSync(executable)) throw new Error(`YouTubeCLI escript not found: ${executable}. Build it with mix escript.build.`);
    const channelArgs = this.channelId ? ['--channel', this.channelId] : [];
    const registered = await run(executable, ['video', 'register', resolve(input.videoPath), ...channelArgs], { cwd: this.projectPath });
    const localId = registered.stdout.match(/^\s*Video ID:\s*([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\s*$/im)?.[1];
    if (!localId) throw new Error('Could not parse local Video ID from YouTubeCLI registration output; upload was not attempted.');

    const args = [
      'video', 'upload', localId,
      '--title', input.title,
      '--description', input.description,
      '--privacy', input.privacy ?? 'private',
    ];
    if (input.tags?.length) args.push('--tags', input.tags.join(','));
    if (input.publishAt)    args.push('--publish-at', input.publishAt);
    if (input.categoryId)   args.push('--category', input.categoryId);

    args.push(...channelArgs);

    try {
      const { stdout } = await run(executable, args, { cwd: this.projectPath });
      const videoId = stdout.match(/^\s*YouTube ID:\s*([A-Za-z0-9_-]{11})\s*$/m)?.[1];
      if (!videoId) throw new Error('YouTubeCLI did not return a valid YouTube ID');
      return { videoId, url: `https://www.youtube.com/watch?v=${videoId}` };
    } catch (cause) {
      // An upload may have reached YouTube even if the CLI lost the response.
      throw Object.assign(new Error(
        `YouTube upload outcome is uncertain for local video ${localId}. Verify the channel before retrying: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      ), { code: 'YOUTUBE_PUBLISH_UNCERTAIN' });
    }
  }
}
