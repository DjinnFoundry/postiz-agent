import { PostizVideoPublisher } from './postiz-video-publisher.js';
import type { Platform, StoryAssets } from '../types.js';

export class TiktokPublisher extends PostizVideoPublisher {
  readonly platform: Platform = 'tiktok';

  protected buildCaption(assets: StoryAssets): string {
    const { titulo, mood } = assets.metadata;
    return `${titulo} 🎧 #audiocuentos #${mood} #storytime #kidsstories`;
  }
}
