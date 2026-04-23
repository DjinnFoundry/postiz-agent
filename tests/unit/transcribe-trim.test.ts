import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../src/lib/ffprobe.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/ffprobe.js')>(
    '../../src/lib/ffprobe.js',
  );
  return {
    ...actual,
    probeDurationSec: vi.fn(),
  };
});
vi.mock('../../src/lib/silence.js', () => ({
  detectSilence: vi.fn(),
  trimSilence: vi.fn(),
}));

import { SubtitleGenerator } from '../../src/media/subtitles.js';
import { transcribeTool } from '../../src/tools/transcribe.js';
import { silentLogger } from '../../src/core/tool.js';
import { detectSilence, trimSilence } from '../../src/lib/silence.js';
import { probeDurationSec } from '../../src/lib/ffprobe.js';
import type { ContentBundle } from '../../src/core/content-bundle.js';
import type { WordEntry } from '../../src/types.js';

const mockDetect = vi.mocked(detectSilence);
const mockTrim = vi.mocked(trimSilence);
const mockDuration = vi.mocked(probeDurationSec);

const bundle: ContentBundle = {
  id: 'trim-bundle',
  kind: 'audio-story',
  primaryMedia: '/fake/audio.mp3',
  text: { body: 'Hola.' },
  locale: 'es',
};

let workDir: string;

function stubGenerator(words: WordEntry[]) {
  return vi
    .spyOn(SubtitleGenerator.prototype, 'generate')
    .mockResolvedValue({ words, jsonPath: '/tmp/fake.json' });
}

describe('transcribeTool trimSilence', () => {
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'transcribe-trim-'));
    mockDetect.mockReset();
    mockTrim.mockReset();
    mockDuration.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('does NOT call detectSilence or trimSilence when trimSilence is false (default)', async () => {
    stubGenerator([{ text: 'hola', start: 0, end: 0.3 }]);
    const ctx = { bundle, workDir, state: {}, logger: silentLogger };
    const input = { bundle, workDir };
    const out = await transcribeTool.run(input, ctx);
    expect(mockDetect).not.toHaveBeenCalled();
    expect(mockTrim).not.toHaveBeenCalled();
    expect(out.warnings).toEqual([]);
  });

  it('detects silence but does not trim when leading and trailing are both below 1s', async () => {
    mockDuration.mockResolvedValue(60);
    mockDetect.mockResolvedValue({ leadingSec: 0.4, trailingSec: 0.2 });
    const genSpy = stubGenerator([{ text: 'hola', start: 0, end: 0.3 }]);
    const ctx = { bundle, workDir, state: {}, logger: silentLogger };
    const input = { bundle, workDir, trimSilence: true };
    const out = await transcribeTool.run(input, ctx);
    expect(mockDetect).toHaveBeenCalledOnce();
    expect(mockTrim).not.toHaveBeenCalled();
    expect(genSpy.mock.calls[0]![0].audioPath).toBe('/fake/audio.mp3');
    expect(out.warnings).toEqual([]);
  });

  it('trims and uses the new file when leading > 1s', async () => {
    mockDuration.mockResolvedValue(60);
    mockDetect.mockResolvedValue({ leadingSec: 3.2, trailingSec: 0.1 });
    mockTrim.mockResolvedValue(undefined);
    const genSpy = stubGenerator([{ text: 'hola', start: 0, end: 0.3 }]);
    const ctx = { bundle, workDir, state: {}, logger: silentLogger };
    const input = { bundle, workDir, trimSilence: true };
    const out = await transcribeTool.run(input, ctx);
    expect(mockTrim).toHaveBeenCalledOnce();
    const trimArgs = mockTrim.mock.calls[0]!;
    expect(trimArgs[0]).toBe('/fake/audio.mp3');
    expect(trimArgs[1]).toContain(workDir);
    expect(trimArgs[3]).toBeCloseTo(3.2, 3);
    expect(trimArgs[4]).toBeCloseTo(0.1, 3);
    const passedPath = genSpy.mock.calls[0]![0].audioPath;
    expect(passedPath).toBe(trimArgs[1]);
    expect(out.warnings.some(w => /trimmed/i.test(w))).toBe(true);
    expect(out.warnings[0]).toMatch(/3\.2/);
  });

  it('trims when trailing > 1s even if leading is zero', async () => {
    mockDuration.mockResolvedValue(60);
    mockDetect.mockResolvedValue({ leadingSec: 0, trailingSec: 4.5 });
    mockTrim.mockResolvedValue(undefined);
    stubGenerator([{ text: 'hola', start: 0, end: 0.3 }]);
    const ctx = { bundle, workDir, state: {}, logger: silentLogger };
    const input = { bundle, workDir, trimSilence: true };
    const out = await transcribeTool.run(input, ctx);
    expect(mockTrim).toHaveBeenCalledOnce();
    expect(out.warnings[0]).toMatch(/4\.5/);
  });

  it('output still conforms to outputSchema with trimSilence warnings', async () => {
    mockDuration.mockResolvedValue(60);
    mockDetect.mockResolvedValue({ leadingSec: 2.0, trailingSec: 1.5 });
    mockTrim.mockResolvedValue(undefined);
    stubGenerator([{ text: 'hola', start: 0, end: 0.3 }]);
    const ctx = { bundle, workDir, state: {}, logger: silentLogger };
    const input = { bundle, workDir, trimSilence: true };
    const out = await transcribeTool.run(input, ctx);
    const parsed = transcribeTool.outputSchema.safeParse(out);
    expect(parsed.success).toBe(true);
  });
});
