import { describe, it, expect } from 'vitest';
import { buildCaption, extractTeaser, taglineForRecipient, deriveHashtags } from '../../src/copy/caption-builder.js';
import type { ContentBundle } from '../../src/core/content-bundle.js';

const base: ContentBundle = {
  id: 'dragon-marcos',
  kind: 'audio-story',
  text: {
    title: 'El dragón curioso',
    body: 'Marcos caminaba por el bosque cuando escuchó un ruido extraño. Detrás de un árbol grande, encontró a un pequeño dragón que lloraba. El dragón no podía escupir fuego.',
  },
  locale: 'es-ES',
  theme: { mood: 'fantasia' },
  recipient: { name: 'Marcos', age: 6, shareConsent: 'first-name-only' },
};

describe('taglineForRecipient', () => {
  it('returns null without recipient', () => {
    expect(taglineForRecipient(undefined)).toBeNull();
  });

  it('public consent uses first name + age', () => {
    expect(taglineForRecipient({ name: 'Ana', age: 7, shareConsent: 'public' })).toBe('Ana, 7 años');
  });

  it('first-name-only strips last names but keeps age', () => {
    expect(taglineForRecipient({ name: 'Ana María García', age: 5, shareConsent: 'first-name-only' })).toBe('Ana, 5 años');
  });

  it('anonymous hides the name; falls back to "un niño de N años"', () => {
    expect(taglineForRecipient({ name: 'Ana', age: 5, shareConsent: 'anonymous' })).toBe('un niño de 5 años');
  });

  it('anonymous without age degrades to "un niño"', () => {
    expect(taglineForRecipient({ name: 'Ana', shareConsent: 'anonymous' })).toBe('un niño');
  });

  it('includes up to 2 interests when present', () => {
    const t = taglineForRecipient({ name: 'Pepito', age: 7, interests: ['legos', 'dinosaurios', 'naves'], shareConsent: 'first-name-only' });
    expect(t).toContain('Pepito');
    expect(t).toContain('legos');
    expect(t).toContain('dinosaurios');
    expect(t).not.toContain('naves');
  });
});

describe('buildCaption: platform shape', () => {
  it('Instagram includes recipient, teaser, CTA and hashtags', () => {
    const c = buildCaption({ bundle: base, platform: 'instagram' });
    expect(c).toContain('Marcos');
    expect(c).toContain('6 años');
    expect(c).toContain('audiocuento');
    expect(c).toContain('#audiocuentos');
    expect(c).toContain('#fantasia');
    expect(c).toMatch(/link en bio|bio|Link/i);
  });

  it('TikTok keeps one line-ish and includes CTA', () => {
    const c = buildCaption({ bundle: base, platform: 'tiktok' });
    expect(c).toContain('Marcos');
    expect(c).toContain('🎧');
    expect(c).toContain('#audiocuentos');
  });

  it('X stays under 280 chars and keeps title', () => {
    const c = buildCaption({ bundle: base, platform: 'x' });
    expect(c.length).toBeLessThanOrEqual(280);
    expect(c).toContain('El dragón curioso');
  });

  it('YouTube produces a full description with vocab / duration when available', () => {
    const bundle = { ...base, sourceMeta: { estimatedDurationMin: 1.2, vocabularioNuevo: ['escupir', 'llamarada'] } };
    const c = buildCaption({ bundle, platform: 'youtube' });
    expect(c).toContain('~1.2 min');
    expect(c).toContain('Vocabulario nuevo');
    expect(c).toContain('escupir');
  });

  it('Spotify returns empty string (RSS-only)', () => {
    expect(buildCaption({ bundle: base, platform: 'spotify' })).toBe('');
  });
});

describe('buildCaption: consent', () => {
  it('Anonymous consent hides the name across platforms', () => {
    const bundle = { ...base, recipient: { name: 'Marcos', age: 6, shareConsent: 'anonymous' as const } };
    for (const platform of ['x', 'tiktok', 'instagram', 'youtube'] as const) {
      const c = buildCaption({ bundle, platform });
      expect(c).not.toContain('Marcos');
    }
  });

  it('Missing recipient produces a generic dedication (no "para undefined")', () => {
    const bundle = { ...base, recipient: undefined };
    const c = buildCaption({ bundle, platform: 'instagram' });
    expect(c).not.toContain('undefined');
    expect(c).toMatch(/hecho a medida|AudioKids/);
  });
});

describe('buildCaption: multi-part', () => {
  it('appends "Parte i de N" on instagram part captions', () => {
    const c = buildCaption({ bundle: base, platform: 'instagram', part: { index: 2, total: 3 } });
    expect(c).toContain('Parte 2 de 3');
  });
});

describe('buildCaption: length enforcement', () => {
  it('X caption stays under 280 even with very long titles', () => {
    const longTitle = 'Un título extraordinariamente largo '.repeat(10);
    const bundle = { ...base, text: { ...base.text, title: longTitle } };
    const c = buildCaption({ bundle, platform: 'x' });
    expect(c.length).toBeLessThanOrEqual(280);
  });
});

describe('extractTeaser', () => {
  it('returns up to 2 full sentences', () => {
    const t = extractTeaser('Primera frase. Segunda frase. Tercera frase.');
    expect(t).toBe('Primera frase. Segunda frase.');
  });

  it('respects the maxChars cap even mid-sentence', () => {
    const body = 'Una frase muy muy muy muy muy muy muy larga que ocupa demasiado espacio y debería cortarse.';
    const t = extractTeaser(body, { maxChars: 40 });
    expect(t.length).toBeLessThanOrEqual(42); // cap + ellipsis
    expect(t.endsWith('…') || /[.!?]$/.test(t)).toBe(true);
  });

  it('does not break mid-word when body has spaces (cuts on last space)', () => {
    const body = 'palabra uno palabra dos palabra tres palabra cuatro palabra cinco palabra seis palabra siete palabra ocho palabra nueve palabra diez';
    const t = extractTeaser(body, { maxChars: 60 });
    expect(t).toMatch(/\w…$|[.!?]$/);
    // The text before the ellipsis should end at a complete word.
    const withoutEllipsis = t.replace(/…$/, '');
    expect(withoutEllipsis).not.toMatch(/ $/); // no trailing space
    expect(withoutEllipsis.endsWith(' ')).toBe(false);
    // And it should not cut a word in half; i.e. the last char is a whole-word ending.
    // If the string is longer than any individual word we'd find no half-words.
    const chunks = withoutEllipsis.split(/\s+/);
    for (const c of chunks) expect(body).toContain(c);
  });

  it('returns empty string for empty body', () => {
    expect(extractTeaser('')).toBe('');
  });
});

describe('deriveHashtags', () => {
  it('includes mood hashtag when theme.mood is present', () => {
    expect(deriveHashtags(base)).toContain('fantasia');
  });

  it('deduplicates base tags', () => {
    const tags = deriveHashtags(base);
    expect(new Set(tags).size).toBe(tags.length);
  });

  it('normalises accented mood values', () => {
    const b = { ...base, theme: { mood: 'educación' } };
    expect(deriveHashtags(b)).toContain('educacion');
  });
});
