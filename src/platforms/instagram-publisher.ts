import { PostizVideoPublisher } from './postiz-video-publisher.js';
import type { Platform, StoryAssets } from '../types.js';

export class InstagramPublisher extends PostizVideoPublisher {
  readonly platform: Platform = 'instagram';

  protected buildCaption(assets: StoryAssets): string {
    const { titulo, mood, contenido } = assets.metadata;
    return `"${titulo}" · un audiocuento de AudioKids\n\n${contenido.slice(0, 160)}...\n\n#audiocuentos #${mood} #cuentosinfantiles`;
  }
}
