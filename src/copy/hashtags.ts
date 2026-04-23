import hashtagsData from './hashtags.json' with { type: 'json' };
import type { ContentBundle } from '../core/content-bundle.js';

interface HashtagLocaleEntry {
  base: string[];
}

interface HashtagFile {
  version: number;
  fallback: string;
  locales: Record<string, HashtagLocaleEntry>;
}

const DATA = hashtagsData as HashtagFile;

/**
 * Resolves the primary language subtag from a BCP 47 tag or ISO 639-1 code.
 * "es-ES" -> "es", "en-US" -> "en", "fr" -> "fr".
 */
export function primaryLocale(locale: string): string {
  return (locale ?? '').trim().split('-')[0].toLowerCase();
}

export function baseHashtagsForLocale(locale: string): string[] {
  const primary = primaryLocale(locale);
  const entry = DATA.locales[primary] ?? DATA.locales[DATA.fallback];
  return [...entry.base];
}

export function deriveHashtags(bundle: ContentBundle): string[] {
  const base = baseHashtagsForLocale(bundle.locale);
  const mood = bundle.theme?.mood;
  if (mood) base.push(normalizeHashtag(mood));
  return dedupe(base);
}

function normalizeHashtag(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
}

function dedupe(arr: string[]): string[] {
  const seen = new Set<string>();
  return arr.filter(x => (seen.has(x) ? false : (seen.add(x), true)));
}
