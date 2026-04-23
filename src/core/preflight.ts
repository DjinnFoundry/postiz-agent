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
   * would cause dispatch to backoff; use 'permanent' sparingly — most preflight
   * skips should be 'transient' or the softer 'skip' (not stored as failure).
   */
  kind: 'transient' | 'permanent' | 'needs-config' | 'skip';
  hint?: string;
}
export type PreflightResult = PreflightOk | PreflightSkip;

/** Instagram Reels supports multi-part splitting on long audio; other platforms don't. */
const SPLITTABLE_PLATFORMS = new Set<Platform>(['instagram']);
const SPOTIFY_RSS_ONLY: Platform = 'spotify';

export interface PreflightDeps {
  probeDuration?: (audioPath: string) => Promise<number>;
  probeBitrate?: (audioPath: string) => Promise<number>;
}

export interface PreflightOptions {
  minBitrateKbps?: number;
}

/**
 * Fast check before expensive render/upload work. Refuses early when the target
 * platform cannot accept this bundle (oversize audio, missing cover, RSS-only,
 * bitrate too low to produce decent video), so dispatch doesn't burn 2-3 minutes
 * rendering an MP4 that will then fail the platform capability check.
 *
 * Returns:
 *  - ok: true                  → proceed
 *  - kind: 'skip'              → soft skip (not a failure; don't count in stuck detector)
 *  - kind: 'permanent'         → real failure; record in decision log + count toward stuck
 *  - kind: 'needs-config'      → setup issue; same as permanent for counting but different hint
 */
export async function preflightPlatform(
  bundle: ContentBundle,
  platform: Platform,
  deps: PreflightDeps = {},
  options: PreflightOptions = {},
): Promise<PreflightResult> {
  const probe = deps.probeDuration ?? probeDurationSec;
  const probeBitrate = deps.probeBitrate ?? probeBitrateKbps;
  const minBitrateKbps = options.minBitrateKbps ?? config.audio.minBitrateKbps;

  if (platform === SPOTIFY_RSS_ONLY) {
    return { ok: false, reason: 'spotify is RSS-only; use `postiz-agent rss` to rebuild the feed', kind: 'skip' };
  }

  const variant = VARIANTS[platform];
  if (!variant) {
    return { ok: false, reason: `no video variant defined for platform "${platform}"`, kind: 'permanent' };
  }

  if (bundle.kind === 'audio-story' && !bundle.primaryMedia) {
    return { ok: false, reason: 'bundle.primaryMedia is missing (no audio source)', kind: 'permanent' };
  }

  if (bundle.primaryMedia && !existsSync(bundle.primaryMedia)) {
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

  if (bundle.primaryMedia && bundle.kind === 'audio-story') {
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
      if (duration > variant.maxDurationSec && !SPLITTABLE_PLATFORMS.has(platform)) {
        return {
          ok: false,
          reason: `audio duration ${Math.round(duration)}s exceeds ${platform} limit ${variant.maxDurationSec}s`,
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
  }

  return { ok: true };
}
