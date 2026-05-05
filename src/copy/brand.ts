import { z } from 'zod';
import { PlatformSchema, type Platform } from '../types.js';
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
 * Schema for the open-ended `brand` block stored in tenants/<slug>/config.json.
 * Two keys are accepted for the hashtag list — `defaultHashtags` (the
 * canonical name written by the init wizard) and `hashtags` (a friendlier
 * alias for hand-edited configs). CTA entries below the minimum {id, text}
 * shape are dropped silently rather than failing the whole parse, because
 * brand config errors should degrade to "use defaults" not "publish blows up".
 */
const NonEmptyTrimmedString = z.string().trim().min(1);

const CtaVariantSchema = z.object({
  id: z.string(),
  text: z.string(),
});

const BrandOverridesSchema = z.object({
  name: NonEmptyTrimmedString.optional(),
  defaultHashtags: z.array(z.unknown()).optional(),
  hashtags: z.array(z.unknown()).optional(),
  ctas: z.record(z.unknown()).optional(),
}).passthrough();

/**
 * Build a BrandContext from a TenantContext. Anything we don't recognise
 * passes through to the open-ended `brand` block; anything that fails the
 * shape check is dropped so the caption pipeline always has something
 * usable.
 */
export function brandFromTenant(tenant: TenantContext): BrandContext {
  const parsed = BrandOverridesSchema.safeParse(tenant.brand ?? {});
  if (!parsed.success) return {};

  const overrides = parsed.data;
  const out: BrandContext = {};
  if (overrides.name) out.name = overrides.name;

  const tags = pickHashtags(overrides.defaultHashtags ?? overrides.hashtags);
  if (tags.length) out.hashtags = tags;

  const ctas = pickCtas(overrides.ctas);
  if (ctas) out.ctas = ctas;

  return out;
}

function pickHashtags(raw: unknown[] | undefined): string[] {
  if (!raw) return [];
  return raw.filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
}

function pickCtas(raw: Record<string, unknown> | undefined): Partial<Record<Platform, CtaVariant[]>> | undefined {
  if (!raw) return undefined;
  const out: Partial<Record<Platform, CtaVariant[]>> = {};
  for (const [platformKey, list] of Object.entries(raw)) {
    const platform = PlatformSchema.safeParse(platformKey);
    if (!platform.success) continue;
    if (!Array.isArray(list)) continue;
    const variants: CtaVariant[] = [];
    for (const v of list) {
      const parsed = CtaVariantSchema.safeParse(v);
      if (parsed.success) variants.push(parsed.data);
    }
    if (variants.length) out[platform.data] = variants;
  }
  return Object.keys(out).length ? out : undefined;
}
