import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PostizClient } from '../../src/platforms/postiz.js';

vi.mock('../../src/config.js', () => ({
  config: { postiz: { apiUrl: 'https://fixture.invalid/public/v1', apiKey: 'explicit-test-key' } },
  assertPostizConfigured: () => {},
}));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

describe('Postiz current public API contract', () => {
  it('schedules with flat provider settings and parses postId/integration array', async () => {
    const fetch = vi.fn().mockResolvedValue(response([{ postId: 'post-fixture', integration: 'account-fixture' }]));
    vi.stubGlobal('fetch', fetch);
    const result = await new PostizClient().createPost({ platform: 'instagram', integrationId: 'account-fixture',
      text: 'Approved caption', scheduledDate: '2030-01-01T12:00:00Z', platformSettings: { post_type: 'post' } });
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body).toMatchObject({ type: 'schedule', posts: [{ integration: { id: 'account-fixture' },
      settings: { __type: 'instagram', post_type: 'post' } }] });
    expect(result.postId).toBe('post-fixture');
  });

  it('requires an explicit account when there are multiple active integrations', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => response([
      { id: 'first', name: 'First', providerIdentifier: 'tiktok', disabled: false },
      { id: 'intended', name: 'Intended', providerIdentifier: 'tiktok', disabled: false },
    ])));
    const client = new PostizClient();
    await expect(client.findIntegration('tiktok')).rejects.toThrow(/explicit|ambiguous/);
    expect((await client.findIntegration('tiktok', 'intended')).id).toBe('intended');
    await expect(client.findIntegration('tiktok', 'missing')).rejects.toThrow();
  });

  it('uploads the hashed original bytes with adjust=false and an explicit mime type', async () => {
    const root = mkdtempSync(join(process.env.TMPDIR!, 'postiz-contract-'));
    try {
      const path = join(root, 'approved.mp4');
      writeFileSync(path, Buffer.from('000000186674797069736F6D0000000069736F6D', 'hex'));
      const expected = createHash('sha256').update(readFileSync(path)).digest('hex');
      const fetch = vi.fn().mockResolvedValue(response({ id: 'media-fixture', path: 'https://media.invalid/approved.mp4' }));
      vi.stubGlobal('fetch', fetch);
      await new PostizClient().uploadMedia(path, 'video/mp4', expected);
      const body = fetch.mock.calls[0][1].body as FormData;
      expect(body.get('adjust')).toBe('false');
      expect((body.get('file') as Blob).type).toBe('video/mp4');
      expect(Buffer.from(await (body.get('file') as Blob).arrayBuffer())).toEqual(readFileSync(path));
      await expect(new PostizClient().uploadMedia(path, 'video/mp4', '0'.repeat(64))).rejects.toThrow(/hash/);
      expect(fetch).toHaveBeenCalledOnce();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('separates media creation and reads back only the requested post/account', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response([{ postId: 'post-fixture', integration: 'account-fixture' }]))
      .mockResolvedValueOnce(response({ posts: [
        { id: 'post-fixture', state: 'PUBLISHED', releaseURL: 'https://www.instagram.com/reel/fixture/',
          integration: { id: 'account-fixture', providerIdentifier: 'instagram' } },
        { id: 'other', state: 'PUBLISHED', integration: { id: 'other' } },
      ] }));
    vi.stubGlobal('fetch', fetch);
    const client = new PostizClient();
    await client.createMediaPost({ provider: 'instagram', integrationId: 'account-fixture', mode: 'draft',
      text: 'Approved caption', settings: { __type: 'instagram', post_type: 'post' },
      media: [{ id: 'media-fixture', path: 'https://media.invalid/approved.mp4' }] });
    expect(JSON.parse(fetch.mock.calls[0][1].body).type).toBe('draft');
    const post = await client.getPost('post-fixture', 'account-fixture', { startDate: '2026-01-01T00:00:00Z', endDate: '2030-01-02T00:00:00Z' });
    expect(post?.state).toBe('PUBLISHED');
    expect(fetch.mock.calls[1][0]).toContain('startDate=');
    expect(fetch.mock.calls[1][1].method).toBe('GET');
  });

  it('rejects mismatched create receipts and never includes response bodies in errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response([{ postId: 'post', integration: 'wrong-account' }]))
      .mockResolvedValueOnce(new Response('PRIVATE SERVER BODY', { status: 403 })));
    const client = new PostizClient();
    const input = { provider: 'instagram' as const, integrationId: 'account', mode: 'now' as const, text: 'Caption',
      settings: { __type: 'instagram', post_type: 'post' }, media: [{ id: 'media', path: 'https://media.invalid/asset' }] };
    await expect(client.createMediaPost(input)).rejects.toMatchObject({ message: 'invalid_postiz_post_receipt', postIds: ['post'] });
    await expect(client.createMediaPost(input)).rejects.toThrow(/403/);
    try { await client.createMediaPost(input); } catch (error) { expect(String(error)).not.toContain('PRIVATE SERVER BODY'); }
  });
});
