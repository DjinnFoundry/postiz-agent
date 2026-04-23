import { existsSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { run } from '../lib/process.js';
import { parseWhisperJson, flattenWords } from './whisper-json.js';
import type { WordEntry } from '../types.js';

export type { WordEntry };

export interface TranscribeOptions {
  audioPath: string;
  outputDir: string;
  language?: string;
  model?: 'tiny' | 'base' | 'small' | 'medium' | 'large-v3';
}

export interface TranscribeResult {
  words: WordEntry[];
  jsonPath: string;
}

/**
 * Transcribes an audio file with whisper (CLI) and returns word-level entries.
 * Cached on disk: subsequent calls with the same audio skip the transcription.
 */
export class SubtitleGenerator {
  async generate(opts: TranscribeOptions): Promise<TranscribeResult> {
    const { audioPath, outputDir, language = 'es', model = 'base' } = opts;
    if (!existsSync(audioPath)) throw new Error(`Audio not found: ${audioPath}`);
    mkdirSync(outputDir, { recursive: true });

    const base = basename(audioPath).replace(/\.[^.]+$/, '');
    const jsonPath = join(outputDir, `${base}.json`);

    if (!existsSync(jsonPath)) {
      await run('whisper', [
        audioPath,
        '--model', model,
        '--language', language,
        '--output_format', 'json',
        '--output_dir', outputDir,
        '--word_timestamps', 'True',
        '--verbose', 'False',
      ]);
      if (!existsSync(jsonPath)) {
        throw new Error(`Whisper did not produce expected JSON: ${jsonPath}`);
      }
    }

    const data = parseWhisperJson(jsonPath);
    const words: WordEntry[] = flattenWords(data).map(w => ({
      text: w.word,
      start: w.start,
      end: w.end,
      ...(w.probability != null ? { confidence: w.probability } : {}),
    }));
    return { words, jsonPath };
  }
}
