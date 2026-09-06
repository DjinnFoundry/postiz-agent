import { describe, expect, it } from 'vitest';
import { buildCaptionRich } from '../../src/copy/caption-builder.js';
import type { ContentBundle } from '../../src/core/content-bundle.js';

const bundle: ContentBundle = {
  id: 'product-launch', kind: 'text', locale: 'es',
  text: { body: 'Ya puedes guardar tus lecturas.\nPruébalo en https://example.com.' },
};

describe('product captions', () => {
  it.each(['text', 'image-post', 'video'] as const)('preserves the supplied %s copy on every platform', kind => {
    for (const platform of ['x', 'instagram', 'tiktok', 'youtube'] as const) {
      const result = buildCaptionRich({ bundle: { ...bundle, kind }, platform });
      expect(result.caption).toBe(bundle.text.body);
      expect(result.ctaVariantId).toBeNull();
      expect(result.hashtags).toEqual([]);
    }
  });

  it('includes only the product title, hashtags and CTA that were configured', () => {
    const result = buildCaptionRich({
      bundle: { ...bundle, kind: 'image-post', text: { ...bundle.text, title: 'ZetaRead' } },
      platform: 'instagram',
      brand: { name: 'ZetaRead', hashtags: ['lectura'], ctas: { instagram: [{ id: 'read', text: 'Descúbrelo.' }] } },
    });
    expect(result.caption).toBe(`ZetaRead\n\n${bundle.text.body}\n\nDescúbrelo.\n\n#lectura`);
    expect(result.ctaVariantId).toBe('read');
    expect(result.caption).not.toMatch(/audiocuento|AudioKids|hecho a medida/i);
  });

  it('rejects overlong product copy instead of silently removing its final link', () => {
    expect(() => buildCaptionRich({ bundle: { ...bundle, text: { body: 'a'.repeat(281) } }, platform: 'x' })).toThrow(/caption.*280|280.*caption/i);
  });
});
