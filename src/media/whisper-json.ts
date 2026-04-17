import { readFileSync } from 'node:fs';

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

/** Flattens whisper's segment/word structure into one entry per word. */
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
