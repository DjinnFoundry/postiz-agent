import type { Platform } from '../types.js';
import type { PlatformPublisher } from './base.js';
import { XPublisher } from './x-publisher.js';
import { TiktokPublisher } from './tiktok-publisher.js';
import { InstagramPublisher } from './instagram-publisher.js';
import { YoutubePublisher } from './youtube-publisher.js';
import { SpotifyPublisher } from './spotify-publisher.js';

export function getPublisher(platform: Platform): PlatformPublisher {
  switch (platform) {
    case 'x':         return new XPublisher();
    case 'tiktok':    return new TiktokPublisher();
    case 'instagram': return new InstagramPublisher();
    case 'youtube':   return new YoutubePublisher();
    case 'spotify':   return new SpotifyPublisher();
  }
}
