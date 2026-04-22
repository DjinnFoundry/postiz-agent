import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveTheme } from '../../src/theme/resolver.js';
import { ThemeDecisionStore, loadCatalog, type ThemeCatalog } from '../../src/theme/catalog.js';
import type { ContentBundle } from '../../src/core/content-bundle.js';

const CATALOG = loadCatalog();

function bundle(over: Partial<ContentBundle> = {}): ContentBundle {
  return {
    id: 'test-bundle',
    kind: 'audio-story',
    text: { title: 'Título', body: 'érase una vez' },
    locale: 'es-ES',
    ...over,
  };
}

function freshStore(): { store: ThemeDecisionStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'theme-decisions-'));
  const store = new ThemeDecisionStore(join(dir, 'theme-decisions.json'));
  return { store, dir };
}

describe('resolveTheme: catalog integrity', () => {
  it('every treatment references a valid fontPairing', () => {
    const pairingIds = new Set(CATALOG.pairings.map(p => p.id));
    for (const t of CATALOG.treatments) {
      expect(pairingIds.has(t.fontPairing), `treatment ${t.id} → ${t.fontPairing}`).toBe(true);
    }
  });

  it('every treatment palette candidate exists in the palette catalog', () => {
    const paletteIds = new Set(CATALOG.palettes.map(p => p.id));
    for (const t of CATALOG.treatments) {
      for (const p of t.palettes) {
        expect(paletteIds.has(p), `treatment ${t.id} → palette ${p}`).toBe(true);
      }
    }
  });

  it('every mood candidate refers to a real treatment', () => {
    const treatmentIds = new Set(CATALOG.treatments.map(t => t.id));
    for (const [mood, candidates] of Object.entries(CATALOG.moodCandidates)) {
      for (const c of candidates) {
        expect(treatmentIds.has(c), `mood ${mood} → ${c}`).toBe(true);
      }
    }
  });

  it('every keyword hint refers to real treatments', () => {
    const treatmentIds = new Set(CATALOG.treatments.map(t => t.id));
    for (const [kw, candidates] of Object.entries(CATALOG.keywordHints)) {
      for (const c of candidates) {
        expect(treatmentIds.has(c), `keyword ${kw} → ${c}`).toBe(true);
      }
    }
  });

  it('fallback references a real treatment', () => {
    const ids = new Set(CATALOG.treatments.map(t => t.id));
    expect(ids.has(CATALOG.fallback)).toBe(true);
  });
});

describe('resolveTheme: priority order', () => {
  let store: ThemeDecisionStore;
  beforeEach(() => { ({ store } = freshStore()); });

  it('returns fallback when nothing matches', () => {
    const r = resolveTheme(bundle({ id: 'no-hints', text: { body: 'hola' } }), { store });
    expect(r.source).toBe('fallback');
    expect(r.treatment.id).toBe(CATALOG.fallback);
  });

  it('uses explicit treatment when bundle.theme.treatment is valid', () => {
    const r = resolveTheme(bundle({ theme: { treatment: 'midnight' } }), { store });
    expect(r.source).toBe('explicit');
    expect(r.treatment.id).toBe('midnight');
  });

  it('ignores unknown explicit treatment id and falls through', () => {
    const r = resolveTheme(bundle({ theme: { treatment: 'does-not-exist' } }), { store });
    expect(r.source).not.toBe('explicit');
  });

  it('uses keyword hint when body mentions a known trigger', () => {
    const r = resolveTheme(bundle({ id: 'dragon-story', text: { body: 'Había un dragón en el castillo' } }), { store });
    expect(r.source).toBe('keywords');
    expect(['medieval-manuscript', 'epic-cinematic']).toContain(r.treatment.id);
  });

  it('uses mood candidates when no explicit or keyword match', () => {
    const r = resolveTheme(bundle({ id: 'mystery', text: { body: 'something happened' }, theme: { mood: 'misterio' } }), { store });
    expect(r.source).toBe('mood');
    expect(CATALOG.moodCandidates['misterio']).toContain(r.treatment.id);
  });
});

describe('resolveTheme: determinism', () => {
  it('the same bundle id always resolves to the same treatment', () => {
    const { store: s1 } = freshStore();
    const { store: s2 } = freshStore();
    const b = bundle({ id: 'stable-id', theme: { mood: 'fantasia' } });
    const r1 = resolveTheme(b, { store: s1, persist: false });
    const r2 = resolveTheme(b, { store: s2, persist: false });
    expect(r1.treatment.id).toBe(r2.treatment.id);
    expect(r1.palette.id).toBe(r2.palette.id);
  });

  it('different bundle ids eventually pick different treatments (within candidate list)', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `slug-${i}`);
    const { store } = freshStore();
    const treatments = new Set(ids.map(id => resolveTheme(bundle({ id, theme: { mood: 'fantasia' } }), { store, persist: false }).treatment.id));
    expect(treatments.size).toBeGreaterThanOrEqual(2);
  });
});

describe('resolveTheme: persistence', () => {
  it('persists the decision and reuses it on next call', () => {
    const { store } = freshStore();
    const b = bundle({ id: 'persist-me', theme: { mood: 'fantasia' } });
    const first = resolveTheme(b, { store });
    const second = resolveTheme({ ...b, theme: { mood: 'comedia' } }, { store });
    // Even though mood changed, the persisted decision should win.
    expect(second.treatment.id).toBe(first.treatment.id);
  });

  it('does not persist when persist:false', () => {
    const { store } = freshStore();
    const b = bundle({ id: 'dont-persist', theme: { mood: 'fantasia' } });
    resolveTheme(b, { store, persist: false });
    expect(store.get(b.id)).toBeUndefined();
  });
});
