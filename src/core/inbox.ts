import type { Platform } from '../types.js';

/**
 * Inbox = unified view of inbound interactions an external agent needs to
 * triage: replies, mentions, DMs, comments, depending on the platform.
 *
 * Phase 5 ships notify-only providers: postiz-agent fetches the inbox via the
 * platform's API and exposes it through tools. Drafting and posting the
 * response stays with the LLM-agent; we just give it the surface to read +
 * post back. Auto-reply policies belong in the agent's prompt, not here.
 */

export type InboxItemKind = 'reply' | 'mention' | 'comment' | 'dm';

export interface InboxItem {
  /** Stable identifier from the platform. Used by reply() and markHandled(). */
  id: string;
  platform: Platform;
  kind: InboxItemKind;
  /** The id of the post / video / DM thread this item belongs to. May be undefined for top-level mentions. */
  threadId?: string;
  /** Author handle/username on the platform. Without leading @. */
  author: string;
  /** Free-form display name when known (X "name", YouTube channel title, ...). */
  authorDisplayName?: string;
  /** Plain-text body of the interaction. */
  text: string;
  /** When the platform recorded it. ISO 8601. */
  createdAt: string;
  /** Permalink to the interaction on the platform, if available. */
  url?: string;
}

export interface InboxListResult {
  platform: Platform;
  items: InboxItem[];
  /** Opaque cursor for pagination. Pass back in `since` next call. */
  cursor?: string;
}

export interface PostReplyResult {
  /** Id of the new reply / comment we posted. */
  id: string;
  /** Permalink, when the platform returns one. */
  url?: string;
}

export interface InboxProvider {
  readonly name: string;
  readonly platform: Platform;
  /**
   * List inbox items. `since` is the opaque cursor returned by the previous
   * call; without it the provider returns the latest unread/unseen window.
   */
  listPending(opts?: { since?: string; limit?: number }): Promise<InboxListResult>;
  /** Post a reply to an existing inbox item by id. */
  postReply(toId: string, text: string): Promise<PostReplyResult>;
}
