import { describe, expect, it } from 'vitest';
import { listThemes, describeTheme, formatThemesList, formatThemeDescription } from '../../src/cli/themes.js';

describe('listThemes', () => {
  it('returns one row per treatment in the catalog with shape {id, family, paletteCount, fontPairing, description}', () => {
    const report = listThemes();
    expect(report.treatments.length).toBeGreaterThanOrEqual(12);
    const hero = report.treatments.find(t => t.id === 'hero-display');
    expect(hero).toBeDefined();
    expect(hero!).toMatchObject({
      id: 'hero-display',
      family: 'editorial',
      fontPairing: 'fraunces-inter',
    });
    expect(hero!.paletteCount).toBeGreaterThan(0);
    expect(typeof hero!.description).toBe('string');
    expect(hero!.palettes).toEqual(expect.arrayContaining(['parchment-ember', 'cream-rust', 'bone-ink']));
  });

  it('includes every treatment family represented in the catalog', () => {
    const report = listThemes();
    const families = new Set(report.treatments.map(t => t.family));
    for (const f of ['editorial', 'infantil', 'epica', 'tech']) {
      expect(families).toContain(f);
    }
  });

  it('exposes catalog fallback so operators can see the default', () => {
    const report = listThemes();
    expect(report.fallback).toBe('hero-display');
  });
});

describe('describeTheme', () => {
  it('returns a descriptor with resolved palette objects and fontPairing for a known treatment', () => {
    const desc = describeTheme('midnight');
    expect(desc.ok).toBe(true);
    if (!desc.ok) throw new Error('unreachable');
    expect(desc.treatment.id).toBe('midnight');
    expect(desc.treatment.family).toBe('editorial');
    expect(desc.palettes).toHaveLength(desc.treatment.palettes.length);
    for (const p of desc.palettes) {
      expect(p).toHaveProperty('id');
      expect(p).toHaveProperty('bg');
      expect(p).toHaveProperty('ink');
      expect(p).toHaveProperty('accent');
    }
    expect(desc.fontPairing.id).toBe('playfair-inter');
    expect(desc.fontPairing.display).toHaveProperty('family');
    expect(desc.fontPairing.body).toHaveProperty('family');
  });

  it('includes folio face when the pairing declares one', () => {
    const desc = describeTheme('medieval-manuscript');
    expect(desc.ok).toBe(true);
    if (!desc.ok) throw new Error('unreachable');
    expect(desc.fontPairing.folio).toBeDefined();
    expect(desc.fontPairing.folio!.family).toBe('MedievalSharp');
  });

  it('returns ok:false with the list of known ids for an unknown treatment', () => {
    const desc = describeTheme('not-a-real-treatment');
    expect(desc.ok).toBe(false);
    if (desc.ok) throw new Error('unreachable');
    expect(desc.knownIds.length).toBeGreaterThanOrEqual(12);
    expect(desc.knownIds).toContain('hero-display');
    expect(desc.error).toMatch(/not-a-real-treatment/);
  });
});

describe('formatThemesList', () => {
  it('produces a plain-text table with id, family, palette count, and fontPairing columns', () => {
    const report = listThemes();
    const text = formatThemesList(report);
    expect(text).toContain('hero-display');
    expect(text).toContain('editorial');
    expect(text).toContain('fraunces-inter');
    // No ANSI colour codes: we want cron-mail-safe output like doctor/stats.
    expect(text).not.toMatch(/\[/);
  });
});

describe('formatThemeDescription', () => {
  it('prints id, family, description, palette block, and font families for a valid descriptor', () => {
    const desc = describeTheme('rose-stamp');
    expect(desc.ok).toBe(true);
    if (!desc.ok) throw new Error('unreachable');
    const text = formatThemeDescription(desc);
    expect(text).toContain('rose-stamp');
    expect(text).toContain('editorial');
    expect(text).toContain('rose-cream');
    expect(text).toContain('fraunces-inter');
  });
});
