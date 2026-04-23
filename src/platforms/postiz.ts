import { openAsBlob, statSync } from 'node:fs';
import { basename } from 'node:path';
import { config, assertPostizConfigured } from '../config.js';
import { UploadCache, computeUploadTimeoutMs } from '../lib/upload-cache.js';
import type { Platform } from '../types.js';

// Postiz uses these identifiers in its `integration` field when creating posts.
// See https://docs.postiz.com/public-api/providers/
const POSTIZ_PROVIDER_KEY: Record<Platform, string | null> = {
  x: 'x',
  tiktok: 'tiktok',
  instagram: 'instagram',
  youtube: 'youtube',
  spotify: null,
};

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
// Short TTL: parallel publish to 4 platforms collapses 4 GET /integrations into 1,
// while still picking up UI-side connect/disconnect changes within seconds.
const DEFAULT_INTEGRATIONS_CACHE_TTL_MS = 30_000;

export interface PostizMediaUpload {
  id: string;
  path: string;
  url?: string;
}

export interface PostizIntegration {
  id: string;
  name: string;
  providerIdentifier: string;
  disabled: boolean;
}

export interface CreatePostInput {
  platform: Platform;
  integrationId: string;
  text: string;
  videoPath?: string;
  scheduledDate?: string;
  platformSettings?: Record<string, unknown>;
}

export interface CreatePostResult {
  postId: string;
  url?: string;
  scheduledDate: string;
}

export interface PostizClientOptions {
  /** TTL for the in-memory integrations cache. Defaults to 30s. */
  integrationsCacheTtlMs?: number;
  /** Clock injection point for deterministic tests. */
  now?: () => number;
}

export class PostizClient {
  private readonly integrationsCacheTtlMs: number;
  private readonly now: () => number;
  // A single in-flight promise is shared so concurrent callers (parallel publish
  // across 4 platforms) collapse onto one HTTP request instead of racing.
  private integrationsInflight: Promise<PostizIntegration[]> | null = null;
  private integrationsCache: { at: number; integrations: PostizIntegration[] } | null = null;

  constructor(
    private readonly apiUrl: string = config.postiz.apiUrl,
    private readonly apiKey: string = config.postiz.apiKey,
    private readonly uploadCache: UploadCache = new UploadCache(),
    opts: PostizClientOptions = {},
  ) {
    assertPostizConfigured();
    this.integrationsCacheTtlMs = opts.integrationsCacheTtlMs ?? DEFAULT_INTEGRATIONS_CACHE_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: { contentType?: string; timeoutMs?: number } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      'Authorization': this.apiKey,
    };
    let payload: BodyInit | undefined;
    if (body instanceof FormData) {
      payload = body;
    } else if (body !== undefined) {
      headers['Content-Type'] = opts.contentType ?? 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Postiz ${method} ${path} failed [${res.status}]: ${text.slice(0, 400)}`);
    }
    return text ? JSON.parse(text) as T : ({} as T);
  }

  async listIntegrations(): Promise<PostizIntegration[]> {
    const cached = this.integrationsCache;
    if (cached && (this.now() - cached.at) <= this.integrationsCacheTtlMs) {
      return cached.integrations;
    }
    if (this.integrationsInflight) return this.integrationsInflight;

    const promise = this.request<PostizIntegration[]>('GET', '/integrations')
      .then(list => {
        this.integrationsCache = { at: this.now(), integrations: list };
        return list;
      })
      .finally(() => {
        // Clear in-flight regardless of success/failure; failed fetches must not
        // poison the cache, so the next caller retries the network.
        this.integrationsInflight = null;
      });
    this.integrationsInflight = promise;
    return promise;
  }

  /** Force the next listIntegrations()/findIntegration() to refetch from the API. */
  invalidateIntegrationsCache(): void {
    this.integrationsCache = null;
  }

  async findIntegration(platform: Platform): Promise<PostizIntegration> {
    const key = POSTIZ_PROVIDER_KEY[platform];
    if (!key) throw new Error(`Platform ${platform} is not supported by Postiz`);
    const integrations = await this.listIntegrations();
    const found = integrations.find(i => i.providerIdentifier === key && !i.disabled);
    if (!found) throw new Error(`No connected Postiz integration for ${platform}. Connect via the Postiz UI first.`);
    return found;
  }

  async uploadMedia(filePath: string): Promise<PostizMediaUpload> {
    const sha256 = await this.uploadCache.hashFile(filePath);
    const cached = this.uploadCache.get(sha256);
    if (cached) {
      console.log(`reused upload ${basename(filePath)} via sha256 cache → ${cached.mediaId}`);
      return { id: cached.mediaId, path: cached.path ?? filePath };
    }

    const name = basename(filePath);
    const stat = statSync(filePath);
    const timeoutMs = computeUploadTimeoutMs(stat.size);
    const form = new FormData();
    // openAsBlob returns a Blob backed by the file; bytes are streamed lazily during
    // fetch's multipart encode, so a 30 MB MP4 no longer costs 30 MB of resident RAM.
    const blob = await openAsBlob(filePath);
    form.append('file', blob, name);
    const result = await this.request<{ id: string; path: string; url?: string }>(
      'POST', '/upload', form, { timeoutMs },
    );
    console.log(`uploaded ${name} (${stat.size}B, timeout=${timeoutMs}ms) → ${result.id}`);
    this.uploadCache.set(sha256, { mediaId: result.id, path: result.path });
    return result;
  }

  async createPost(input: CreatePostInput): Promise<CreatePostResult> {
    const media: Array<{ id: string; path: string }> = [];
    if (input.videoPath) {
      media.push(await this.uploadMedia(input.videoPath));
    }

    const scheduledDate = input.scheduledDate ?? new Date().toISOString();
    const key = POSTIZ_PROVIDER_KEY[input.platform]!;

    const body = {
      type: 'now' as const,
      date: scheduledDate,
      shortLink: false,
      tags: [] as string[],
      posts: [{
        integration: { id: input.integrationId },
        value: [{
          content: input.text,
          image: media,
        }],
        group: 'default',
        settings: {
          [key]: input.platformSettings ?? {},
        },
      }],
    };

    const resp = await this.request<{ posts?: Array<{ id: string; url?: string }> }>(
      'POST', '/posts', body,
    );
    const post = resp.posts?.[0];
    if (!post?.id) throw new Error(`Postiz did not return a post id: ${JSON.stringify(resp).slice(0, 300)}`);
    return { postId: post.id, url: post.url, scheduledDate };
  }
}
