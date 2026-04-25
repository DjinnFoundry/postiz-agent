import type { InboxItem, InboxListResult, InboxProvider, PostReplyResult } from '../core/inbox.js';
import type { Platform } from '../types.js';

/**
 * MockInboxProvider returns deterministic synthetic items so an external agent
 * can exercise the inbox flow end-to-end before any platform credentials are
 * connected. Useful for onboarding ("see what the inbox looks like before you
 * wire up X / IG") and for tests.
 *
 * The fixture is seeded with a small bank of replies that vary by platform so
 * captions / responses get different voices.
 */
export class MockInboxProvider implements InboxProvider {
  readonly name = 'mock';
  readonly platform: Platform;
  private posted: PostReplyResult[] = [];

  constructor(platform: Platform = 'x') {
    this.platform = platform;
  }

  async listPending(opts: { since?: string; limit?: number } = {}): Promise<InboxListResult> {
    const limit = Math.max(1, Math.min(opts.limit ?? 5, 20));
    const all = this.fixtureFor(this.platform);
    const items = all.slice(0, limit);
    return { platform: this.platform, items, cursor: items.length ? items[items.length - 1].id : undefined };
  }

  async postReply(toId: string, text: string): Promise<PostReplyResult> {
    const result: PostReplyResult = {
      id: `mock-reply-${this.posted.length + 1}-to-${toId}`,
      url: `https://mock.${this.platform}/replies/${toId}`,
    };
    // Hint that we used the text so callers can inspect it via __debug.
    if (text.length === 0) throw new Error('inbox postReply: empty text refused');
    this.posted.push(result);
    return result;
  }

  /** Test-only: peek what was "posted". */
  __debugPosted(): readonly PostReplyResult[] {
    return [...this.posted];
  }

  private fixtureFor(platform: Platform): InboxItem[] {
    const base: InboxItem[] = [
      {
        id: `${platform}-001`,
        platform,
        kind: 'reply',
        threadId: 'thread-A',
        author: 'maria_lectora',
        authorDisplayName: 'María',
        text: '¡Qué historia tan bonita! ¿Hay otra para mi sobrina de 5 años?',
        createdAt: '2026-04-25T19:32:00.000Z',
        url: `https://mock.${platform}/posts/thread-A/replies/001`,
      },
      {
        id: `${platform}-002`,
        platform,
        kind: platform === 'instagram' ? 'comment' : 'reply',
        threadId: 'thread-A',
        author: 'papa_lobo',
        authorDisplayName: 'Roberto',
        text: 'A mi peque le encantó el dragón. ¿Cómo se genera?',
        createdAt: '2026-04-25T20:10:00.000Z',
        url: `https://mock.${platform}/posts/thread-A/replies/002`,
      },
      {
        id: `${platform}-003`,
        platform,
        kind: platform === 'youtube' ? 'comment' : 'mention',
        threadId: 'thread-B',
        author: 'editor_curioso',
        text: 'Acabo de descubrir esta cuenta y me encanta el formato.',
        createdAt: '2026-04-26T08:14:00.000Z',
        url: `https://mock.${platform}/posts/thread-B/mentions/003`,
      },
    ];
    return base;
  }
}
