import { PostizVideoPublisher } from './postiz-video-publisher.js';
import type { Platform, StoryAssets } from '../types.js';
import { brandFor, hashtagsFor } from './copy.js';

export class XPublisher extends PostizVideoPublisher {
  readonly platform: Platform = 'x';

  protected buildCaption(assets: StoryAssets): string {
    return `"${assets.metadata.title}" · ${brandFor(assets)}\n\n${hashtagsFor(assets, ['audio', 'storytelling'])}`;
  }
}
