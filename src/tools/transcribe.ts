import { join, basename } from 'node:path';
import { z } from 'zod';
import { SubtitleGenerator } from '../media/subtitles.js';
import { detectSilence, trimSilence as runTrimSilence } from '../lib/silence.js';
import { probeDurationSec } from '../lib/ffprobe.js';
import type { Tool } from '../core/tool.js';

const TRIM_TRIGGER_SEC = 1.0;

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
  /**
   * Auto-strip leading/trailing silence before transcription. Opt-in; when
   * true, runs ffmpeg silencedetect on the source and, if either end has
   * more than 1s of silence, writes a trimmed copy into workDir and
   * transcribes that instead. Prevents misalignment of whisper word timings
   * with HyperFrames slide pacing.
   */
  trimSilence: z.boolean().optional(),
}).passthrough();

const OutputSchema = z.object({
  words: z.array(z.object({
    text: z.string(),
    start: z.number(),
    end: z.number(),
    confidence: z.number().optional(),
  })),
  jsonPath: z.string(),
  /** Non-fatal advisories (e.g. low-confidence word count, trim summary). */
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
    const originalSrc = input.audioPath ?? (input.bundle.primaryMedia as string);
    const lang = (input.language ?? input.bundle.locale ?? 'es').split('-')[0];

    const warnings: string[] = [];
    let srcForWhisper = originalSrc;

    if (input.trimSilence === true) {
      try {
        const totalSec = await probeDurationSec(originalSrc);
        const { leadingSec, trailingSec } = await detectSilence(originalSrc, totalSec);
        if (leadingSec > TRIM_TRIGGER_SEC || trailingSec > TRIM_TRIGGER_SEC) {
          const base = basename(originalSrc).replace(/\.[^.]+$/, '');
          const trimmedPath = join(ctx.workDir, `${base}.trimmed.mp3`);
          await runTrimSilence(originalSrc, trimmedPath, totalSec, leadingSec, trailingSec);
          srcForWhisper = trimmedPath;
          const msg = `trimmed ${leadingSec.toFixed(1)}s of leading silence, ${trailingSec.toFixed(1)}s trailing`;
          warnings.push(msg);
          ctx.logger.info(`  silence: ${msg}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.logger.warn(`  silence: detection failed, using original audio (${msg})`);
      }
    }

    ctx.logger.info(`  whisper: ${srcForWhisper} (${lang})`);
    const { words, jsonPath } = await gen.generate({
      audioPath: srcForWhisper,
      outputDir: ctx.workDir,
      language: lang,
      ...(input.model ? { model: input.model } : {}),
    });

    let lowConfidenceWords = 0;
    if (input.minConfidence != null) {
      const threshold = input.minConfidence;
      for (const w of words) {
        if (w.confidence != null && w.confidence < threshold) lowConfidenceWords++;
      }
      if (lowConfidenceWords > 0) {
        const warnMsg = `${lowConfidenceWords} words with confidence < ${threshold} (possible whisper hallucination)`;
        warnings.push(warnMsg);
        ctx.logger.warn(`  whisper: ${warnMsg}`);
      }
    }

    return { words, jsonPath, warnings, lowConfidenceWords };
  },
};
