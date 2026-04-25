import type { Platform } from '../types.js';
import type { TenantContext } from '../core/tenant.js';
import type { CtaVariant } from './ctas.js';

/**
 * BrandContext is the minimal personality bundle a tenant can override:
 * what name appears in captions ("AudioKids" by default), which hashtags
 * the agent attaches, and which CTAs rotate. Anything not provided falls
 * back to the toolkit defaults.
 */
export interface BrandContext {
  /** Display name shown in captions. Defaults to "AudioKids". */
  name?: string;
  /** Hashtag pool (replaces the locale base set when present). */
  hashtags?: string[];
  /** Per-platform CTA pool. Platforms not listed fall back to ctas.json. */
  ctas?: Partial<Record<Platform, CtaVariant[]>>;
}

/**
 * Build a BrandContext from a TenantContext. The tenant's brand block is a
 * `Record<string, unknown>` (open-ended for future fields) so we coerce the
 * known shape carefully and ignore anything we don't recognise yet.
 */
export function brandFromTenant(tenant: TenantContext): BrandContext {
  const brand = tenant.brand ?? {};
  const out: BrandContext = {};

  if (typeof brand.name === 'string' && brand.name.trim()) {
    out.name = brand.name.trim();
  }

  if (Array.isArray(brand.defaultHashtags)) {
    const tags = brand.defaultHashtags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
    if (tags.length) out.hashtags = tags;
  } else if (Array.isArray((brand as { hashtags?: unknown }).hashtags)) {
    const tags = ((brand as { hashtags?: unknown }).hashtags as unknown[])
      .filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
    if (tags.length) out.hashtags = tags;
  }

  const ctas = (brand as { ctas?: unknown }).ctas;
  if (ctas && typeof ctas === 'object' && !Array.isArray(ctas)) {
    const parsed: Partial<Record<Platform, CtaVariant[]>> = {};
    for (const [platform, list] of Object.entries(ctas as Record<string, unknown>)) {
      if (!isValidPlatform(platform) || !Array.isArray(list)) continue;
      const variants: CtaVariant[] = [];
      for (const v of list) {
        if (v && typeof v === 'object' && typeof (v as CtaVariant).id === 'string' && typeof (v as CtaVariant).text === 'string') {
          variants.push({ id: (v as CtaVariant).id, text: (v as CtaVariant).text });
        }
      }
      if (variants.length) parsed[platform] = variants;
    }
    if (Object.keys(parsed).length) out.ctas = parsed;
  }

  return out;
}

function isValidPlatform(s: string): s is Platform {
  return s === 'x' || s === 'tiktok' || s === 'instagram' || s === 'youtube' || s === 'spotify';
}
