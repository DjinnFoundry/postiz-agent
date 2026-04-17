import { readFileSync, writeFileSync } from 'node:fs';

export interface WhisperWord {
  word: string;
  start: number;
  end: number;
  probability?: number;
}

export interface WhisperSegment {
  id: number;
  start: number;
  end: number;
  text: string;
  words?: WhisperWord[];
}

export interface WhisperJson {
  text: string;
  segments: WhisperSegment[];
  language: string;
}

export function parseWhisperJson(path: string): WhisperJson {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/**
 * Flattens whisper's segment/word structure into one entry per word.
 */
export function flattenWords(json: WhisperJson): WhisperWord[] {
  const words: WhisperWord[] = [];
  for (const seg of json.segments) {
    if (!seg.words?.length) continue;
    for (const w of seg.words) {
      const text = w.word.trim();
      if (!text) continue;
      words.push({ ...w, word: text });
    }
  }
  return words;
}

/**
 * Emits a word-level SRT (one block per word). Feeds into @remotion/captions'
 * parseSrt() + createTikTokStyleCaptions() which then can combine N words per page.
 */
export function writeWordLevelSrt(words: WhisperWord[], outputPath: string): string {
  const blocks = words.map((w, i) =>
    `${i + 1}\n${fmt(w.start)} --> ${fmt(w.end)}\n${w.word}\n`,
  );
  writeFileSync(outputPath, blocks.join('\n'), 'utf-8');
  return outputPath;
}

function fmt(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const rem = ms % 1000;
  return `${p(h, 2)}:${p(m, 2)}:${p(s, 2)},${p(rem, 3)}`;
}

function p(n: number, w: number): string {
  return String(n).padStart(w, '0');
}
