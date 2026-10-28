import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { config, assertPostizConfigured } from '../config.js';
import type { Platform } from '../types.js';

export type PostizProvider = Exclude<Platform, 'spotify'> | 'instagram-standalone';
export type PostizMode = 'now' | 'schedule' | 'draft';
export interface PostizMediaUpload { id: string; path: string; url?: string }
export interface PostizIntegration { id: string; name: string; providerIdentifier: string; disabled: boolean }
export interface CreatePostInput {
  platform: Platform; integrationId: string; text: string; videoPath?: string;
  scheduledDate?: string; platformSettings?: Record<string, unknown>;
}
export interface CreatePostResult { postId: string; integrationId?: string; url?: string; scheduledDate: string }
export interface CreateMediaPostInput {
  provider: PostizProvider; integrationId: string; mode: PostizMode; text: string;
  date?: string; settings: Record<string, unknown>; media: PostizMediaUpload[];
}
export interface PostizPost {
  id: string; state: string; releaseURL?: string | null; error?: string | null;
  publishDate?: string; settings?: Record<string, unknown>;
  integration: { id: string; providerIdentifier: string };
}
export interface PostizWindow { startDate: string; endDate: string }
/** Keep usable IDs when the surrounding receipt is contradictory or partial. */
export class PostizReceiptError extends Error {
  constructor(message: string, readonly postIds: string[] = [], readonly media?: PostizMediaUpload) { super(message); }
}
const providers = new Set(['x', 'tiktok', 'instagram', 'instagram-standalone', 'youtube']);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

export class PostizClient {
  /** Endpoint identity is persisted by approved-media receipts, never the key. */
  readonly scope: string;
  constructor(private readonly apiUrl = config.postiz.apiUrl, private readonly apiKey = config.postiz.apiKey) {
    if (apiUrl === config.postiz.apiUrl && apiKey === config.postiz.apiKey) assertPostizConfigured();
    else if (!text(apiKey)) throw new Error('postiz_key_required');
    const url = new URL(apiUrl);
    if (url.username || url.password || url.search || url.hash) throw new Error('invalid_postiz_endpoint');
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)
        && process.env.POSTIZ_ALLOW_INSECURE !== '1') throw new Error('postiz_https_required');
    this.scope = apiUrl.replace(/\/$/, '');
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Authorization: this.apiKey };
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    let response: Response;
    try {
      response = await fetch(`${this.scope}${path}`, { method, headers, body: payload,
        redirect: 'error', signal: AbortSignal.timeout(15000) });
    } catch { throw new Error('postiz_transport_error'); }
    if (!response.ok) throw new Error(`Postiz ${method} ${path.split('?')[0]} failed [${response.status}]`);
    const raw = await response.text();
    if (raw.length > 4 * 1024 * 1024) throw new Error('postiz_response_too_large');
    try { return JSON.parse(raw) as T; } catch { throw new Error('invalid_postiz_response'); }
  }

  async listIntegrations(): Promise<PostizIntegration[]> {
    const result = await this.request<unknown>('GET', '/integrations');
    if (!Array.isArray(result) || result.some(row => !object(row) || !text(row.id)
        || !text(row.providerIdentifier) || typeof row.disabled !== 'boolean')) throw new Error('invalid_postiz_integrations');
    return result as PostizIntegration[];
  }

  async getIntegration(id: string): Promise<PostizIntegration> {
    const matches = (await this.listIntegrations()).filter(item => item.id === id && !item.disabled);
    if (matches.length !== 1) throw new Error('explicit_postiz_integration_unavailable');
    return matches[0];
  }

  async findIntegration(platform: Platform, integrationId?: string): Promise<PostizIntegration> {
    if (!providers.has(platform)) throw new Error('unsupported_postiz_platform');
    const matches = (await this.listIntegrations()).filter(item => item.providerIdentifier === platform
      && !item.disabled && (integrationId === undefined || item.id === integrationId));
    if (matches.length !== 1) throw new Error('explicit_postiz_integration_required_or_ambiguous');
    return matches[0];
  }

  async uploadMedia(filePath: string, mimeType = 'application/octet-stream', expectedSha256?: string): Promise<PostizMediaUpload> {
    let cursor = resolve(filePath);
    for (;;) {
      if (lstatSync(cursor).isSymbolicLink()) throw new Error('media_symlink_forbidden');
      const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
    }
    const fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.nlink !== 1 || before.size > 512 * 1024 * 1024) throw new Error('unsafe_media_file');
      bytes = readFileSync(fd);
      const after = fstatSync(fd);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
          || bytes.length !== after.size) throw new Error('media_changed_during_read');
    } finally { closeSync(fd); }
    if (expectedSha256 && createHash('sha256').update(bytes).digest('hex') !== expectedSha256) throw new Error('media_hash_mismatch');
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)], { type: mimeType }), basename(filePath));
    form.append('adjust', 'false'); // Approved bytes must not be silently re-encoded.
    const result = await this.request<unknown>('POST', '/upload', form);
    if (!object(result) || !text(result.id) || !text(result.path)) throw new PostizReceiptError('invalid_postiz_media_receipt', [],
      object(result) && text(result.id) ? { id: result.id, path: typeof result.path === 'string' ? result.path : '' } : undefined);
    return { id: result.id, path: result.path };
  }

  /** Uploaded media references are inputs, so creation never uploads again. */
  async createMediaPost(input: CreateMediaPostInput): Promise<CreatePostResult> {
    if (!providers.has(input.provider) || !text(input.integrationId) || !['now', 'schedule', 'draft'].includes(input.mode)
        || input.settings.__type !== input.provider || !Array.isArray(input.media)
        || input.media.some(item => !text(item.id) || !text(item.path))) throw new Error('invalid_postiz_post_input');
    const date = input.date ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(date))) throw new Error('invalid_postiz_post_date');
    const body = { type: input.mode, date, shortLink: false, tags: [], posts: [{
      integration: { id: input.integrationId }, value: [{ content: input.text, image: input.media }], settings: input.settings,
    }] };
    const response = await this.request<unknown>('POST', '/posts', body);
    if (!Array.isArray(response) || response.length !== 1 || !object(response[0])
        || !text(response[0].postId) || response[0].integration !== input.integrationId) throw new PostizReceiptError('invalid_postiz_post_receipt',
      Array.isArray(response) ? response.flatMap(row => object(row) && text(row.postId) ? [row.postId] : []) : []);
    return { postId: response[0].postId, integrationId: input.integrationId, scheduledDate: date };
  }

  /** Legacy signature remains usable with the documented wire contract. */
  async createPost(input: CreatePostInput): Promise<CreatePostResult> {
    if (!providers.has(input.platform)) throw new Error('unsupported_postiz_platform');
    const media = input.videoPath ? [await this.uploadMedia(input.videoPath)] : [];
    return this.createMediaPost({ provider: input.platform as PostizProvider, integrationId: input.integrationId,
      text: input.text, media, mode: input.scheduledDate ? 'schedule' : 'now', date: input.scheduledDate,
      settings: { ...input.platformSettings, __type: input.platform } });
  }

  async getPost(postId: string, integrationId: string, window: PostizWindow): Promise<PostizPost | null> {
    const query = new URLSearchParams(window as unknown as Record<string, string>);
    const response = await this.request<unknown>('GET', `/posts?${query}`);
    if (!object(response) || !Array.isArray(response.posts)) throw new Error('invalid_postiz_posts');
    const matches = response.posts.filter(row => object(row) && row.id === postId && object(row.integration) && row.integration.id === integrationId);
    if (matches.length > 1) throw new Error('ambiguous_postiz_readback');
    if (!matches.length) return null;
    const found = matches[0];
    if (!text(found.state) || !text(found.integration.providerIdentifier)) throw new Error('invalid_postiz_readback');
    return found as PostizPost;
  }
}
