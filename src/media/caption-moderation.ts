import blocklist from './spanish-blocklist.json' with { type: 'json' };

export interface WordEntry {
  text: string;
  start: number;
  end: number;
}

export interface ModerateOptions {
  /** 'replace' swaps the token text for '***' of equal length; 'drop' removes the entry entirely. */
  mode?: 'replace' | 'drop';
  /** Extra blocklist terms to apply on top of the shipped Spanish list. Case-insensitive. */
  extraBlocklist?: string[];
}

export interface ModerateResult {
  words: WordEntry[];
  replacements: number;
}

/**
 * Normalise a token: lowercase, strip trailing punctuation, strip accents.
 * Whisper emits things like "Mierda," — we need to match "mierda" against the
 * blocklist regardless of case, accent, or attached punctuation.
 */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Walks the word-level transcript and moderates tokens that match the blocklist.
 * Pure function — no IO, no side effects. Returns a fresh array.
 */
export function moderateWords(
  words: WordEntry[],
  opts: ModerateOptions = {},
): ModerateResult {
  const mode = opts.mode ?? 'replace';
  const set = new Set<string>();
  for (const w of blocklist as string[]) set.add(normalize(w));
  for (const w of opts.extraBlocklist ?? []) set.add(normalize(w));

  const out: WordEntry[] = [];
  let replacements = 0;
  for (const entry of words) {
    const key = normalize(entry.text);
    if (!key || !set.has(key)) {
      out.push(entry);
      continue;
    }
    replacements++;
    if (mode === 'drop') continue;
    // 'replace' mode: preserve any trailing punctuation to keep timing natural.
    const lettersOnly = entry.text.match(/^(\p{L}+)(.*)$/u);
    const mask = '*'.repeat(lettersOnly?.[1]?.length ?? entry.text.length);
    const tail = lettersOnly?.[2] ?? '';
    out.push({ ...entry, text: mask + tail });
  }
  return { words: out, replacements };
}
