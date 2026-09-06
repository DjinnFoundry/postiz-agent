import type { PostizClient } from './postiz.js';
import type { YoutubeAdapter } from './youtube.js';
import type { SlideVideoBuilder } from '../media/slide-video.js';
import type { Platform } from '../types.js';
import type { PlatformPublisher } from './base.js';
import { XPublisher } from './x-publisher.js';
import { TiktokPublisher } from './tiktok-publisher.js';
import { InstagramPublisher } from './instagram-publisher.js';
import { YoutubePublisher } from './youtube-publisher.js';
import { SpotifyPublisher } from './spotify-publisher.js';

export interface PublisherDependencies {
  postiz?: () => PostizClient;
  youtube?: YoutubeAdapter;
  slides?: SlideVideoBuilder;
}

export function getPublisher(platform: Platform, deps: PublisherDependencies = {}): PlatformPublisher {
  switch (platform) {
    case 'x':         return new XPublisher(deps.postiz, deps.slides);
    case 'tiktok':    return new TiktokPublisher(deps.postiz, deps.slides);
    case 'instagram': return new InstagramPublisher(deps.postiz, undefined, deps.slides);
    case 'youtube':   return new YoutubePublisher(deps.youtube, deps.slides);
    case 'spotify':   return new SpotifyPublisher();
  }
}
