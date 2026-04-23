import { z } from 'zod';
import { moderateWords } from '../media/caption-moderation.js';
import type { Tool } from '../core/tool.js';

const WordEntrySchema = z.object({
  text: z.string(),
  start: z.number(),
  end: z.number(),
});

const InputSchema = z.object({
  bundle: z.any(),
  words: z.array(WordEntrySchema),
  mode: z.enum(['replace', 'drop']).optional(),
}).passthrough();

const OutputSchema = z.object({
  words: z.array(WordEntrySchema),
  replacements: z.number().int().min(0),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

/**
 * `moderate-captions` runs the Spanish blocklist over the word-level transcript
 * from `transcribe`. Updates `words` in pipeline state. No-op when the transcript
 * is empty (e.g. if transcribe was skipped).
 */
export const moderateCaptionsTool: Tool<Input, Output> = {
  name: 'moderate-captions',
  description: 'Filter the word-level transcript through a locale-specific blocklist. Input: words[]. Output: moderated words[] + replacements count.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  composes: ['render-slide-video'],
  examples: [
    {
      description: 'Replace blocklisted tokens with a safe substitute (default mode).',
      input: { words: [{ text: 'hola', start: 0, end: 0.3 }, { text: 'mundo', start: 0.4, end: 0.8 }] },
    },
    {
      description: 'Drop blocklisted tokens entirely instead of replacing them (shortens the caption timeline).',
      input: { mode: 'drop', words: [{ text: 'ejemplo', start: 0, end: 0.5 }] },
    },
  ],

  async preflight(input) {
    if (!input.words?.length) return { ok: false, reason: 'no words to moderate (transcript empty)' };
    return { ok: true };
  },

  async run(input, ctx) {
    const result = moderateWords(input.words, { mode: input.mode ?? 'replace' });
    if (result.replacements > 0) {
      ctx.logger.warn(`  moderation: replaced ${result.replacements} token(s)`);
    }
    return { words: result.words, replacements: result.replacements };
  },
};
