import { existsSync } from 'node:fs';
import type { ContentBundle } from './content-bundle.js';
import type { Platform } from '../types.js';
import { VARIANTS } from '../types.js';
import { probeDurationSec, probeBitrateKbps } from '../lib/ffprobe.js';
import { config } from '../config.js';

export interface PreflightOk { ok: true }
export interface PreflightSkip {
  ok: false;
  reason: string;
  /**
   * Error kind for the stuck-slug detector. Preflight skips with kind='permanent'
   * would cause dispatch to backoff; use 'permanent' sparingly. Most preflight
   * skips should be 'skip' (soft, not stored as failure).
   */
  kind: 'transient' | 'permanent' | 'needs-config' | 'skip';
  hint?: string;
}
export type PreflightResult = PreflightOk | PreflightSkip;

const SPLITTABLE_PLATFORMS = new Set<Platform>(['instagram']);
const SPOTIFY_RSS_ONLY: Platform = 'spotify';

/** Platforms that accept a caption-only post without any media. */
const TEXT_ONLY_PLATFORMS = new Set<Platform>(['x']);

export interface PreflightDeps {
  probeDuration?: (audioPath: string) => Promise<number>;
  probeBitrate?: (audioPath: string) => Promise<number>;
}

export interface PreflightOptions {
  minBitrateKbps?: number;
}

/**
 * Fast check before expensive render/upload work. Refuses early when the target
 * platform cannot accept this bundle (oversize audio, missing media, RSS-only,
 * bitrate too low for a decent video, text-only on a media-required platform).
 * Saves 2-3 minutes of wasted render time when the publish was doomed anyway.
 */
export async function preflightPlatform(
  bundle: ContentBundle,
  platform: Platform,
  deps: PreflightDeps = {},
  options: PreflightOptions = {},
): Promise<PreflightResult> {
  if (platform === SPOTIFY_RSS_ONLY) {
    return { ok: false, reason: 'spotify is RSS-only; use `postiz-agent rss` to rebuild the feed', kind: 'skip' };
  }

  const variant = VARIANTS[platform];
  if (!variant) {
    return { ok: false, reason: `no video variant defined for platform "${platform}"`, kind: 'permanent' };
  }

  switch (bundle.kind) {
    case 'text':
      return preflightText(platform);
    case 'image-post':
      return preflightImage(bundle, platform);
    case 'video':
      return preflightVideo(bundle, platform, deps);
    case 'audio-story':
      return preflightAudioStory(bundle, platform, variant.maxDurationSec, deps, options);
  }
}

function preflightText(platform: Platform): PreflightResult {
  if (!TEXT_ONLY_PLATFORMS.has(platform)) {
    return {
      ok: false,
      reason: `${platform} requires media; bundle.kind='text' has none`,
      kind: 'permanent',
      hint: `drop ${platform} from --platforms for text-only bundles, or attach primaryMedia`,
    };
  }
  return { ok: true };
}

function preflightImage(bundle: ContentBundle, _platform: Platform): PreflightResult {
  if (!bundle.primaryMedia) {
    return {
      ok: false,
      reason: 'image-post bundle requires primaryMedia (the image file)',
      kind: 'permanent',
      hint: 'set bundle.primaryMedia to a PNG/JPEG path',
    };
  }
  if (!existsSync(bundle.primaryMedia)) {
    return {
      ok: false,
      reason: `image not found on disk: ${bundle.primaryMedia}`,
      kind: 'permanent',
      hint: 'regenerate the image or fix the path',
    };
  }
  return { ok: true };
}

async function preflightVideo(
  bundle: ContentBundle,
  platform: Platform,
  deps: PreflightDeps,
): Promise<PreflightResult> {
  const probe = deps.probeDuration ?? probeDurationSec;
  if (!bundle.primaryMedia) {
    return {
      ok: false,
      reason: 'video bundle requires primaryMedia (the MP4 file)',
      kind: 'permanent',
      hint: 'set bundle.primaryMedia to an MP4 path',
    };
  }
  if (!existsSync(bundle.primaryMedia)) {
    return {
      ok: false,
      reason: `video not found on disk: ${bundle.primaryMedia}`,
      kind: 'permanent',
      hint: 'regenerate the video or fix the path',
    };
  }
  const variant = VARIANTS[platform]!;
  try {
    const duration = await probe(bundle.primaryMedia);
    if (duration > variant.maxDurationSec) {
      return {
        ok: false,
        reason: `video duration ${Math.round(duration)}s exceeds ${platform} limit ${variant.maxDurationSec}s`,
        kind: 'permanent',
        hint: `trim the video before publishing or drop ${platform} from --platforms`,
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: `could not probe video duration: ${msg}`,
      kind: 'needs-config',
      hint: 'verify ffprobe is installed and the video file is valid',
    };
  }
  return { ok: true };
}

async function preflightAudioStory(
  bundle: ContentBundle,
  platform: Platform,
  maxDurationSec: number,
  deps: PreflightDeps,
  options: PreflightOptions,
): Promise<PreflightResult> {
  const probe = deps.probeDuration ?? probeDurationSec;
  const probeBitrate = deps.probeBitrate ?? probeBitrateKbps;
  const minBitrateKbps = options.minBitrateKbps ?? config.audio.minBitrateKbps;

  if (!bundle.primaryMedia) {
    return { ok: false, reason: 'bundle.primaryMedia is missing (no audio source)', kind: 'permanent' };
  }
  if (!existsSync(bundle.primaryMedia)) {
    return {
      ok: false,
      reason: `primaryMedia not found on disk: ${bundle.primaryMedia}`,
      kind: 'permanent',
      hint: 'regenerate the source asset or fix the path',
    };
  }
  if (bundle.cover && !existsSync(bundle.cover)) {
    return {
      ok: false,
      reason: `cover not found on disk: ${bundle.cover}`,
      kind: 'permanent',
      hint: 'regenerate the cover or drop bundle.cover',
    };
  }

  try {
    const kbps = await probeBitrate(bundle.primaryMedia);
    if (kbps < minBitrateKbps) {
      return {
        ok: false,
        reason: `audio bitrate ${kbps} kbps is below minimum ${minBitrateKbps} kbps`,
        kind: 'permanent',
        hint: 'regenerate MP3 at higher quality (at least 64 kbps, 128+ recommended)',
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: `could not probe audio bitrate: ${msg}`,
      kind: 'needs-config',
      hint: 'verify ffprobe is installed and the audio file is a valid MP3',
    };
  }

  try {
    const duration = await probe(bundle.primaryMedia);
    if (duration > maxDurationSec && !SPLITTABLE_PLATFORMS.has(platform)) {
      return {
        ok: false,
        reason: `audio duration ${Math.round(duration)}s exceeds ${platform} limit ${maxDurationSec}s`,
        kind: 'permanent',
        hint: platform === 'x'
          ? 'X Premium is required for >10min videos; drop x from --platforms or upgrade tier'
          : `shorten the source audio or drop ${platform} from --platforms`,
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: `could not probe audio duration: ${msg}`,
      kind: 'needs-config',
      hint: 'verify ffprobe is installed and the audio file is a valid MP3',
    };
  }

  return { ok: true };
}
