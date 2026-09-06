import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../../src/config.js';
import { buildTenantBundle } from '../../src/cli/tenant-context.js';
import { getPublisher } from '../../src/platforms/registry.js';
import { Orchestrator } from '../../src/orchestrator.js';
import type { ContentBundle } from '../../src/core/content-bundle.js';

let root: string;
let originalKey: string;
let bundle: ContentBundle;
const fetchMock = vi.fn();
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'preview-no-credentials-'));
  originalKey = config.postiz.apiKey;
  config.postiz.apiKey = '';
  vi.stubEnv('POSTIZ_API_KEY', '');
  vi.stubGlobal('fetch', fetchMock);
  mkdirSync(join(root, 'tenants', 'preview'), { recursive: true });
  writeFileSync(join(root, 'tenants', 'preview', 'config.json'), JSON.stringify({ postiz: { apiKey: '', apiUrl: 'https://preview.example/api/public/v1' }, alerts: { webhookUrl: '' } }));
  const image = join(root, 'product.png');
  writeFileSync(image, 'preview image');
  bundle = { id: 'product', kind: 'image-post', primaryMedia: image, text: { body: 'Product preview' }, locale: 'es' };
});
afterEach(() => {
  config.postiz.apiKey = originalKey;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('previews without publishing credentials', () => {
  it('renders X and Instagram image previews through the tenant orchestrator without credentials or network', async () => {
    const ctx = buildTenantBundle('preview', { rootDir: root });
    const report = await new Orchestrator(ctx.orchestratorDeps).publish({ bundle, platforms: ['x', 'instagram'], dryRun: true, reason: 'preview test' });
    expect(report.results).toHaveLength(2);
    expect(report.results.every(result => result.success)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(['x', 'tiktok', 'instagram'] as const)('default %s publisher also allows a preview before setup', async platform => {
    const result = await getPublisher(platform).publish({ bundle, workDir: root, words: [], dryRun: true });
    expect(result.success).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('still rejects real publication without a tenant API key', async () => {
    const ctx = buildTenantBundle('preview', { rootDir: root });
    const result = await ctx.getPublisher('x').publish({ bundle, workDir: root, words: [] });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/POSTIZ_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
