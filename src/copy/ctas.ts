import { createHash } from 'node:crypto';
import ctasData from './ctas.json' with { type: 'json' };
import type { Platform } from '../types.js';

export interface CtaVariant {
  id: string;
  text: string;
}

interface CtaFile {
  version: number;
  variants: Record<string, CtaVariant[]>;
}

const DATA = ctasData as CtaFile;

export function listCtas(platform: Platform): CtaVariant[] {
  return DATA.variants[platform] ?? [];
}

/**
 * Deterministic CTA selection for a given (platform, bundleId). The same pair
 * always resolves to the same variant id, so retries and re-runs render the
 * same caption. Returns null for platforms without CTAs (e.g. spotify).
 */
export function selectCta(platform: Platform, bundleId: string): CtaVariant | null {
  const variants = listCtas(platform);
  if (variants.length === 0) return null;
  const n = hashToInt(`${platform}:${bundleId}`);
  return variants[n % variants.length];
}

function hashToInt(s: string): number {
  const hex = createHash('sha1').update(s).digest('hex').slice(0, 8);
  return parseInt(hex, 16);
}
