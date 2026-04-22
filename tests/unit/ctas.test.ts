import { describe, it, expect } from 'vitest';
import { listCtas, selectCta } from '../../src/copy/ctas.js';
import type { Platform } from '../../src/types.js';

describe('CTA catalog integrity', () => {
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
