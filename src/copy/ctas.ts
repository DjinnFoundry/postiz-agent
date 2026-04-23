import { createHash } from 'node:crypto';
import ctasData from './ctas.json' with { type: 'json' };
import { primaryLocale } from './hashtags.js';
import type { Platform } from '../types.js';

export interface CtaVariant {
  id: string;
  text: string;
}

interface CtaLocaleEntry {
  x?: CtaVariant[];
  tiktok?: CtaVariant[];
  instagram?: CtaVariant[];
  youtube?: CtaVariant[];
  [platform: string]: CtaVariant[] | undefined;
}

interface CtaFile {
  version: number;
  fallback: string;
  locales: Record<string, CtaLocaleEntry>;
}

const DATA = ctasData as CtaFile;

function resolveEffectiveLocale(locale: string | undefined): string {
  const primary = primaryLocale(locale ?? DATA.fallback);
  return DATA.locales[primary] ? primary : DATA.fallback;
}

export function listCtas(platform: Platform, locale?: string): CtaVariant[] {
  const effective = resolveEffectiveLocale(locale);
  return DATA.locales[effective]?.[platform] ?? [];
}

/**
 * Deterministic CTA selection for a given (platform, bundleId, locale). The
 * same triple always resolves to the same variant id, so retries and re-runs
 * render the same caption. Returns null for platforms without CTAs (e.g. spotify).
 */
export function selectCta(platform: Platform, bundleId: string, locale?: string): CtaVariant | null {
  const effective = resolveEffectiveLocale(locale);
  const variants = DATA.locales[effective]?.[platform] ?? [];
  if (variants.length === 0) return null;
  const n = hashToInt(`${platform}:${effective}:${bundleId}`);
  return variants[n % variants.length];
}

function hashToInt(s: string): number {
  const hex = createHash('sha1').update(s).digest('hex').slice(0, 8);
  return parseInt(hex, 16);
}
