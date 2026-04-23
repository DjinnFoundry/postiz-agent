import { describe, it, expect } from 'vitest';
import { deriveHashtags, baseHashtagsForLocale } from '../../src/copy/hashtags.js';
import type { ContentBundle } from '../../src/core/content-bundle.js';

const baseBundle: ContentBundle = {
  id: 'dragon-marcos',
  kind: 'audio-story',
  text: { title: 'El dragón curioso', body: 'Había una vez un dragón.' },
  locale: 'es-ES',
  theme: { mood: 'fantasia' },
};

describe('baseHashtagsForLocale', () => {
  it('returns ES base for "es"', () => {
    expect(baseHashtagsForLocale('es')).toEqual(['audiocuentos', 'cuentosinfantiles']);
  });

  it('returns EN base for "en"', () => {
    const tags = baseHashtagsForLocale('en');
    expect(tags).toContain('kidsaudio');
    expect(tags).toContain('bedtimestories');
  });

  it('strips BCP 47 region subtag ("es-ES" -> es base)', () => {
    expect(baseHashtagsForLocale('es-ES')).toEqual(['audiocuentos', 'cuentosinfantiles']);
  });

  it('falls back to the catalog fallback locale for unknown locales', () => {
    const fr = baseHashtagsForLocale('fr');
    const es = baseHashtagsForLocale('es');
    expect(fr).toEqual(es);
  });

  it('returns a fresh copy each call (no shared mutable reference)', () => {
    const a = baseHashtagsForLocale('es');
    a.push('polluted');
    const b = baseHashtagsForLocale('es');
    expect(b).not.toContain('polluted');
  });
});

describe('deriveHashtags', () => {
  it('uses ES base when bundle.locale starts with es', () => {
    const tags = deriveHashtags(baseBundle);
    expect(tags).toContain('audiocuentos');
    expect(tags).toContain('cuentosinfantiles');
  });

  it('uses EN base when bundle.locale starts with en', () => {
    const b: ContentBundle = { ...baseBundle, locale: 'en-US' };
    const tags = deriveHashtags(b);
    expect(tags).toContain('kidsaudio');
    expect(tags).toContain('bedtimestories');
    expect(tags).not.toContain('audiocuentos');
  });

  it('falls back to the catalog fallback locale for unknown locales', () => {
    const b: ContentBundle = { ...baseBundle, locale: 'fr-FR' };
    const tags = deriveHashtags(b);
    expect(tags).toContain('audiocuentos');
    expect(tags).toContain('cuentosinfantiles');
  });

  it('appends mood hashtag after the base locale tags', () => {
    const tags = deriveHashtags(baseBundle);
    expect(tags).toContain('fantasia');
  });

  it('normalises accented mood values', () => {
    const b: ContentBundle = { ...baseBundle, theme: { mood: 'educación' } };
    expect(deriveHashtags(b)).toContain('educacion');
  });

  it('dedupes when mood collides with a base tag', () => {
    const b: ContentBundle = { ...baseBundle, theme: { mood: 'audiocuentos' } };
    const tags = deriveHashtags(b);
    expect(new Set(tags).size).toBe(tags.length);
  });

  it('omits mood hashtag when theme.mood is absent', () => {
    const b: ContentBundle = { ...baseBundle, theme: undefined };
    const tags = deriveHashtags(b);
    expect(tags).toEqual(['audiocuentos', 'cuentosinfantiles']);
  });
});
