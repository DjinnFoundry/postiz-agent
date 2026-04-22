import { PostizVideoPublisher } from './postiz-video-publisher.js';
import type { Platform } from '../types.js';

export class XPublisher extends PostizVideoPublisher {
  readonly platform: Platform = 'x';
}
