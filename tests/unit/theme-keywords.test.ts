import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveTheme } from '../../src/theme/resolver.js';
import { ThemeDecisionStore, loadCatalog } from '../../src/theme/catalog.js';
import type { ContentBundle } from '../../src/core/content-bundle.js';

const CATALOG = loadCatalog();

function bundle(over: Partial<ContentBundle> = {}): ContentBundle {
  return {
    id: 'kw-test-bundle',
    kind: 'audio-story',
    text: { title: 'Cuento', body: 'érase una vez' },
    locale: 'es-ES',
    ...over,
  };
}

function freshStore(): ThemeDecisionStore {
  const dir = mkdtempSync(join(tmpdir(), 'theme-kw-'));
  return new ThemeDecisionStore(join(dir, 'theme-decisions.json'));
}

const MEDIEVAL_FAMILY = new Set(['medieval-manuscript', 'epic-cinematic', 'mythic-scroll']);
const TECH_FAMILY = new Set(['terminal-crt', 'midnight']);
const INFANTIL_FAMILY = new Set(['storybook-pop', 'crayon-doodle', 'bubble-pastel']);
const ROSE_FAMILY = new Set(['rose-stamp', 'crayon-doodle']);
const EPIC_ADVENTURE_FAMILY = new Set(['epic-cinematic', 'hero-display', 'medieval-manuscript']);
const MYTHIC_NATURE_FAMILY = new Set(['mythic-scroll', 'academic-dropcap', 'bubble-pastel']);

describe('keywordHints: word-boundary matching (no substring traps)', () => {
  it('keyword "mar" does NOT match the character name "Marcos" (body-only text without other keywords)', () => {
    const store = freshStore();
    const r = resolveTheme(bundle({
      id: 'regression-marcos',
      text: { title: 'Una tarde', body: 'Marcos caminaba tranquilo por la plaza.' },
      theme: { mood: 'calma' },
    }), { store });
    expect(r.source).not.toBe('keywords');
  });

  it('keyword "rio" does NOT match inside "laboratorio" (would be a substring trap)', () => {
    const store = freshStore();
    const r = resolveTheme(bundle({
      id: 'regression-laboratorio',
      text: { title: 'Cuento breve', body: 'Había un laboratorio enorme lleno de aparatos.' },
      theme: { mood: 'aventura' },
    }), { store });
    expect(r.source).toBe('keywords');
    expect(TECH_FAMILY.has(r.treatment.id)).toBe(true);
  });

  it('keyword "lobo" does NOT match inside "globo" when alone', () => {
    const store = freshStore();
    const r = resolveTheme(bundle({
      id: 'regression-globo-trap',
      text: { title: 'Cuento breve', body: 'Un globo rojo flotaba alto.' },
      theme: { mood: 'comedia' },
    }), { store });
    expect(MEDIEVAL_FAMILY.has(r.treatment.id)).toBe(false);
  });

  it('exact keyword on word boundary still matches (dragon → medieval/epic family)', () => {
    const store = freshStore();
    const r = resolveTheme(bundle({
      id: 'boundary-positive',
      text: { title: 'Aventura', body: 'Había un dragón enorme en la colina.' },
      theme: { mood: 'fantasia' },
    }), { store });
    expect(r.source).toBe('keywords');
    expect(MEDIEVAL_FAMILY.has(r.treatment.id)).toBe(true);
  });
});

describe('keywordHints: catalog coverage', () => {
  it('has at least 40 keywords defined', () => {
    const count = Object.keys(CATALOG.keywordHints).length;
    expect(count).toBeGreaterThanOrEqual(40);
  });

  it('every keyword maps to at least one real treatment id', () => {
    const treatmentIds = new Set(CATALOG.treatments.map(t => t.id));
    for (const [kw, candidates] of Object.entries(CATALOG.keywordHints)) {
      expect(candidates.length, `keyword "${kw}" has empty candidate list`).toBeGreaterThan(0);
      for (const c of candidates) {
        expect(treatmentIds.has(c), `keyword "${kw}" → unknown treatment "${c}"`).toBe(true);
      }
    }
  });

  it('keywords are stored normalized (lowercase, no accents)', () => {
    for (const kw of Object.keys(CATALOG.keywordHints)) {
      expect(kw, `keyword "${kw}" should be lowercase`).toBe(kw.toLowerCase());
      const stripped = kw.normalize('NFD').replace(/[̀-ͯ]/g, '');
      expect(stripped, `keyword "${kw}" should not carry diacritics`).toBe(kw);
    }
  });

  it('covers the medieval / epic family with multiple triggers', () => {
    const medievalTriggers = Object.entries(CATALOG.keywordHints).filter(([, cands]) =>
      cands.some(c => c === 'medieval-manuscript' || c === 'epic-cinematic'),
    );
    expect(medievalTriggers.length).toBeGreaterThanOrEqual(10);
  });

  it('covers the infantil family with multiple triggers', () => {
    const infantilTriggers = Object.entries(CATALOG.keywordHints).filter(([, cands]) =>
      cands.some(c => c === 'storybook-pop' || c === 'crayon-doodle' || c === 'bubble-pastel'),
    );
    expect(infantilTriggers.length).toBeGreaterThanOrEqual(8);
  });

  it('covers the tech family with multiple triggers', () => {
    const techTriggers = Object.entries(CATALOG.keywordHints).filter(([, cands]) =>
      cands.includes('terminal-crt'),
    );
    expect(techTriggers.length).toBeGreaterThanOrEqual(5);
  });

  it('covers the mythic / nature family with multiple triggers', () => {
    const mythicTriggers = Object.entries(CATALOG.keywordHints).filter(([, cands]) =>
      cands.includes('mythic-scroll'),
    );
    expect(mythicTriggers.length).toBeGreaterThanOrEqual(5);
  });
});

describe('keywordHints: synthetic stories resolve to the expected family', () => {
  let store: ThemeDecisionStore;
  beforeEach(() => { store = freshStore(); });

  it('medieval story ("caballero en el castillo") resolves to the medieval/epic family', () => {
    const r = resolveTheme(
      bundle({ id: 'medieval-1', text: { body: 'Había un caballero en el castillo del rey' } }),
      { store, persist: false },
    );
    expect(r.source).toBe('keywords');
    expect(MEDIEVAL_FAMILY.has(r.treatment.id), `got ${r.treatment.id}`).toBe(true);
  });

  it('dragon + hechicero story resolves to medieval / epic', () => {
    const r = resolveTheme(
      bundle({ id: 'medieval-2', text: { body: 'El dragón y el hechicero cruzaron el reino' } }),
      { store, persist: false },
    );
    expect(r.source).toBe('keywords');
    expect(MEDIEVAL_FAMILY.has(r.treatment.id), `got ${r.treatment.id}`).toBe(true);
  });

  it('tech story ("robot en la nave espacial") resolves to terminal-crt or midnight', () => {
    const r = resolveTheme(
      bundle({ id: 'tech-1', text: { body: 'El robot viajaba en la nave por el espacio' } }),
      { store, persist: false },
    );
    expect(r.source).toBe('keywords');
    expect(TECH_FAMILY.has(r.treatment.id), `got ${r.treatment.id}`).toBe(true);
  });

  it('infantil story ("fiesta de cumpleaños con amigos") resolves to the infantil family', () => {
    const r = resolveTheme(
      bundle({ id: 'infantil-1', text: { body: 'La fiesta de cumpleaños con amigos y pastel fue genial' } }),
      { store, persist: false },
    );
    expect(r.source).toBe('keywords');
    expect(INFANTIL_FAMILY.has(r.treatment.id), `got ${r.treatment.id}`).toBe(true);
  });

  it('dedicatoria story ("regalo con corazón y abrazo") resolves to rose / crayon family', () => {
    const r = resolveTheme(
      bundle({ id: 'rose-1', text: { body: 'Un regalo con mucho corazón y un abrazo' } }),
      { store, persist: false },
    );
    expect(r.source).toBe('keywords');
    expect(ROSE_FAMILY.has(r.treatment.id), `got ${r.treatment.id}`).toBe(true);
  });

  it('adventure story ("aventura del héroe en la isla") resolves to epic / hero family', () => {
    const r = resolveTheme(
      bundle({ id: 'adv-1', text: { body: 'La aventura del héroe en la isla con un tesoro' } }),
      { store, persist: false },
    );
    expect(r.source).toBe('keywords');
    expect(EPIC_ADVENTURE_FAMILY.has(r.treatment.id), `got ${r.treatment.id}`).toBe(true);
  });

  it('nature story ("bosque con rio y arbol") resolves to mythic / nature family', () => {
    const r = resolveTheme(
      bundle({ id: 'nature-1', text: { body: 'En el bosque junto al rio crecia un arbol enorme' } }),
      { store, persist: false },
    );
    expect(r.source).toBe('keywords');
    expect(MYTHIC_NATURE_FAMILY.has(r.treatment.id), `got ${r.treatment.id}`).toBe(true);
  });

  it('mystery story ("sombra y misterio en la niebla") resolves to midnight', () => {
    const r = resolveTheme(
      bundle({ id: 'mys-1', text: { body: 'Una sombra y un misterio en la niebla nocturna' } }),
      { store, persist: false },
    );
    expect(r.source).toBe('keywords');
    expect(r.treatment.id).toBe('midnight');
  });

  it('neutral story without keywords falls back to mood candidates', () => {
    const r = resolveTheme(
      bundle({
        id: 'neutral-1',
        text: { title: 'Titulo plano', body: 'era un dia tranquilo sin nada especial' },
        theme: { mood: 'calma' },
      }),
      { store, persist: false },
    );
    expect(r.source).toBe('mood');
    expect(CATALOG.moodCandidates['calma']).toContain(r.treatment.id);
  });

  it('neutral story without keywords and without mood falls back to catalog fallback', () => {
    const r = resolveTheme(
      bundle({ id: 'neutral-2', text: { title: 'X', body: 'hola que tal como estas' } }),
      { store, persist: false },
    );
    expect(r.source).toBe('fallback');
    expect(r.treatment.id).toBe(CATALOG.fallback);
  });

  it('keyword matching is accent-insensitive ("dragón" and "dragon" both hit)', () => {
    const withAccent = resolveTheme(
      bundle({ id: 'acc-1', text: { body: 'el dragón dormía' } }),
      { store: freshStore(), persist: false },
    );
    const withoutAccent = resolveTheme(
      bundle({ id: 'acc-2', text: { body: 'el dragon dormia' } }),
      { store: freshStore(), persist: false },
    );
    expect(withAccent.source).toBe('keywords');
    expect(withoutAccent.source).toBe('keywords');
    expect(MEDIEVAL_FAMILY.has(withAccent.treatment.id)).toBe(true);
    expect(MEDIEVAL_FAMILY.has(withoutAccent.treatment.id)).toBe(true);
  });

  it('keyword matching uses the title too, not only the body', () => {
    const r = resolveTheme(
      bundle({
        id: 'title-only',
        text: { title: 'El castillo de Marcos', body: 'hola' },
      }),
      { store, persist: false },
    );
    expect(r.source).toBe('keywords');
    expect(MEDIEVAL_FAMILY.has(r.treatment.id)).toBe(true);
  });
});
