import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runApprovedMedia } from '../../src/approved-media.js';

vi.mock('../../src/config.js', () => { throw new Error('Operator configuration must not load in these tests'); });
const canonical = (value: any): string => value && typeof value === 'object'
  ? Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  : JSON.stringify(value);
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
let root: string;
beforeEach(() => { root = mkdtempSync(join(process.env.TMPDIR!, 'approved-media-')); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Real fetch forbidden'); })); });
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true }); });
function fixture(images = false) {
  const bytes = images ? Buffer.from('89504e470d0a1a0a00000000', 'hex') : Buffer.from('000000186674797069736F6D0000000069736F6D', 'hex');
  const media = Array.from({ length: images ? 2 : 1 }, (_, i) => {
    const path = images ? `slide-${i + 1}.png` : 'approved.mp4'; writeFileSync(join(root, path), bytes);
    return { path, sha256: hash(bytes), mimeType: images ? 'image/png' : 'video/mp4', role: images ? 'page' : 'video', ...(images ? { pageNumber: i + 1 } : {}) };
  });
  const body = { schemaVersion: 1, storyId: 'public-fixture', revision: '1'.repeat(64), kind: images ? 'image_collection' : 'video', media,
    metadata: { title: 'Public fixture', description: 'Approved caption', language: 'en', tags: ['fixture'] } };
  const manifest: any = { ...body, approval: { status: 'approved', bundleSha256: hash(canonical(body)), approvedAt: '2020-01-01T00:00:00Z' } };
  const path = join(root, 'manifest.json'); writeFileSync(path, JSON.stringify(manifest));
  return { path, manifest };
}
function client() {
  return { scope: 'https://postiz.invalid/public/v1',
    getIntegration: vi.fn(async () => ({ id: 'account', providerIdentifier: 'instagram', name: 'Fixture', disabled: false })),
    uploadMedia: vi.fn(async (_path: string) => ({ id: `media-${_path.split('/').at(-1)}`, path: `https://media.invalid/${_path.split('/').at(-1)}` })),
    createMediaPost: vi.fn(async () => ({ postId: 'post-fixture', integrationId: 'account', scheduledDate: '2026-01-01T00:00:00Z' })),
    getPost: vi.fn(async () => ({ id: 'post-fixture', state: 'QUEUE', integration: { id: 'account', providerIdentifier: 'instagram' } })),
  };
}
function options(api = client()) { return { integrationId: 'account', provider: 'instagram' as const, mode: 'now' as const,
  settings: { __type: 'instagram', post_type: 'post' }, stateDir: join(root, 'state'), allowPublish: true, client: api }; }
function state() { const file = readdirSync(join(root, 'state')).find(name => name.endsWith('.json'))!; return JSON.parse(readFileSync(join(root, 'state', file), 'utf8')); }

describe('approved media boundary', () => {
  it('plans without configuration, network or state writes', async () => {
    const { path } = fixture(); const opts = options();
    const result = await runApprovedMedia(path, { ...opts, client: undefined, allowPublish: false });
    expect(result.state).toBe('ready_for_authorization'); expect(existsSync(opts.stateDir)).toBe(false);
  });
  it('requires matching approval and all original bytes before any network', async () => {
    for (const change of ['pending', 'digest', 'bytes', 'traversal', 'symlink', 'kind']) {
      const { path, manifest } = fixture(); const opts = options();
      if (change === 'pending') manifest.approval.status = 'pending';
      if (change === 'digest') manifest.metadata.description = 'changed';
      if (change === 'bytes') writeFileSync(join(root, 'approved.mp4'), 'wrong bytes');
      if (change === 'traversal') manifest.media[0].path = '../outside.mp4';
      if (change === 'kind') manifest.kind = 'image_collection';
      if (change === 'symlink') { rmSync(join(root, 'approved.mp4')); symlinkSync(path, join(root, 'approved.mp4')); }
      writeFileSync(path, JSON.stringify(manifest));
      await expect(runApprovedMedia(path, opts)).rejects.toThrow();
      expect(opts.client.getIntegration).not.toHaveBeenCalled();
    }
  });
  it('checkpoints before upload/create, retains IDs, and never rerenders or resends accepted work', async () => {
    const { path } = fixture(); const api = client(); const opts = options(api);
    api.uploadMedia.mockImplementationOnce(async () => { expect(state().activeEffect.kind).toBe('media_upload'); return { id: 'media', path: 'https://media.invalid/approved.mp4' }; });
    api.createMediaPost.mockImplementationOnce(async () => { expect(state().activeEffect.kind).toBe('post_create'); expect(state().media[0].status).toBe('uploaded'); return { postId: 'post-fixture', integrationId: 'account', scheduledDate: '2026-01-01T00:00:00Z' }; });
    expect((await runApprovedMedia(path, opts)).state).toBe('accepted');
    expect((await runApprovedMedia(path, opts)).state).toBe('accepted');
    expect(api.uploadMedia).toHaveBeenCalledOnce(); expect(api.createMediaPost).toHaveBeenCalledOnce();
  });
  it('holds ambiguous upload/create outcomes without blind retries', async () => {
    for (const boundary of ['uploadMedia', 'createMediaPost'] as const) {
      const { path } = fixture(); const api = client(); const opts = { ...options(api), integrationId: boundary };
      api.getIntegration.mockResolvedValue({ id: boundary, providerIdentifier: 'instagram', name: 'Fixture', disabled: false });
      api[boundary].mockRejectedValueOnce(new Error('socket timeout'));
      expect((await runApprovedMedia(path, opts)).state).toBe('needs_reconciliation');
      await runApprovedMedia(path, opts); await runApprovedMedia(path, { ...opts, reconcile: true });
      expect(api[boundary]).toHaveBeenCalledOnce();
    }
  });
  it('reconciles an accepted post using GET only and requires genuine matching release evidence', async () => {
    const { path } = fixture(); const api = client(); const opts = options(api);
    await runApprovedMedia(path, opts);
    api.getPost.mockResolvedValue({ id: 'post-fixture', state: 'PUBLISHED', releaseURL: 'https://www.instagram.com/reel/fixture/', integration: { id: 'account', providerIdentifier: 'instagram' } } as any);
    expect((await runApprovedMedia(path, { ...opts, reconcile: true, allowPublish: false })).state).toBe('published');
    expect(api.uploadMedia).toHaveBeenCalledOnce(); expect(api.createMediaPost).toHaveBeenCalledOnce();
  });
  it('uploads collection pages in manifest order and preserves the resulting media references', async () => {
    const { path } = fixture(true); const api = client();
    await runApprovedMedia(path, options(api));
    expect(api.uploadMedia.mock.calls.map(call => call[0].split('/').at(-1))).toEqual(['slide-1.png', 'slide-2.png']);
    expect((api.createMediaPost.mock.calls[0] as any[])[0].media.map((m: any) => m.id)).toEqual(['media-slide-1.png', 'media-slide-2.png']);
  });
  it('rejects settings conflicts and byte changes after integration preflight before uploads', async () => {
    const { path } = fixture(); const api = client(); const opts = options(api);
    api.getIntegration.mockImplementationOnce(async () => { writeFileSync(join(root, 'approved.mp4'), 'changed after validation'); return { id: 'account', providerIdentifier: 'instagram', name: 'Fixture', disabled: false }; });
    await expect(runApprovedMedia(path, opts)).rejects.toThrow(/hash/); expect(api.uploadMedia).not.toHaveBeenCalled();
    fixture(); await runApprovedMedia(path, opts);
    await expect(runApprovedMedia(path, { ...opts, settings: { __type: 'instagram', post_type: 'post', is_trial_reel: true } })).rejects.toThrow(/conflict/);
  });
  it('uses per-key exclusion while an authorized operation is live', async () => {
    const { path } = fixture(); const api = client(); const opts = options(api); let release!: () => void;
    api.getIntegration.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return { id: 'account', providerIdentifier: 'instagram', name: 'Fixture', disabled: false }; });
    const first = runApprovedMedia(path, opts);
    while (!release) await new Promise(resolve => setTimeout(resolve, 0));
    await expect(runApprovedMedia(path, opts)).rejects.toThrow(/locked/);
    release(); await first; expect(api.createMediaPost).toHaveBeenCalledOnce();
  });
  it('keeps TikTok inbox acceptance distinct from public delivery', async () => {
    const { path } = fixture(); const api = client(); api.getIntegration.mockResolvedValue({ id: 'account', providerIdentifier: 'tiktok', name: 'Fixture', disabled: false });
    api.getPost.mockResolvedValue({ id: 'post-fixture', state: 'PUBLISHED', releaseURL: 'https://www.tiktok.com/@fixture/video/123', settings: { content_posting_method: 'UPLOAD' }, integration: { id: 'account', providerIdentifier: 'tiktok' } } as any);
    const result = await runApprovedMedia(path, { ...options(api), provider: 'tiktok', settings: {
      __type: 'tiktok', privacy_level: 'SELF_ONLY', duet: false, stitch: false, comment: false, autoAddMusic: 'no',
      brand_content_toggle: false, brand_organic_toggle: false, video_made_with_ai: true, content_posting_method: 'UPLOAD',
    } });
    expect(result.state).toBe('awaiting_manual_publish');
  });
  it('rejects duplicate JSON fields rather than interpreting the last value', async () => {
    const { path, manifest } = fixture();
    writeFileSync(path, JSON.stringify(manifest).replace('"kind":"video"', '"kind":"image_collection","kind":"video"'));
    await expect(runApprovedMedia(path, options())).rejects.toThrow(/duplicate/);
  });
  it('requires a real, zoned, nonfuture ISO approval timestamp', async () => {
    for (const value of ['1', '2020-01-01T00:00:00', '2020-02-30T00:00:00Z', new Date(Date.now() + 86400000).toISOString()]) {
      const { path, manifest } = fixture(); manifest.approval.approvedAt = value; writeFileSync(path, JSON.stringify(manifest));
      await expect(runApprovedMedia(path, options())).rejects.toThrow(/approval|approved/);
    }
  });
  it('rejects repeated slide paths even when the approval digest matches', async () => {
    const { path, manifest } = fixture(true); manifest.media[1].path = manifest.media[0].path;
    const { approval, ...body } = manifest; approval.bundleSha256 = hash(canonical(body)); writeFileSync(path, JSON.stringify(manifest));
    await expect(runApprovedMedia(path, options())).rejects.toThrow(/duplicate/);
  });
  it('resumes a known media checkpoint without uploading that image again', async () => {
    const { path } = fixture(true); const api = client(); const opts = options(api);
    const bytes = readFileSync(join(root, 'slide-2.png'));
    api.uploadMedia.mockImplementationOnce(async () => { writeFileSync(join(root, 'slide-2.png'), 'changed second slide'); return { id: 'first-media', path: 'https://media.invalid/slide-1.png' }; });
    await expect(runApprovedMedia(path, opts)).rejects.toThrow(/hash/);
    writeFileSync(join(root, 'slide-2.png'), bytes);
    expect((await runApprovedMedia(path, opts)).state).toBe('accepted');
    expect(api.uploadMedia.mock.calls.map(call => call[0].split('/').at(-1))).toEqual(['slide-1.png', 'slide-2.png']);
  });
  it('never trusts a bare persisted published flag without release evidence', async () => {
    const { path } = fixture(); const opts = options(); await runApprovedMedia(path, opts);
    const receiptPath = join(root, 'state', readdirSync(opts.stateDir).find(name => name.endsWith('.json'))!);
    const saved = state(); saved.state = 'published'; delete saved.readback;
    writeFileSync(receiptPath, JSON.stringify(saved));
    await expect(runApprovedMedia(path, opts)).rejects.toThrow(/receipt|evidence/);
  });
  it('retains a returned post ID even when the receipt account is contradictory', async () => {
    const { path } = fixture(); const api = client(); const opts = options(api);
    api.createMediaPost.mockResolvedValue({ postId: 'known-uncertain-post', integrationId: 'wrong-account', scheduledDate: '2026-01-01T00:00:00Z' });
    const result = await runApprovedMedia(path, opts);
    expect(result.state).toBe('needs_reconciliation'); expect(result.postId).toBe('known-uncertain-post');
    expect(state().postId).toBe('known-uncertain-post');
    await runApprovedMedia(path, opts); expect(api.createMediaPost).toHaveBeenCalledOnce();
  });
  it('retains a known upload ID even when its returned path is missing', async () => {
    const { path } = fixture(); const api = client();
    api.uploadMedia.mockResolvedValue({ id: 'known-uncertain-media', path: '' });
    const result = await runApprovedMedia(path, options(api));
    expect(result.state).toBe('needs_reconciliation'); expect(result.media?.[0].id).toBe('known-uncertain-media');
    expect(api.createMediaPost).not.toHaveBeenCalled();
  });
  it('registers a command that can plan without loading operator configuration', async () => {
    const { Command } = await import('commander');
    const { registerApprovedMediaCommand } = await import('../../src/approved-media-command.js');
    const { path } = fixture(); const settings = join(root, 'settings.json'); writeFileSync(settings, '{"__type":"instagram","post_type":"post"}');
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true); const program = new Command();
    try {
      registerApprovedMediaCommand(program);
      await program.parseAsync(['node', 'test', 'publish-approved', '--manifest', path, '--integration-id', 'account',
        '--provider', 'instagram', '--mode', 'now', '--settings-file', settings, '--state-dir', join(root, 'state')]);
      expect(String(write.mock.calls[0][0])).toContain('ready_for_authorization');
    } finally { write.mockRestore(); }
  });
  it('requires literal boolean authorization and reconcile flags before any client use', async () => {
    for (const flag of ['allowPublish', 'reconcile']) for (const value of ['false', 1, {}]) {
      const { path } = fixture(); const opts = options();
      await expect(runApprovedMedia(path, { ...opts, [flag]: value } as any)).rejects.toThrow(/boolean/);
      expect(opts.client.getIntegration).not.toHaveBeenCalled(); expect(opts.client.uploadMedia).not.toHaveBeenCalled();
    }
  });
  it('stops if approval is revoked or replaced during preflight or an upload, retaining available IDs', async () => {
    for (const boundary of ['preflight-revoke', 'preflight-replace', 'upload-revoke']) {
      const { path, manifest } = fixture(); const api = client(); const opts = { ...options(api), integrationId: boundary };
      const change = () => {
        if (boundary === 'preflight-replace') {
          manifest.metadata.description = 'A different approved revision'; const { approval, ...body } = manifest;
          approval.bundleSha256 = hash(canonical(body));
        } else manifest.approval.status = 'pending';
        writeFileSync(path, JSON.stringify(manifest));
      };
      api.getIntegration.mockImplementationOnce(async () => {
        if (boundary.startsWith('preflight')) change();
        return { id: boundary, providerIdentifier: 'instagram', name: 'Fixture', disabled: false };
      });
      api.uploadMedia.mockImplementationOnce(async () => { change(); return { id: 'confirmed-media', path: 'https://media.invalid/confirmed.mp4' }; });
      const result = await runApprovedMedia(path, opts);
      expect(result.state).toBe('needs_reconciliation'); expect(api.createMediaPost).not.toHaveBeenCalled();
      if (boundary === 'upload-revoke') expect(result.media?.[0].id).toBe('confirmed-media');
      else expect(api.uploadMedia).not.toHaveBeenCalled();
    }
  });
  it('rejects a new past schedule before network but can reconcile an existing one after its date', async () => {
    const { path } = fixture(); const api = client();
    const opts = { ...options(api), mode: 'schedule' as const, date: '2026-01-03T00:00:00Z', now: () => new Date('2026-01-04T00:00:00Z') };
    await expect(runApprovedMedia(path, opts)).rejects.toThrow(/future/); expect(api.getIntegration).not.toHaveBeenCalled();
    expect((await runApprovedMedia(path, { ...opts, now: () => new Date('2026-01-02T00:00:00Z') })).state).toBe('scheduled');
    api.getPost.mockResolvedValue({ id: 'post-fixture', state: 'PUBLISHED', releaseURL: 'https://www.instagram.com/reel/fixture/', integration: { id: 'account', providerIdentifier: 'instagram' } } as any);
    expect((await runApprovedMedia(path, { ...opts, reconcile: true, allowPublish: false })).state).toBe('published');
    expect(api.createMediaPost).toHaveBeenCalledOnce();
  });
  it('freezes the requested settings before asynchronous account preflight', async () => {
    const { path } = fixture(); const api = client(); const opts = options(api);
    api.getIntegration.mockImplementationOnce(async () => { opts.settings.post_type = 'story'; return { id: 'account', providerIdentifier: 'instagram', name: 'Fixture', disabled: false }; });
    await runApprovedMedia(path, opts);
    expect((api.createMediaPost.mock.calls[0] as any[])[0].settings.post_type).toBe('post');
  });
});
