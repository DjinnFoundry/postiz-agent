import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadTenant, listTenants } from '../../src/core/tenant.js';

let scratchRoot: string;

beforeEach(() => {
  scratchRoot = mkdtempSync(join(tmpdir(), 'tenant-test-'));
});

afterEach(() => {
  try { rmSync(scratchRoot, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('loadTenant("default")', () => {
  it('returns the default tenant with legacy data paths (no <slug>/ prefix)', () => {
    const t = loadTenant('default', { rootDir: scratchRoot });
    expect(t.slug).toBe('default');
    // Legacy paths: data/decisions.jsonl, NOT data/default/decisions.jsonl
    expect(t.paths.decisionsLog).toBe(resolve(scratchRoot, 'data', 'decisions.jsonl'));
    expect(t.paths.uploadCache).toBe(resolve(scratchRoot, 'data', 'upload-cache.json'));
    expect(t.paths.themeDecisions).toBe(resolve(scratchRoot, 'data', 'theme-decisions.json'));
    expect(t.paths.renderLogsDir).toBe(resolve(scratchRoot, 'data', 'render-logs'));
    expect(t.paths.dataDir).toBe(resolve(scratchRoot, 'data'));
  });

  it('inherits postiz/audiokids/youtubecli config from .env defaults', () => {
    const t = loadTenant('default', { rootDir: scratchRoot });
    expect(typeof t.postiz.apiUrl).toBe('string');
    expect(typeof t.audiokids.outputDir).toBe('string');
    expect(typeof t.youtubecli.path).toBe('string');
  });
});

describe('loadTenant("audiokids") (named tenant)', () => {
  it('returns paths under data/<slug>/ (not legacy)', () => {
    const t = loadTenant('audiokids', { rootDir: scratchRoot });
    expect(t.slug).toBe('audiokids');
    expect(t.paths.decisionsLog).toBe(resolve(scratchRoot, 'data', 'audiokids', 'decisions.jsonl'));
    expect(t.paths.uploadCache).toBe(resolve(scratchRoot, 'data', 'audiokids', 'upload-cache.json'));
    expect(t.paths.themeDecisions).toBe(resolve(scratchRoot, 'data', 'audiokids', 'theme-decisions.json'));
    expect(t.paths.renderLogsDir).toBe(resolve(scratchRoot, 'data', 'audiokids', 'render-logs'));
  });

  it('overlays tenants/<slug>/config.json on top of .env defaults when present', () => {
    const tenantDir = resolve(scratchRoot, 'tenants', 'audiokids');
    mkdirSync(tenantDir, { recursive: true });
    writeFileSync(join(tenantDir, 'config.json'), JSON.stringify({
      postiz: { apiUrl: 'http://custom-postiz:5001/public/v1', apiKey: 'tenant-specific-key' },
      audiokids: { outputDir: '/custom/audiokids/output' },
    }));
    const t = loadTenant('audiokids', { rootDir: scratchRoot });
    expect(t.postiz.apiUrl).toBe('http://custom-postiz:5001/public/v1');
    expect(t.postiz.apiKey).toBe('tenant-specific-key');
    expect(t.audiokids.outputDir).toBe('/custom/audiokids/output');
  });

  it('partial overlay: only specified fields override, others inherit', () => {
    const tenantDir = resolve(scratchRoot, 'tenants', 'audiokids');
    mkdirSync(tenantDir, { recursive: true });
    writeFileSync(join(tenantDir, 'config.json'), JSON.stringify({
      postiz: { apiKey: 'just-the-key' },
    }));
    const t = loadTenant('audiokids', { rootDir: scratchRoot });
    expect(t.postiz.apiKey).toBe('just-the-key');
    // apiUrl falls through to env default (whatever it is, just not the "tenant-specific-key" placeholder)
    expect(t.postiz.apiUrl).toBeTruthy();
    expect(t.postiz.apiUrl).not.toBe('just-the-key');
  });

  it('throws on invalid tenant slug (security: no path traversal)', () => {
    expect(() => loadTenant('../etc/passwd', { rootDir: scratchRoot }))
      .toThrowError(/invalid tenant slug/i);
    expect(() => loadTenant('/absolute', { rootDir: scratchRoot }))
      .toThrowError(/invalid tenant slug/i);
  });

  it('exposes brand block from config.json (empty default)', () => {
    const tenantDir = resolve(scratchRoot, 'tenants', 'zetaread');
    mkdirSync(tenantDir, { recursive: true });
    writeFileSync(join(tenantDir, 'config.json'), JSON.stringify({
      brand: { name: 'ZetaRead', defaultHashtags: ['booklovers', 'reading'] },
    }));
    const t = loadTenant('zetaread', { rootDir: scratchRoot });
    expect(t.brand?.name).toBe('ZetaRead');
    expect(t.brand?.defaultHashtags).toEqual(['booklovers', 'reading']);

    const empty = loadTenant('audiokids', { rootDir: scratchRoot });
    expect(empty.brand).toEqual({});
  });
});

describe('listTenants', () => {
  it('returns ["default"] when no tenants/ directory exists', () => {
    expect(listTenants({ rootDir: scratchRoot })).toEqual(['default']);
  });

  it('discovers every tenant in tenants/ alphabetically and prepends default', () => {
    mkdirSync(resolve(scratchRoot, 'tenants', 'zetaread'), { recursive: true });
    mkdirSync(resolve(scratchRoot, 'tenants', 'audiokids'), { recursive: true });
    expect(listTenants({ rootDir: scratchRoot })).toEqual(['default', 'audiokids', 'zetaread']);
  });

  it('skips entries that are not directories', () => {
    mkdirSync(resolve(scratchRoot, 'tenants'), { recursive: true });
    writeFileSync(resolve(scratchRoot, 'tenants', 'README.md'), 'doc');
    mkdirSync(resolve(scratchRoot, 'tenants', 'audiokids'));
    expect(listTenants({ rootDir: scratchRoot })).toEqual(['default', 'audiokids']);
  });
});
