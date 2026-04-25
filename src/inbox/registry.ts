import type { InboxProvider } from '../core/inbox.js';
import type { Platform } from '../types.js';
import { MockInboxProvider } from './mock.js';

/**
 * Inbox provider registry, parallel to the BundleAdapter registry. Today only
 * the `mock` provider ships; future entries (X, YouTube, Instagram, ...) get
 * registered here as they land. Each tenant can choose which provider runs
 * for which platform via `tenants/<slug>/config.json`'s `inbox` block.
 */
export interface InboxRegistry {
  /** Get the configured provider for a platform, or null when not wired. */
  get(platform: Platform): InboxProvider | null;
  /** List the set of platforms with a provider available. */
  platforms(): Platform[];
}

export interface RegistryOptions {
  /** Force everything to mock, regardless of tenant config. Useful for `init` / smokes. */
  allMock?: boolean;
  /** Per-platform override. Wins over the default. */
  perPlatform?: Partial<Record<Platform, InboxProvider>>;
}

/**
 * Default registry: maps every supported platform to a MockInboxProvider so
 * the toolkit always has SOMETHING to show, then lets callers override with
 * real providers as they become available.
 */
export function createInboxRegistry(opts: RegistryOptions = {}): InboxRegistry {
  const map = new Map<Platform, InboxProvider>();
  const platforms: Platform[] = ['x', 'tiktok', 'instagram', 'youtube'];
  for (const p of platforms) {
    if (opts.perPlatform?.[p]) {
      map.set(p, opts.perPlatform[p]!);
    } else if (opts.allMock !== false) {
      map.set(p, new MockInboxProvider(p));
    }
  }
  return {
    get: (platform: Platform) => map.get(platform) ?? null,
    platforms: () => [...map.keys()].sort(),
  };
}
