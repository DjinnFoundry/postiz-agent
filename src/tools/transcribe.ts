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
  /**
   * Minimum per-word whisper confidence in [0,1]. When set, the tool counts
   * words below this threshold and emits a warning. Guards against silent
   * hallucinations (e.g. "Marcos" mis-heard as a profanity that moderation
   * then censors without anyone noticing). Undefined = disabled (back-compat).
   */
  minConfidence: z.number().min(0).max(1).optional(),
}).passthrough();

const OutputSchema = z.object({
  words: z.array(z.object({
    text: z.string(),
    start: z.number(),
    end: z.number(),
    confidence: z.number().optional(),
  })),
  jsonPath: z.string(),
  /** Non-fatal advisories (e.g. low-confidence word count). */
  warnings: z.array(z.string()),
  /** 0 when minConfidence is unset (feature disabled). */
  lowConfidenceWords: z.number().int().min(0),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

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

    const warnings: string[] = [];
    let lowConfidenceWords = 0;
    if (input.minConfidence != null) {
      const threshold = input.minConfidence;
      for (const w of words) {
        if (w.confidence != null && w.confidence < threshold) lowConfidenceWords++;
      }
      if (lowConfidenceWords > 0) {
        warnings.push(
          `${lowConfidenceWords} words with confidence < ${threshold} (possible whisper hallucination)`,
        );
        ctx.logger.warn(`  whisper: ${warnings[0]}`);
      }
    }

    return { words, jsonPath, warnings, lowConfidenceWords };
  },
};
