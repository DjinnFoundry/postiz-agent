import { openAsBlob, statSync } from 'node:fs';
import { basename } from 'node:path';
import { z } from 'zod';
import { config, assertPostizConfigured } from '../config.js';
import { UploadCache, computeUploadTimeoutMs } from '../lib/upload-cache.js';
import { TokenBucket } from '../lib/token-bucket.js';
import type { Platform } from '../types.js';

// Postiz uses these identifiers in its `integration` field when creating posts.
// See https://docs.postiz.com/public-api/providers/
// spotify is mapped to null (not Exclude<Platform, 'spotify'>) so the Record stays
// total and the runtime guard in findIntegration() is the single source of truth:
// Orchestrator routes spotify to SpotifyRssBuilder upstream, so createPost() never
// sees it. A stricter type would duplicate that guard without catching more bugs.
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
const DEFAULT_RATE_LIMIT_PER_SEC = 10;
const DEFAULT_RATE_LIMIT_ACQUIRE_TIMEOUT_MS = 30_000;

const IntegrationSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  identifier: z.string().min(1).optional(),
  providerIdentifier: z.string().min(1).optional(),
  disabled: z.boolean(),
}).refine(i => i.identifier || i.providerIdentifier).transform(i => ({
  id: i.id, name: i.name, disabled: i.disabled,
  providerIdentifier: i.identifier ?? i.providerIdentifier!,
}));

function matchesPlatform(provider: string, platform: Platform): boolean {
  return provider === POSTIZ_PROVIDER_KEY[platform] || (platform === 'instagram' && provider === 'instagram-standalone');
}

const DEFAULT_SETTINGS: Partial<Record<Platform, Record<string, unknown>>> = {
  x: { who_can_reply_post: 'everyone' },
  instagram: { post_type: 'post' },
  tiktok: {
    privacy_level: 'PUBLIC_TO_EVERYONE', duet: false, stitch: false, comment: true,
    autoAddMusic: 'no', brand_content_toggle: false, brand_organic_toggle: false,
    content_posting_method: 'DIRECT_POST',
  },
};

class PostizHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

class UncertainPublishError extends Error {
  readonly code = 'POSTIZ_PUBLISH_UNCERTAIN';
  constructor(cause: unknown) {
    super(`Postiz publish outcome is uncertain: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

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

/**
 * Per-platform connection status as observed by `probePostizIntegrations`.
 * doctor + status both render this into their own envelope (DoctorItem
 * vs StatusCheck) so the probe keeps the shape neutral.
 */
export type IntegrationStatus =
  | { state: 'connected'; name: string; id: string }
  | { state: 'disabled'; name: string; id: string }
  | { state: 'missing' };

export type PostizIntegrationsProbe =
  | { kind: 'no-api-key' }
  | { kind: 'unreachable'; message: string }
  | { kind: 'ok'; perPlatform: Partial<Record<Platform, IntegrationStatus>>; reconnectUrl: string };

const POSTIZ_TARGET_PLATFORMS: Array<'x' | 'tiktok' | 'instagram' | 'youtube'> = [
  'x', 'tiktok', 'instagram', 'youtube',
];

/**
 * Run the same integrations probe doctor and status used to repeat verbatim:
 * if no api key → 'no-api-key'; if listIntegrations throws → 'unreachable';
 * otherwise classify each target platform as connected / disabled / missing.
 * The returned shape is neutral so callers map it into whatever check format
 * they expose (DoctorItem with hint vs StatusCheck with detail+warning).
 */
export async function probePostizIntegrations(
  apiKey: string,
  listIntegrations: () => Promise<PostizIntegration[]>,
  apiUrl: string = config.postiz.apiUrl,
): Promise<PostizIntegrationsProbe> {
  if (!apiKey) return { kind: 'no-api-key' };
  let integrations: PostizIntegration[];
  try {
    integrations = await listIntegrations();
  } catch (err) {
    return { kind: 'unreachable', message: err instanceof Error ? err.message : String(err) };
  }
  const reconnectUrl = apiUrl.replace(/\/(?:api\/)?public\/v1\/?$/, '');
  const perPlatform: Partial<Record<Platform, IntegrationStatus>> = {};
  for (const platform of POSTIZ_TARGET_PLATFORMS) {
    const candidates = integrations.filter(i => matchesPlatform(i.providerIdentifier, platform));
    const match = candidates.find(i => !i.disabled) ?? candidates[0];
    if (!match) perPlatform[platform] = { state: 'missing' };
    else if (match.disabled) perPlatform[platform] = { state: 'disabled', name: match.name, id: match.id };
    else perPlatform[platform] = { state: 'connected', name: match.name, id: match.id };
  }
  return { kind: 'ok', perPlatform, reconnectUrl };
}

export interface CreatePostInput {
  platform: Platform;
  integrationId: string;
  text: string;
  videoPath?: string;
  scheduledDate?: string;
  platformSettings?: Record<string, unknown>;
  /** Actual connected provider, including instagram-standalone. */
  providerIdentifier?: string;
}

export interface CreatePostResult {
  postId: string;
  url?: string;
  scheduledDate: string;
}

export interface PostizClientOptions {
  /** Bind each product to its own account when an organization has several. */
  integrationIds?: Partial<Record<Platform, string>>;
  platformSettings?: Partial<Record<Platform, Record<string, unknown>>>;
  /** TTL for the in-memory integrations cache. Defaults to 30s. */
  integrationsCacheTtlMs?: number;
  /** Clock injection point for deterministic tests. */
  now?: () => number;
  /** Max sustained requests/sec. Defaults to 10. Set to 0 to disable. */
  rateLimitPerSec?: number;
  /** Burst capacity (max tokens). Defaults to rateLimitPerSec. */
  rateLimitBurst?: number;
  /** Max wait time for a rate-limit token. Defaults to 30s. */
  rateLimitAcquireTimeoutMs?: number;
  /** Sleep override for deterministic tests of rate limiter. */
  rateLimitSleep?: (ms: number) => Promise<void>;
}

export class PostizClient {
  private readonly integrationsCacheTtlMs: number;
  private readonly now: () => number;
  private readonly bucket: TokenBucket | null;
  private readonly rateLimitAcquireTimeoutMs: number;
  private integrationsInflight: Promise<PostizIntegration[]> | null = null;
  private integrationsCache: { at: number; integrations: PostizIntegration[] } | null = null;

  constructor(
    private readonly apiUrl: string = config.postiz.apiUrl,
    private readonly apiKey: string = config.postiz.apiKey,
    private readonly uploadCache: UploadCache = new UploadCache(),
    private readonly opts: PostizClientOptions = {},
  ) {
    assertPostizConfigured({ apiUrl, apiKey });
    this.apiUrl = apiUrl.replace(/\/+$/, '');
    this.integrationsCacheTtlMs = opts.integrationsCacheTtlMs ?? DEFAULT_INTEGRATIONS_CACHE_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.rateLimitAcquireTimeoutMs = opts.rateLimitAcquireTimeoutMs ?? DEFAULT_RATE_LIMIT_ACQUIRE_TIMEOUT_MS;
    const ratePerSec = opts.rateLimitPerSec ?? DEFAULT_RATE_LIMIT_PER_SEC;
    this.bucket = ratePerSec > 0
      ? new TokenBucket({
          ratePerSec,
          burst: opts.rateLimitBurst,
          now: this.now,
          sleep: opts.rateLimitSleep,
        })
      : null;
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
    if (this.bucket) await this.bucket.acquire(this.rateLimitAcquireTimeoutMs);
    const res = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new PostizHttpError(res.status, `Postiz ${method} ${path} failed [${res.status}]: ${text.slice(0, 400)}`);
    }
    return text ? JSON.parse(text) as T : ({} as T);
  }

  async listIntegrations(): Promise<PostizIntegration[]> {
    const cached = this.integrationsCache;
    if (cached && (this.now() - cached.at) <= this.integrationsCacheTtlMs) {
      return cached.integrations;
    }
    if (this.integrationsInflight) return this.integrationsInflight;

    const promise = this.request<unknown>('GET', '/integrations')
      .then(raw => {
        const parsed = z.array(IntegrationSchema).safeParse(raw);
        if (!parsed.success) throw new Error('Postiz /integrations returned an invalid response; verify the API base URL and server version');
        const list = parsed.data;
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
    const selectedId = this.opts.integrationIds?.[platform];
    const matches = integrations.filter(i => matchesPlatform(i.providerIdentifier, platform) && !i.disabled);
    if (!selectedId && matches.length > 1) {
      throw new Error(`Multiple connected Postiz integrations for ${platform}. Set postiz.integrationIds.${platform} in the tenant config to choose an account.`);
    }
    const found = selectedId ? matches.find(i => i.id === selectedId) : matches[0];
    if (!found) throw new Error(`No connected Postiz integration for ${platform}. Connect via the Postiz UI first.`);
    return found;
  }

  async uploadMedia(filePath: string): Promise<PostizMediaUpload> {
    const sha256 = await this.uploadCache.hashFile(filePath);
    const cached = this.uploadCache.get(sha256);
    if (cached) {
      console.error(`reused upload ${basename(filePath)} via sha256 cache → ${cached.mediaId}`);
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
    if (!result.id || !result.path) throw new Error('Postiz upload returned no media id/path');
    console.error(`uploaded ${name} (${stat.size}B, timeout=${timeoutMs}ms) → ${result.id}`);
    this.uploadCache.set(sha256, { mediaId: result.id, path: result.path });
    return result;
  }

  async createPost(input: CreatePostInput): Promise<CreatePostResult> {
    const key = input.providerIdentifier ?? POSTIZ_PROVIDER_KEY[input.platform];
    if (!key || !matchesPlatform(key, input.platform)) throw new Error(`Unsupported Postiz provider for ${input.platform}`);
    let scheduledDate = input.scheduledDate ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(scheduledDate))) throw new Error('Invalid Postiz scheduled date');
    const media: Array<{ id: string; path: string }> = [];
    if (input.videoPath) {
      media.push(await this.uploadMedia(input.videoPath));
    }

    const now = new Date();
    const schedule = input.scheduledDate !== undefined && Date.parse(scheduledDate) > now.getTime();
    if (!schedule) scheduledDate = now.toISOString();

    const body = {
      type: schedule ? 'schedule' : 'now',
      date: scheduledDate,
      shortLink: false,
      tags: [] as string[],
      posts: [{
        integration: { id: input.integrationId },
        value: [{
          content: input.text,
          image: media,
        }],
        settings: {
          ...DEFAULT_SETTINGS[input.platform],
          ...this.opts.platformSettings?.[input.platform],
          ...input.platformSettings,
          __type: key,
        },
      }],
    };

    try {
      const resp = await this.request<unknown>('POST', '/posts', body);
      const parsed = z.array(z.object({ postId: z.string().min(1), integration: z.string(), url: z.string().optional() })).length(1).safeParse(resp);
      if (!parsed.success || parsed.data[0].integration !== input.integrationId) {
        throw new Error('Postiz did not return the expected post id and integration');
      }
      const post = parsed.data[0];
      return { postId: post.postId, url: post.url, scheduledDate };
    } catch (err) {
      // An explicit rejection can be retried according to its status. A lost or
      // unrecognizable response may hide a successful create, so fail closed.
      if (err instanceof PostizHttpError && err.status < 500 && err.status !== 408) throw err;
      throw new UncertainPublishError(err);
    }
  }
}
