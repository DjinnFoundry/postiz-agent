import { join } from 'node:path';
import type { ContentBundle } from './content-bundle.js';
import type { Platform, WordEntry } from '../types.js';

/**
 * Decides what file (if any) the publisher should upload to a given platform,
 * branching on the bundle.kind. Centralises the kind → media path so each
 * publisher does not have to re-implement the dispatch.
 *
 *   audio-story  → render a slide video (whisper transcript synced) and upload it
 *   video        → upload primaryMedia (the MP4) as-is, no slide render
 *   image-post   → upload primaryMedia (the image) as-is, no slide render
 *   text         → no media at all (caption-only post)
 */
export interface MediaForPlatform {
  /** Final media path to upload, or null for text-only kinds. */
  mediaPath: string | null;
  /** True when the slide-video builder was invoked (audio-story path). */
  needsSlideRender: boolean;
  /** Non-fatal advisories surfaced by the slide builder when it ran. */
  warnings: string[];
}

export interface SlideBuilderLike {
  build(input: {
    platform: Platform;
    bundle: ContentBundle;
    outputPath: string;
    words: WordEntry[];
    clipStartSec?: number;
    clipDurationSec?: number;
    partIndex?: number;
    partTotal?: number;
    onWarn?: (msg: string) => void;
  }): Promise<{ outputPath: string; warnings: string[] }>;
}

export interface ResolveMediaInput {
  bundle: ContentBundle;
  platform: Platform;
  words: WordEntry[];
  slideBuilder: SlideBuilderLike;
  workDir: string;
  /** Multi-part overrides forwarded to the slide builder when applicable. */
  clipStartSec?: number;
  clipDurationSec?: number;
  partIndex?: number;
  partTotal?: number;
  onWarn?: (msg: string) => void;
}

export async function resolveMediaForPlatform(input: ResolveMediaInput): Promise<MediaForPlatform> {
  const { bundle, platform, words, slideBuilder, workDir } = input;

  switch (bundle.kind) {
    case 'audio-story': {
      if (!bundle.primaryMedia) {
        throw new Error(`audio-story bundle "${bundle.id}" requires primaryMedia (an audio file)`);
      }
      const partSuffix = input.partIndex ? `-part${input.partIndex}` : '';
      const outputPath = join(workDir, `${bundle.id}-${platform}${partSuffix}.mp4`);
      const built = await slideBuilder.build({
        platform,
        bundle,
        outputPath,
        words,
        ...(input.clipStartSec != null ? { clipStartSec: input.clipStartSec } : {}),
        ...(input.clipDurationSec != null ? { clipDurationSec: input.clipDurationSec } : {}),
        ...(input.partIndex != null ? { partIndex: input.partIndex } : {}),
        ...(input.partTotal != null ? { partTotal: input.partTotal } : {}),
        ...(input.onWarn ? { onWarn: input.onWarn } : {}),
      });
      return { mediaPath: built.outputPath, needsSlideRender: true, warnings: built.warnings };
    }

    case 'video': {
      if (!bundle.primaryMedia) {
        throw new Error(`video bundle "${bundle.id}" requires primaryMedia (a video file)`);
      }
      return { mediaPath: bundle.primaryMedia, needsSlideRender: false, warnings: [] };
    }

    case 'image-post': {
      if (!bundle.primaryMedia) {
        throw new Error(`image-post bundle "${bundle.id}" requires primaryMedia (an image file)`);
      }
      return { mediaPath: bundle.primaryMedia, needsSlideRender: false, warnings: [] };
    }

    case 'text':
      return { mediaPath: null, needsSlideRender: false, warnings: [] };
  }
}
