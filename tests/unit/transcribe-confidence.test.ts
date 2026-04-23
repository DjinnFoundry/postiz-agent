import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SubtitleGenerator } from '../../src/media/subtitles.js';
import { transcribeTool } from '../../src/tools/transcribe.js';
import { silentLogger } from '../../src/core/tool.js';
import type { WordEntry } from '../../src/types.js';
import type { ContentBundle } from '../../src/core/content-bundle.js';

const bundle: ContentBundle = {
  id: 'confidence-bundle',
  kind: 'audio-story',
  primaryMedia: '/fake/audio.wav',
  text: { body: 'Marcos corre.' },
  locale: 'es',
};

const ctx = {
  bundle,
  workDir: '/tmp/transcribe-confidence',
  state: {},
  logger: silentLogger,
};

function stubGenerator(words: WordEntry[]) {
  return vi
    .spyOn(SubtitleGenerator.prototype, 'generate')
    .mockResolvedValue({ words, jsonPath: '/tmp/fake.json' });
}

describe('transcribeTool minConfidence', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards whisper words unchanged when minConfidence is not set', async () => {
    stubGenerator([
      { text: 'Marcos', start: 0, end: 0.4, confidence: 0.3 },
      { text: 'corre',  start: 0.4, end: 0.8, confidence: 0.95 },
    ]);
    const input = { bundle, workDir: ctx.workDir };
    const out = await transcribeTool.run(input, ctx);
    expect(out.words).toHaveLength(2);
    expect(out.warnings).toEqual([]);
    expect(out.lowConfidenceWords).toBe(0);
  });

  it('counts and warns about words below the confidence threshold', async () => {
    stubGenerator([
      { text: 'Marcos', start: 0,   end: 0.4, confidence: 0.30 },
      { text: 'mierdos', start: 0.4, end: 0.8, confidence: 0.25 },
      { text: 'corre',  start: 0.8, end: 1.2, confidence: 0.95 },
      { text: 'rapido', start: 1.2, end: 1.6, confidence: 0.90 },
    ]);
    const input = { bundle, workDir: ctx.workDir, minConfidence: 0.5 };
    const out = await transcribeTool.run(input, ctx);
    expect(out.lowConfidenceWords).toBe(2);
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatch(/2 words with confidence < 0\.5/);
    expect(out.warnings[0]).toMatch(/hallucination/i);
  });

  it('emits no warnings when every word clears the threshold', async () => {
    stubGenerator([
      { text: 'Marcos', start: 0,   end: 0.4, confidence: 0.91 },
      { text: 'corre',  start: 0.4, end: 0.8, confidence: 0.95 },
    ]);
    const input = { bundle, workDir: ctx.workDir, minConfidence: 0.5 };
    const out = await transcribeTool.run(input, ctx);
    expect(out.warnings).toEqual([]);
    expect(out.lowConfidenceWords).toBe(0);
  });

  it('treats words with unknown confidence as passing the threshold', async () => {
    stubGenerator([
      { text: 'Marcos', start: 0, end: 0.4 },
      { text: 'corre',  start: 0.4, end: 0.8, confidence: 0.95 },
    ]);
    const input = { bundle, workDir: ctx.workDir, minConfidence: 0.5 };
    const out = await transcribeTool.run(input, ctx);
    expect(out.lowConfidenceWords).toBe(0);
    expect(out.warnings).toEqual([]);
  });

  it('rejects minConfidence values outside [0,1]', () => {
    expect(() =>
      transcribeTool.inputSchema.parse({ bundle, workDir: ctx.workDir, minConfidence: 1.5 }),
    ).toThrow();
    expect(() =>
      transcribeTool.inputSchema.parse({ bundle, workDir: ctx.workDir, minConfidence: -0.1 }),
    ).toThrow();
  });

  it('still produces valid output against the tool outputSchema', async () => {
    stubGenerator([
      { text: 'Marcos', start: 0, end: 0.4, confidence: 0.30 },
      { text: 'corre',  start: 0.4, end: 0.8, confidence: 0.95 },
    ]);
    const input = { bundle, workDir: ctx.workDir, minConfidence: 0.5 };
    const out = await transcribeTool.run(input, ctx);
    const parsed = transcribeTool.outputSchema.safeParse(out);
    expect(parsed.success).toBe(true);
  });
});
