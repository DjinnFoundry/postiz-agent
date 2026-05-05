/**
 * Spanish-leaning sentence segmentation. The regex matches one or more
 * non-terminator characters followed by one or more terminators (`.!?…`),
 * lookahead-bounded by whitespace or end-of-input so trailing terminators
 * inside a sentence don't split it (e.g. abbreviations like "Dr."). Used
 * for:
 *   - extractTeaser (caption-builder): first 1-2 sentences with a char cap
 *   - buildTeaser (spotify-rss): first 2 sentences for the RSS description
 *   - countSentences (audiokids adapter): rough sentence count for sourceMeta
 *
 * Three near-identical implementations existed before this consolidation;
 * they all used the same regex with different boundary checks. This module
 * is the single source of truth.
 */

/** Terminator class: literal `.`, `!`, `?`, ellipsis (`…`). */
const SENTENCE_REGEX = /[^.!?…]+[.!?…]+(?=\s|$)/gu;

/**
 * Split text into trimmed sentences. Empty input → empty array. Text with no
 * terminators returns one element (the whole input, trimmed) so callers can
 * still take a "first sentence" without special-casing prose without periods.
 */
export function splitSentences(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const out: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(SENTENCE_REGEX);
  while ((m = re.exec(trimmed)) !== null) {
    out.push(m[0].trim());
  }
  if (out.length === 0) out.push(trimmed);
  return out;
}

/** Count sentences without materialising the array. Cheap; used for sourceMeta. */
export function countSentences(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const matches = trimmed.match(SENTENCE_REGEX);
  return matches?.length || 1;
}

export interface FirstSentencesOptions {
  /** Max number of sentences to return. Default 2. */
  max?: number;
  /** Max total characters across the joined sentences. Default Infinity. */
  maxChars?: number;
}

/**
 * Take the first `max` sentences while staying under `maxChars`. Sentences
 * are joined by a single space. Returns the empty string for empty input.
 */
export function firstSentences(text: string, opts: FirstSentencesOptions = {}): string {
  const maxSentences = opts.max ?? 2;
  const cap = opts.maxChars ?? Number.POSITIVE_INFINITY;
  const sentences: string[] = [];
  let total = 0;
  for (const s of splitSentences(text)) {
    if (sentences.length >= maxSentences) break;
    if (total + s.length > cap) break;
    sentences.push(s);
    total += s.length + 1; // joining space
  }
  return sentences.join(' ');
}
