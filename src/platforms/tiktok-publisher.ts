import { PostizVideoPublisher } from './postiz-video-publisher.js';
import type { Platform, StoryAssets } from '../types.js';
import { hashtagsFor } from './copy.js';

export class TiktokPublisher extends PostizVideoPublisher {
  readonly platform: Platform = 'tiktok';

  protected buildCaption(assets: StoryAssets): string {
    return `${assets.metadata.title} 🎧 ${hashtagsFor(assets, ['storytime', 'audio'])}`;
  }
}
