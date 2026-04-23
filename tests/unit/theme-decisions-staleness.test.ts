import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ThemeDecisionStore,
  loadCatalog,
  type ThemeCatalog,
  type ThemeDecision,
} from '../../src/theme/catalog.js';

function freshStorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'theme-decisions-stale-'));
  return join(dir, 'theme-decisions.json');
}

function writeRawFile(path: string, decisions: Record<string, ThemeDecision>): void {
  writeFileSync(path, JSON.stringify({ version: 1, decisions }, null, 2), 'utf-8');
}

describe('loadCatalog().catalogVersion', () => {
  it('is a deterministic "treatments:palettes:fonts" string', () => {
    const catalog = loadCatalog();
    expect(typeof catalog.catalogVersion).toBe('string');
    expect(catalog.catalogVersion.split(':').length).toBe(3);
  });
});

describe('ThemeDecisionStore.set: persists catalogVersion', () => {
  let path: string;
  let catalog: ThemeCatalog;
  beforeEach(() => { path = freshStorePath(); catalog = loadCatalog(); });

  it('stamps decision with catalog.catalogVersion when save-time version is provided', () => {
    const store = new ThemeDecisionStore(path);
    store.set({
      bundleId: 'b1',
      treatmentId: 'hero-display',
      source: 'explicit',
      decidedAt: '2026-01-01T00:00:00.000Z',
    }, { catalogVersion: catalog.catalogVersion });
    const got = store.get('b1');
    expect(got?.catalogVersion).toBe(catalog.catalogVersion);
  });

  it('accepts decisions without version for backward compat', () => {
    const store = new ThemeDecisionStore(path);
    store.set({
      bundleId: 'b2',
      treatmentId: 'hero-display',
      source: 'explicit',
      decidedAt: '2026-01-01T00:00:00.000Z',
    });
    const got = store.get('b2');
    expect(got?.bundleId).toBe('b2');
    expect(got?.catalogVersion).toBeUndefined();
  });
});

describe('ThemeDecisionStore.listStale', () => {
  let path: string;
  let catalog: ThemeCatalog;
  beforeEach(() => { path = freshStorePath(); catalog = loadCatalog(); });

  it('flags decisions with a mismatched catalogVersion', () => {
    const store = new ThemeDecisionStore(path);
    writeRawFile(path, {
      old: {
        bundleId: 'old',
        treatmentId: 'hero-display',
        source: 'explicit',
        decidedAt: '2026-01-01T00:00:00.000Z',
        catalogVersion: '0:0:0',
      },
    });
    const stale = store.listStale(catalog);
    expect(stale.length).toBe(1);
    expect(stale[0].bundleId).toBe('old');
    expect(stale[0].reason).toBe('version-mismatch');
  });

  it('flags decisions pointing at an unknown treatment id', () => {
    const store = new ThemeDecisionStore(path);
    writeRawFile(path, {
      ghost: {
        bundleId: 'ghost',
        treatmentId: 'does-not-exist',
        source: 'explicit',
        decidedAt: '2026-01-01T00:00:00.000Z',
        catalogVersion: catalog.catalogVersion,
      },
    });
    const stale = store.listStale(catalog);
    expect(stale.length).toBe(1);
    expect(stale[0].bundleId).toBe('ghost');
    expect(stale[0].reason).toBe('unknown-treatment-id');
  });

  it('does not flag decisions that match current version and known treatment', () => {
    const store = new ThemeDecisionStore(path);
    store.set({
      bundleId: 'fresh',
      treatmentId: 'hero-display',
      source: 'explicit',
      decidedAt: '2026-01-01T00:00:00.000Z',
    }, { catalogVersion: catalog.catalogVersion });
    const stale = store.listStale(catalog);
    expect(stale.length).toBe(0);
  });

  it('treats legacy decisions without catalogVersion as stale with reason "legacy-no-version"', () => {
    const store = new ThemeDecisionStore(path);
    writeRawFile(path, {
      legacy: {
        bundleId: 'legacy',
        treatmentId: 'hero-display',
        source: 'explicit',
        decidedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    const stale = store.listStale(catalog);
    expect(stale.length).toBe(1);
    expect(stale[0].bundleId).toBe('legacy');
    expect(stale[0].reason).toBe('legacy-no-version');
  });
});

describe('ThemeDecisionStore.clearStale', () => {
  let path: string;
  let catalog: ThemeCatalog;
  beforeEach(() => { path = freshStorePath(); catalog = loadCatalog(); });

  it('removes every stale entry and keeps healthy ones', () => {
    const store = new ThemeDecisionStore(path);
    writeRawFile(path, {
      stale: {
        bundleId: 'stale',
        treatmentId: 'hero-display',
        source: 'explicit',
        decidedAt: '2026-01-01T00:00:00.000Z',
        catalogVersion: '0:0:0',
      },
      ghost: {
        bundleId: 'ghost',
        treatmentId: 'does-not-exist',
        source: 'explicit',
        decidedAt: '2026-01-01T00:00:00.000Z',
        catalogVersion: catalog.catalogVersion,
      },
      fresh: {
        bundleId: 'fresh',
        treatmentId: 'hero-display',
        source: 'explicit',
        decidedAt: '2026-01-01T00:00:00.000Z',
        catalogVersion: catalog.catalogVersion,
      },
    });
    const removed = store.clearStale(catalog);
    expect(removed.map(r => r.bundleId).sort()).toEqual(['ghost', 'stale']);
    const remaining = store.all();
    expect(Object.keys(remaining)).toEqual(['fresh']);
  });

  it('returns an empty array when nothing is stale', () => {
    const store = new ThemeDecisionStore(path);
    store.set({
      bundleId: 'fresh',
      treatmentId: 'hero-display',
      source: 'explicit',
      decidedAt: '2026-01-01T00:00:00.000Z',
    }, { catalogVersion: catalog.catalogVersion });
    const removed = store.clearStale(catalog);
    expect(removed).toEqual([]);
    expect(existsSync(path)).toBe(true);
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    expect(Object.keys(raw.decisions)).toEqual(['fresh']);
  });
});
