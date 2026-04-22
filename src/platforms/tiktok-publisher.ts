import { PostizVideoPublisher } from './postiz-video-publisher.js';
import type { Platform } from '../types.js';

export class TiktokPublisher extends PostizVideoPublisher {
  readonly platform: Platform = 'tiktok';
}
