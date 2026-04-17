import { PostizVideoPublisher } from './postiz-video-publisher.js';
import type { Platform, StoryAssets } from '../types.js';

export class XPublisher extends PostizVideoPublisher {
  readonly platform: Platform = 'x';

  protected buildCaption(assets: StoryAssets): string {
    const { titulo, mood } = assets.metadata;
    return `"${titulo}" · un audiocuento de AudioKids\n\n#audiocuentos #${mood} #cuentosinfantiles`;
  }
}
