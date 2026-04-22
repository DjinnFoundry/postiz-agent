import { z } from 'zod';
import { SubtitleGenerator } from '../media/subtitles.js';
import type { Tool } from '../core/tool.js';

const InputSchema = z.object({
  bundle: z.any(),
  workDir: z.string(),
  /** Override the source audio path. Defaults to bundle.primaryMedia. */
  audioPath: z.string().optional(),
  /** Override locale. Defaults to bundle.locale. */
  language: z.string().optional(),
  model: z.enum(['tiny', 'base', 'small', 'medium', 'large-v3']).optional(),
}).passthrough();

const OutputSchema = z.object({
  words: z.array(z.object({
    text: z.string(),
    start: z.number(),
    end: z.number(),
  })),
  jsonPath: z.string(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

/**
 * `transcribe` wraps the Whisper-based SubtitleGenerator as a Tool. It reads
 * bundle.primaryMedia (audio) and emits a word-level transcript used by later
 * steps (moderate-captions, render-slide-video).
 */
export const transcribeTool: Tool<Input, Output> = {
  name: 'transcribe',
  description: 'Word-level speech-to-text via Whisper. Input: bundle with audio primaryMedia. Output: words[] and cached json path.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,

  async preflight(input) {
    const src = input.audioPath ?? input.bundle?.primaryMedia;
    if (!src) return { ok: false, reason: 'no audio source: set args.audioPath or bundle.primaryMedia' };
    return { ok: true };
  },

  async run(input, ctx) {
    const gen = new SubtitleGenerator();
    const src = input.audioPath ?? (input.bundle.primaryMedia as string);
    const lang = (input.language ?? input.bundle.locale ?? 'es').split('-')[0];
    ctx.logger.info(`  whisper: ${src} (${lang})`);
    const { words, jsonPath } = await gen.generate({
      audioPath: src,
      outputDir: ctx.workDir,
      language: lang,
      ...(input.model ? { model: input.model } : {}),
    });
    return { words, jsonPath };
  },
};
