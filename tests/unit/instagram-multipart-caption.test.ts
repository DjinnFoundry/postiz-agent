import { describe, it, expect } from 'vitest';
import { buildCaptionRich } from '../../src/copy/caption-builder.js';
import { deriveHashtags } from '../../src/copy/hashtags.js';
import type { ContentBundle } from '../../src/core/content-bundle.js';

const longBundle: ContentBundle = {
  id: 'dragon-marcos-multipart',
  kind: 'audio-story',
  text: {
    title: 'El dragón curioso',
    body: 'Marcos caminaba por el bosque cuando escuchó un ruido extraño. Detrás de un árbol grande, encontró a un pequeño dragón que lloraba. El dragón no podía escupir fuego.',
  },
  locale: 'es-ES',
  theme: { mood: 'fantasia' },
  recipient: { name: 'Marcos', age: 6, shareConsent: 'first-name-only' },
};

function build3(bundle: ContentBundle) {
  return [1, 2, 3].map((index) =>
    buildCaptionRich({ bundle, platform: 'instagram', part: { index, total: 3 } }),
  ) as [ReturnType<typeof buildCaptionRich>, ReturnType<typeof buildCaptionRich>, ReturnType<typeof buildCaptionRich>];
}

describe('Instagram multi-part caption: brand coherence across parts', () => {
  it('resuelve el MISMO ctaVariantId para las 3 partes del mismo bundle', () => {
    const [p1, p2, p3] = build3(longBundle);
    expect(p1.ctaVariantId).not.toBeNull();
    expect(p2.ctaVariantId).toBe(p1.ctaVariantId);
    expect(p3.ctaVariantId).toBe(p1.ctaVariantId);
  });

  it('cada caption lleva "Parte i de 3" con i distinto por parte', () => {
    const [p1, p2, p3] = build3(longBundle);
    expect(p1.caption).toContain('Parte 1 de 3');
    expect(p2.caption).toContain('Parte 2 de 3');
    expect(p3.caption).toContain('Parte 3 de 3');

    expect(p1.caption).not.toContain('Parte 2 de 3');
    expect(p1.caption).not.toContain('Parte 3 de 3');
    expect(p2.caption).not.toContain('Parte 1 de 3');
    expect(p2.caption).not.toContain('Parte 3 de 3');
    expect(p3.caption).not.toContain('Parte 1 de 3');
    expect(p3.caption).not.toContain('Parte 2 de 3');
  });

  it('las 3 partes comparten el mismo teaser', () => {
    const [p1, p2, p3] = build3(longBundle);
    expect(p1.teaser.length).toBeGreaterThan(0);
    expect(p2.teaser).toBe(p1.teaser);
    expect(p3.teaser).toBe(p1.teaser);
  });

  it('las 3 partes comparten los mismos hashtags', () => {
    const [p1, p2, p3] = build3(longBundle);
    const expected = deriveHashtags(longBundle);
    expect(p1.hashtags).toEqual(expected);
    expect(p2.hashtags).toEqual(p1.hashtags);
    expect(p3.hashtags).toEqual(p1.hashtags);
  });

  it('el texto del CTA es literalmente idéntico en las 3 partes', () => {
    const [p1, p2, p3] = build3(longBundle);
    const stripPart = (s: string): string => s.replace(/Parte \d+ de \d+/g, '').replace(/\s+/g, ' ').trim();
    expect(stripPart(p2.caption)).toBe(stripPart(p1.caption));
    expect(stripPart(p3.caption)).toBe(stripPart(p1.caption));
  });

  it('cambiar bundle.id puede cambiar el ctaVariantId (rotación por bundleId, no por parte)', () => {
    const variantsSeen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const b: ContentBundle = { ...longBundle, id: `multipart-bundle-${i}` };
      const r = buildCaptionRich({ bundle: b, platform: 'instagram', part: { index: 1, total: 3 } });
      if (r.ctaVariantId) variantsSeen.add(r.ctaVariantId);
    }
    expect(variantsSeen.size).toBeGreaterThanOrEqual(2);
  });

  it('invariante combinado: dos bundles distintos publicados en multi-part cada uno mantienen coherencia intra-bundle', () => {
    const [a1, a2, a3] = build3({ ...longBundle, id: 'cuento-a' });
    const [b1, b2, b3] = build3({ ...longBundle, id: 'cuento-b' });

    expect(a2.ctaVariantId).toBe(a1.ctaVariantId);
    expect(a3.ctaVariantId).toBe(a1.ctaVariantId);
    expect(b2.ctaVariantId).toBe(b1.ctaVariantId);
    expect(b3.ctaVariantId).toBe(b1.ctaVariantId);
  });
});
