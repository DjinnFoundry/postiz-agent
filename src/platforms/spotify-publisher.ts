import type { PlatformPublisher, PublishContext } from './base.js';
import type { Platform, PublishResult } from '../types.js';

/**
 * Spotify (and other podcast apps) consume the RSS feed built by `SpotifyRssBuilder`.
 * There is nothing to "publish" per-story — the feed is regenerated separately and
 * Spotify polls it. This publisher is a no-op that keeps the orchestrator loop uniform,
 * but the result explicitly flags the RSS-only nature so log consumers are not misled
 * into thinking a post was actually pushed.
 */
export class SpotifyPublisher implements PlatformPublisher {
  readonly platform: Platform = 'spotify';

  async publish(_ctx: PublishContext): Promise<PublishResult> {
    return {
      platform: this.platform,
      success: true,
      postId: 'rss-only',
      url: 'rss://feed',
      timestamp: new Date().toISOString(),
    };
  }
}
