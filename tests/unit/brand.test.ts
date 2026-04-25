import { describe, it, expect } from 'vitest';
import { brandFromTenant } from '../../src/copy/brand.js';
import type { TenantContext } from '../../src/core/tenant.js';

function tenant(brand: TenantContext['brand']): TenantContext {
  return {
    slug: 't',
    postiz: { apiUrl: '', apiKey: '' },
    audiokids: { outputDir: '' },
    youtubecli: { path: '' },
    alerts: { webhookUrl: '' },
    paths: {
      dataDir: '', decisionsLog: '', uploadCache: '', themeDecisions: '',
      renderLogsDir: '', coversDir: '', galleriesDir: '',
    },
    brand,
  };
}

describe('brandFromTenant', () => {
  it('returns empty BrandContext when tenant.brand is empty', () => {
    expect(brandFromTenant(tenant({}))).toEqual({});
  });

  it('extracts name when present and trims whitespace', () => {
    expect(brandFromTenant(tenant({ name: '  ZetaRead  ' }))).toEqual({ name: 'ZetaRead' });
  });

  it('ignores empty or whitespace-only name', () => {
    expect(brandFromTenant(tenant({ name: '   ' })).name).toBeUndefined();
  });

  it('reads defaultHashtags as the canonical hashtags slot', () => {
    const b = brandFromTenant(tenant({ defaultHashtags: ['booklovers', 'reading'] }));
    expect(b.hashtags).toEqual(['booklovers', 'reading']);
  });

  it('also accepts brand.hashtags as an alias of defaultHashtags', () => {
    const b = brandFromTenant(tenant({ hashtags: ['fast', 'practical'] }));
    expect(b.hashtags).toEqual(['fast', 'practical']);
  });

  it('drops non-string hashtags silently', () => {
    const b = brandFromTenant(tenant({ defaultHashtags: ['ok', 42, '', null, ' '] as unknown[] as string[] }));
    expect(b.hashtags).toEqual(['ok']);
  });

  it('extracts per-platform CTA variants when shape is valid', () => {
    const b = brandFromTenant(tenant({
      ctas: {
        instagram: [{ id: 'zr-ig-1', text: 'Read more' }],
        x: [{ id: 'zr-x-1', text: 'Subscribe' }],
      },
    }));
    expect(b.ctas?.instagram).toEqual([{ id: 'zr-ig-1', text: 'Read more' }]);
    expect(b.ctas?.x).toEqual([{ id: 'zr-x-1', text: 'Subscribe' }]);
  });

  it('drops invalid CTA variants (missing id or text)', () => {
    const b = brandFromTenant(tenant({
      ctas: {
        instagram: [
          { id: 'good', text: 'Read more' },
          { id: 'no-text' } as unknown as { id: string; text: string },
          { text: 'no-id' } as unknown as { id: string; text: string },
        ],
      },
    }));
    expect(b.ctas?.instagram).toEqual([{ id: 'good', text: 'Read more' }]);
  });

  it('drops unknown platform keys in CTAs', () => {
    const b = brandFromTenant(tenant({
      ctas: {
        instagram: [{ id: 'ok', text: 'go' }],
        nosuch: [{ id: 'wrong', text: 'wrong' }],
      } as unknown as TenantContext['brand']['ctas'],
    }));
    expect(b.ctas?.instagram).toBeDefined();
    expect((b.ctas as Record<string, unknown>).nosuch).toBeUndefined();
  });

  it('returns empty when CTAs has no valid platforms', () => {
    const b = brandFromTenant(tenant({ ctas: { unknown: [] } as unknown as TenantContext['brand']['ctas'] }));
    expect(b.ctas).toBeUndefined();
  });
});
