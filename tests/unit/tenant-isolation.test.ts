import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadTenant } from '../../src/core/tenant.js';
import { buildTenantBundle } from '../../src/cli/tenant-context.js';
import { runStatus } from '../../src/cli/status.js';
import { runDoctor } from '../../src/cli/doctor.js';
import { run } from '../../src/lib/process.js';

vi.mock('../../src/lib/process.js', async importOriginal => ({ ...await importOriginal<typeof import('../../src/lib/process.js')>(), run: vi.fn() }));
let root: string;
const tenantUrl = 'https://tenant.example/api/public/v1';
function writeConfig(value: unknown) {
  const dir = join(root, 'tenants', 'test-brand');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), typeof value === 'string' ? value : JSON.stringify(value));
}
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'tenant-isolation-')); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true }); });

describe('tenant configuration fails closed', () => {
  it('rejects an unknown named tenant instead of inheriting another account', () => {
    expect(() => loadTenant('missing-brand', { rootDir: root })).toThrow(/tenant.*missing|missing.*tenant/i);
  });
  it.each(['{broken', '[]', 'null', '{"postiz":{"apiKey":42}}', '{"postiz":null}', '{"audiokids":{"outputDir":false}}'])('rejects malformed config %s', (raw) => {
    writeConfig(raw);
    expect(() => loadTenant('test-brand', { rootDir: root })).toThrow(/config/i);
  });
  it('rejects a malformed default config too', () => {
    mkdirSync(join(root, 'tenants', 'default'), { recursive: true });
    writeFileSync(join(root, 'tenants', 'default', 'config.json'), '{broken');
    expect(() => loadTenant('default', { rootDir: root })).toThrow(/config/i);
  });
});

describe('tenant services', () => {
  it('publishes through the tenant Postiz client and credentials', async () => {
    writeConfig({ postiz: { apiUrl: tenantUrl, apiKey: 'tenant-secret' } });
    const ctx = buildTenantBundle('test-brand', { rootDir: root });
    const client = ctx.postiz();
    vi.spyOn(client, 'findIntegration').mockResolvedValue({ id: 'tenant-integration', name: 'X', providerIdentifier: 'x' });
    const createPost = vi.spyOn(client, 'createPost').mockResolvedValue({ postId: 'tenant-post', url: '' });
    const result = await ctx.getPublisher('x').publish({ bundle: { id: 'same-id', kind: 'text', text: { body: 'Tenant content' }, locale: 'es' }, workDir: root, words: [] });
    expect(result.success).toBe(true);
    expect(createPost).toHaveBeenCalledWith(expect.objectContaining({ integrationId: 'tenant-integration' }));
  });
  it('selects the configured integration when the instance has multiple products', async () => {
    writeConfig({ postiz: { apiUrl: tenantUrl, apiKey: 'tenant-secret', integrationIds: { x: 'brand-two' } } });
    const ctx = buildTenantBundle('test-brand', { rootDir: root });
    vi.spyOn(ctx.postiz(), 'listIntegrations').mockResolvedValue([
      { id: 'brand-one', name: 'Other brand', providerIdentifier: 'x', disabled: false },
      { id: 'brand-two', name: 'This brand', providerIdentifier: 'x', disabled: false },
    ]);
    expect((await ctx.postiz().findIntegration('x')).id).toBe('brand-two');
  });
  it('runs YouTubeCLI from the tenant project directory', async () => {
    writeConfig({ youtubecli: { path: root, channelId: 'tenant-channel' } });
    writeFileSync(join(root, 'youtube_cli'), 'mock escript');
    const file = join(root, 'video.mp4');
    writeFileSync(file, 'video');
    vi.mocked(run).mockResolvedValueOnce({ stdout: 'Video ID: e0634f03-88d8-40b9-b630-b6a1a48f8d30', stderr: '' }).mockResolvedValueOnce({ stdout: 'YouTube ID: abcdef12345', stderr: '' });
    const ctx = buildTenantBundle('test-brand', { rootDir: root });
    const result = await ctx.getPublisher('youtube').publish({ bundle: { id: 'same-id', kind: 'video', primaryMedia: file, text: { body: 'Tenant content' }, locale: 'es' }, workDir: root, words: [] });
    expect(result.success).toBe(true);
    expect(run).toHaveBeenCalledWith(join(root, 'youtube_cli'), expect.arrayContaining(['--channel', 'tenant-channel']), { cwd: root });
  });
  it('stores render failures and theme decisions under the tenant data directory', async () => {
    writeConfig({});
    const media = join(root, 'audio.mp3');
    writeFileSync(media, 'audio');
    vi.mocked(run).mockRejectedValue(new Error('injected render failure'));
    const ctx = buildTenantBundle('test-brand', { rootDir: root });
    const result = await ctx.getPublisher('x').publish({ bundle: { id: 'same-id', kind: 'audio-story', primaryMedia: media, text: { body: 'Tenant content' }, locale: 'es' }, workDir: root, words: [{ text: 'Hello', start: 0, end: 1 }], dryRun: true });
    expect(result.success).toBe(false);
    expect(readFileSync(ctx.tenant.paths.themeDecisions, 'utf8')).toContain('same-id');
    const logs = readdirSync(ctx.tenant.paths.renderLogsDir);
    expect(logs).toHaveLength(1);
    expect(readFileSync(join(ctx.tenant.paths.renderLogsDir, logs[0]), 'utf8')).toContain('injected render failure');
  });
  it('status checks the tenant URL and YouTube path and rejects HTTP errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    const report = await runStatus({ postizApiUrl: tenantUrl, youtubecliPath: root, postizApiKey: 'key', audiokidsDir: root, decisions: [], listIntegrations: async () => [], binChecks: async () => [], toolNames: [], treatmentIds: [], uploadCache: { count: 0, oldestUploadedAt: null, exists: false }, themeDecisions: { count: 0, exists: false } });
    expect(fetchMock).toHaveBeenCalledWith('https://tenant.example/', expect.any(Object));
    expect(report.deps.find(d => d.label === 'Postiz API reachable')).toMatchObject({ ok: false });
    expect(report.deps.find(d => d.label === 'YouTubeCLI project path')).toMatchObject({ ok: true, detail: root });
    expect(report.deps.find(d => d.label === 'x integration')?.detail).toContain('https://tenant.example');
  });
  it('doctor remediation links point to the tenant instance', async () => {
    const report = await runDoctor({ postizApiUrl: tenantUrl, youtubecliPath: root, postizApiKey: 'key', audiokidsDir: root, decisions: [], listIntegrations: async () => [], uploadCache: { count: 0, oldestUploadedAt: null, exists: false }, themeDecisions: { count: 0, exists: false } });
    expect(report.sections.find(s => s.name === 'postiz')?.items[0].hint).toContain('https://tenant.example');
    expect(report.sections.find(s => s.name === 'environment')?.items.find(i => i.label.startsWith('YouTubeCLI'))?.status).toBe('ok');
  });
});
