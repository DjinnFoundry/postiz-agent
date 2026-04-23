import { describe, it, expect } from 'vitest';
import { listCtas, selectCta } from '../../src/copy/ctas.js';
import type { Platform } from '../../src/types.js';

describe('CTA catalog integrity (default locale)', () => {
  for (const platform of ['x', 'tiktok', 'instagram', 'youtube'] as Platform[]) {
    it(`${platform} has >=5 variants`, () => {
      const v = listCtas(platform);
      expect(v.length).toBeGreaterThanOrEqual(5);
      for (const c of v) {
        expect(c.id).toBeTruthy();
        expect(c.text.length).toBeGreaterThan(5);
      }
    });
  }

  it('ids are unique within each platform', () => {
    for (const platform of ['x', 'tiktok', 'instagram', 'youtube'] as Platform[]) {
      const v = listCtas(platform);
      expect(new Set(v.map(c => c.id)).size).toBe(v.length);
    }
  });

  it('spotify returns no variants', () => {
    expect(listCtas('spotify')).toEqual([]);
  });
});

describe('CTA catalog integrity (EN locale)', () => {
  for (const platform of ['x', 'tiktok', 'instagram', 'youtube'] as Platform[]) {
    it(`${platform} has >=5 EN variants`, () => {
      const v = listCtas(platform, 'en');
      expect(v.length).toBeGreaterThanOrEqual(5);
      for (const c of v) {
        expect(c.id).toBeTruthy();
        expect(c.text.length).toBeGreaterThan(5);
      }
    });
  }

  it('EN variant ids are prefixed to avoid collision with ES ids', () => {
    const enIg = listCtas('instagram', 'en').map(v => v.id);
    const esIg = listCtas('instagram', 'es').map(v => v.id);
    for (const id of enIg) expect(esIg).not.toContain(id);
  });

  it('unknown locale falls back to the catalog fallback locale', () => {
    const fr = listCtas('instagram', 'fr');
    const es = listCtas('instagram', 'es');
    expect(fr.map(v => v.id)).toEqual(es.map(v => v.id));
  });
});

describe('selectCta', () => {
  it('returns null for platforms without CTAs', () => {
    expect(selectCta('spotify', 'anything')).toBeNull();
  });

  it('is deterministic for the same (platform, bundleId)', () => {
    const a = selectCta('instagram', 'dragon-marcos');
    const b = selectCta('instagram', 'dragon-marcos');
    expect(a).not.toBeNull();
    expect(b?.id).toBe(a?.id);
  });

  it('distributes across the variant list over many bundle ids', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const v = selectCta('instagram', `bundle-${i}`);
      if (v) seen.add(v.id);
    }
    // Instagram has 7 variants; we should have hit most of them across 40 ids.
    expect(seen.size).toBeGreaterThanOrEqual(4);
  });

  it('different platforms select independently', () => {
    const ig = selectCta('instagram', 'same-id');
    const tk = selectCta('tiktok', 'same-id');
    expect(ig).not.toBeNull();
    expect(tk).not.toBeNull();
    // Not a strict inequality assertion (they could collide), but the ids must be
    // from their respective platform lists.
    const igIds = new Set(listCtas('instagram').map(v => v.id));
    const tkIds = new Set(listCtas('tiktok').map(v => v.id));
    expect(igIds.has(ig!.id)).toBe(true);
    expect(tkIds.has(tk!.id)).toBe(true);
  });

  it('locale=en picks a variant from the EN catalog', () => {
    const v = selectCta('instagram', 'dragon-marcos', 'en');
    expect(v).not.toBeNull();
    const enIds = new Set(listCtas('instagram', 'en').map(x => x.id));
    expect(enIds.has(v!.id)).toBe(true);
  });

  it('locale=en and locale=es resolve within their own catalogs for the same bundleId', () => {
    const es = selectCta('instagram', 'dragon-marcos', 'es');
    const en = selectCta('instagram', 'dragon-marcos', 'en');
    const esIds = new Set(listCtas('instagram', 'es').map(v => v.id));
    const enIds = new Set(listCtas('instagram', 'en').map(v => v.id));
    expect(esIds.has(es!.id)).toBe(true);
    expect(enIds.has(en!.id)).toBe(true);
  });

  it('unknown locale falls back to the fallback catalog', () => {
    const fr = selectCta('instagram', 'dragon-marcos', 'fr');
    const es = selectCta('instagram', 'dragon-marcos', 'es');
    expect(fr?.id).toBe(es?.id);
  });

  it('accepts BCP 47 tags (es-ES, en-US) and normalises to the primary subtag', () => {
    const esES = selectCta('instagram', 'dragon-marcos', 'es-ES');
    const es = selectCta('instagram', 'dragon-marcos', 'es');
    expect(esES?.id).toBe(es?.id);

    const enUS = selectCta('instagram', 'dragon-marcos', 'en-US');
    const en = selectCta('instagram', 'dragon-marcos', 'en');
    expect(enUS?.id).toBe(en?.id);
  });
});

describe('integration: caption builder uses rotator', () => {
  it('selecting the same slug on the same platform always produces the same caption', async () => {
    const { buildCaption } = await import('../../src/copy/caption-builder.js');
    const bundle = {
      id: 'stable-bundle',
      kind: 'audio-story' as const,
      text: { title: 'test', body: 'Una historia. Dos historias.' },
      locale: 'es',
      theme: { mood: 'fantasia' },
    };
    const a = buildCaption({ bundle, platform: 'instagram' });
    const b = buildCaption({ bundle, platform: 'instagram' });
    expect(a).toBe(b);
  });
});
