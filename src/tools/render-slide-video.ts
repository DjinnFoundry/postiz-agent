import { join } from 'node:path';
import { z } from 'zod';
import { SlideVideoBuilder } from '../media/slide-video.js';
import { PlatformSchema, VARIANTS } from '../types.js';
import type { Tool } from '../core/tool.js';

const WordEntrySchema = z.object({
  text: z.string(),
  start: z.number(),
  end: z.number(),
});

const InputSchema = z.object({
  bundle: z.any(),
  workDir: z.string(),
  platform: PlatformSchema,
  words: z.array(WordEntrySchema),
  outputPath: z.string().optional(),
  clipStartSec: z.number().nonnegative().optional(),
  clipDurationSec: z.number().positive().optional(),
  partIndex: z.number().int().positive().optional(),
  partTotal: z.number().int().positive().optional(),
}).passthrough();

const OutputSchema = z.object({
  videoPath: z.string(),
  warnings: z.array(z.string()),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

/**
 * `render-slide-video` wraps the HyperFrames-based SlideVideoBuilder. Produces
 * one MP4 per (bundle, platform, part) tuple. Consumes the moderated words
 * from the pipeline state when present.
 *
 * Preflight refuses when:
 *  - the platform has no video variant (e.g. spotify)
 *  - the words array is empty (no captions, no sync)
 *  - the bundle has no primaryMedia (no audio source)
 */
export const renderSlideVideoTool: Tool<Input, Output> = {
  name: 'render-slide-video',
  description: 'Render a slide-based MP4 from the bundle + transcript, sized for the given platform. Produces videoPath + warnings.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,

  async preflight(input) {
    const variant = VARIANTS[input.platform];
    if (!variant) return { ok: false, reason: `platform ${input.platform} has no video variant (e.g. rss-only)` };
    if (!input.words?.length) return { ok: false, reason: 'no transcript to sync captions' };
    if (!input.bundle?.primaryMedia) return { ok: false, reason: 'bundle has no primaryMedia audio source' };
    return { ok: true };
  },

  async run(input, ctx) {
    const builder = new SlideVideoBuilder();
    const outPath = input.outputPath ?? join(
      ctx.workDir,
      `${input.bundle.id}-${input.platform}${input.partIndex ? `-part${input.partIndex}` : ''}.mp4`,
    );
    const result = await builder.build({
      platform: input.platform,
      bundle: input.bundle,
      outputPath: outPath,
      words: input.words,
      ...(input.clipStartSec != null ? { clipStartSec: input.clipStartSec } : {}),
      ...(input.clipDurationSec != null ? { clipDurationSec: input.clipDurationSec } : {}),
      ...(input.partIndex != null ? { partIndex: input.partIndex } : {}),
      ...(input.partTotal != null ? { partTotal: input.partTotal } : {}),
      onWarn: (m) => ctx.logger.warn(m),
    });
    return { videoPath: result.outputPath, warnings: result.warnings };
  },
};
