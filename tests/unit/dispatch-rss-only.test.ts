import { describe, expect, it } from 'vitest';
import { selectNextStory, selectPendingPlatforms } from '../../src/dispatch.js';
import type { DecisionLogEntry } from '../../src/types.js';

describe('RSS-only dispatch targets', () => {
  it('has nothing to dispatch when Spotify is the only requested platform', () => {
    expect(selectPendingPlatforms([], 'story', ['spotify'])).toEqual([]);
    expect(selectNextStory([{ slug: 'story', generatedAtMs: 0 }], [], ['spotify'])).toBeNull();
  });

  it('moves past a completed X post when Spotify is also requested', () => {
    const log: DecisionLogEntry[] = [{ id: 'id', action: 'publish.x', storySlug: 'done', platform: 'x', reason: 'test',
      createdAt: new Date().toISOString(), result: { platform: 'x', success: true, timestamp: new Date().toISOString() } }];
    expect(selectPendingPlatforms(log, 'done', ['x', 'spotify'])).toEqual([]);
    expect(selectNextStory([{ slug: 'done', generatedAtMs: 0 }, { slug: 'pending', generatedAtMs: 1 }], log, ['x', 'spotify'])).toBe('pending');
  });
});
