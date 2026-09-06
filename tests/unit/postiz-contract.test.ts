import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostizClient } from '../../src/platforms/postiz.js';
import { config } from '../../src/config.js';
import { classifyError } from '../../src/core/errors.js';
import { retry } from '../../src/lib/retry.js';

const originalConfig = { ...config.postiz };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const post = { platform: 'x' as const, integrationId: 'account-x', text: 'Prueba de producto' };
const client = (options = {}) => new PostizClient('https://postiz.test/api/public/v1', 'tenant-key', undefined, options);

beforeEach(() => {
  config.postiz.apiKey = 'global-key';
  config.postiz.apiUrl = 'https://global.test/api/public/v1';
  vi.stubEnv('POSTIZ_ALLOW_INSECURE', '');
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response([{ postId: 'post-123', integration: 'account-x' }]));
});

afterEach(() => {
  Object.assign(config.postiz, originalConfig);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('Postiz public API contract', () => {
  it('uses the tenant credentials even when global Postiz is unconfigured', async () => {
    config.postiz.apiKey = '';
    const result = await client().createPost(post);
    expect(result.postId).toBe('post-123');
    expect(vi.mocked(fetch).mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'tenant-key' });
  });

  it('validates the injected URL and key before making requests', () => {
    expect(() => new PostizClient('http://remote.test/api/public/v1', 'tenant-key')).toThrow(/cleartext|https/i);
    expect(() => new PostizClient('https://postiz.test/api/public/v1', '   ')).toThrow(/API_KEY/);
    expect(() => new PostizClient('http://[::1]:4007/api/public/v1', 'tenant-key')).not.toThrow();
  });

  it('accepts the documented array response and sends flat provider settings', async () => {
    const result = await client().createPost(post);
    expect(result.postId).toBe('post-123');
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body.type).toBe('now');
    expect(body.posts[0].settings).toEqual({ __type: 'x', who_can_reply_post: 'everyone' });
  });

  it('uses schedule when a publish date is provided', async () => {
    const scheduledDate = '2030-01-01T12:05:00.000Z';
    const result = await client().createPost({ ...post, scheduledDate });
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body).toMatchObject({ type: 'schedule', date: scheduledDate });
    expect(result.scheduledDate).toBe(scheduledDate);
  });

  it('rejects an invalid date before uploading any media', async () => {
    await expect(client().createPost({ ...post, scheduledDate: 'not-a-date', videoPath: '/missing.mp4' })).rejects.toThrow(/date/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('updates a scheduled time that expires during a slow media upload', async () => {
    const c = client();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2030-01-01T12:00:00Z'));
      vi.spyOn(c, 'uploadMedia').mockImplementation(async () => {
        vi.setSystemTime(new Date('2030-01-01T12:10:00Z'));
        return { id: 'media', path: 'https://uploads.test/video.mp4' };
      });
      const result = await c.createPost({ ...post, videoPath: '/video.mp4', scheduledDate: '2030-01-01T12:05:00Z' });
      const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
      expect(body.type).toBe('now');
      expect(result.scheduledDate).toBe('2030-01-01T12:10:00.000Z');
    } finally { vi.useRealTimers(); }
  });

  it('allows tenant settings while preserving the correct provider discriminator', async () => {
    await client({ platformSettings: { x: { who_can_reply_post: 'following', made_with_ai: true, __type: 'tiktok' } } }).createPost(post);
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body.posts[0].settings).toEqual({ __type: 'x', who_can_reply_post: 'following', made_with_ai: true });
  });

  it('does not use a disabled account selected in the tenant config', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response([
      { id: 'disabled', name: 'Old product', identifier: 'x', disabled: true },
      { id: 'active', name: 'Other product', identifier: 'x', disabled: false },
    ]));
    await expect(client({ integrationIds: { x: 'disabled' } }).findIntegration('x')).rejects.toThrow(/integration/i);
  });

  it('supplies required TikTok direct publishing settings', async () => {
    await client().createPost({ ...post, platform: 'tiktok' });
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body.posts[0].settings).toMatchObject({
      __type: 'tiktok', privacy_level: 'PUBLIC_TO_EVERYONE',
      duet: false, stitch: false, comment: true, autoAddMusic: 'no',
      brand_content_toggle: false, brand_organic_toggle: false, content_posting_method: 'DIRECT_POST',
    });
  });

  it('uses the actual provider type for Instagram standalone accounts', async () => {
    await client().createPost({ ...post, platform: 'instagram', providerIdentifier: 'instagram-standalone' });
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body.posts[0].settings).toMatchObject({ __type: 'instagram-standalone', post_type: 'post' });
  });

  it('normalizes the identifier returned by the integrations endpoint', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response([{ id: 'account-x', name: 'Producto', identifier: 'x', disabled: false }]));
    expect(await client().findIntegration('x')).toMatchObject({ id: 'account-x', providerIdentifier: 'x' });
  });

  it('refuses ambiguous accounts instead of publishing to the first match', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response([
      { id: 'one', name: 'Producto A', providerIdentifier: 'x', disabled: false },
      { id: 'two', name: 'Producto B', providerIdentifier: 'x', disabled: false },
    ]));
    await expect(client().findIntegration('x')).rejects.toThrow(/multiple|ambiguous|integrationIds/i);
  });

  it('selects the explicitly configured account and never falls back when it is missing', async () => {
    vi.mocked(fetch).mockImplementation(async () => response([
      { id: 'one', name: 'Producto A', identifier: 'x', disabled: false },
      { id: 'two', name: 'Producto B', identifier: 'x', disabled: false },
    ]));
    expect((await client({ integrationIds: { x: 'two' } }).findIntegration('x')).id).toBe('two');
    await expect(client({ integrationIds: { x: 'missing' } }).findIntegration('x')).rejects.toThrow(/integration/i);
  });

  it('rejects malformed integration responses without caching them', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ message: 'wrong server' }));
    const c = client();
    await expect(c.listIntegrations()).rejects.toThrow(/integrations/i);
    vi.mocked(fetch).mockResolvedValueOnce(response([]));
    expect(await c.listIntegrations()).toEqual([]);
  });

  it.each([500, 502, 504])('does not retry an ambiguous create response (%s)', async (status) => {
    vi.mocked(fetch).mockImplementation(async () => response({ message: 'upstream failed' }, status));
    const failure = await retry(() => client().createPost(post), { sleep: async () => {} }).catch(e => e);
    expect(classifyError(failure)).toMatchObject({ kind: 'needs-human', retryable: false, remediation: { action: 'reconcile-post' } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry a timed out create when the server might have accepted it', async () => {
    vi.mocked(fetch).mockRejectedValue(new DOMException('The operation timed out', 'TimeoutError'));
    const failure = await retry(() => client().createPost(post), { sleep: async () => {} }).catch(e => e);
    expect(classifyError(failure).retryable).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('treats an unrecognizable success response as uncertain', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ unexpected: true }));
    const failure = await client().createPost(post).catch(e => e);
    expect(classifyError(failure)).toMatchObject({ kind: 'needs-human', remediation: { action: 'reconcile-post' } });
  });

  it('retains retryable rate-limit failures', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ message: 'rate limit' }, 429));
    const failure = await client().createPost(post).catch(e => e);
    expect(classifyError(failure).retryable).toBe(true);
  });
});
