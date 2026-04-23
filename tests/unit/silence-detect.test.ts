import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/process.js', () => ({
  run: vi.fn(),
}));

import { run } from '../../src/lib/process.js';
import { parseSilencedetectStderr, detectSilence, trimSilence } from '../../src/lib/silence.js';

const mockRun = vi.mocked(run);

describe('parseSilencedetectStderr', () => {
  it('returns zero leading/trailing when ffmpeg reports no silence', () => {
    const stderr = `
frame=  100 fps=0.0 q=-0.0 size=N/A time=00:00:02.50 bitrate=N/A speed=5.0x
size=N/A time=00:01:00.00 bitrate=N/A
`;
    const result = parseSilencedetectStderr(stderr, 60);
    expect(result.leadingSec).toBe(0);
    expect(result.trailingSec).toBe(0);
  });

  it('detects leading silence when silence_start=0 and silence_end>0', () => {
    const stderr = `
[silencedetect @ 0x600000] silence_start: 0
[silencedetect @ 0x600000] silence_end: 3.5 | silence_duration: 3.5
`;
    const result = parseSilencedetectStderr(stderr, 60);
    expect(result.leadingSec).toBeCloseTo(3.5, 3);
    expect(result.trailingSec).toBe(0);
  });

  it('detects trailing silence when silence_start near total duration and no silence_end', () => {
    const stderr = `
[silencedetect @ 0x600000] silence_start: 57.2
`;
    const result = parseSilencedetectStderr(stderr, 60);
    expect(result.leadingSec).toBe(0);
    expect(result.trailingSec).toBeCloseTo(60 - 57.2, 3);
  });

  it('detects both leading and trailing silence', () => {
    const stderr = `
[silencedetect @ 0x600000] silence_start: 0
[silencedetect @ 0x600000] silence_end: 2.0 | silence_duration: 2.0
[silencedetect @ 0x600000] silence_start: 58.5
[silencedetect @ 0x600000] silence_end: 60.0 | silence_duration: 1.5
`;
    const result = parseSilencedetectStderr(stderr, 60);
    expect(result.leadingSec).toBeCloseTo(2.0, 3);
    expect(result.trailingSec).toBeCloseTo(1.5, 3);
  });

  it('ignores mid-clip silence (not leading, not trailing)', () => {
    const stderr = `
[silencedetect @ 0x600000] silence_start: 20.0
[silencedetect @ 0x600000] silence_end: 21.5 | silence_duration: 1.5
`;
    const result = parseSilencedetectStderr(stderr, 60);
    expect(result.leadingSec).toBe(0);
    expect(result.trailingSec).toBe(0);
  });

  it('leading silence that does not start at 0 is not leading', () => {
    const stderr = `
[silencedetect @ 0x600000] silence_start: 1.2
[silencedetect @ 0x600000] silence_end: 3.5 | silence_duration: 2.3
`;
    const result = parseSilencedetectStderr(stderr, 60);
    expect(result.leadingSec).toBe(0);
    expect(result.trailingSec).toBe(0);
  });
});

describe('detectSilence', () => {
  beforeEach(() => {
    mockRun.mockReset();
  });

  it('invokes ffmpeg with silencedetect filter and parses the stderr', async () => {
    mockRun.mockResolvedValueOnce({
      stdout: '',
      stderr: `
[silencedetect @ 0x600000] silence_start: 0
[silencedetect @ 0x600000] silence_end: 2.5 | silence_duration: 2.5
`,
    });
    const result = await detectSilence('/tmp/a.mp3', 60);
    expect(result.leadingSec).toBeCloseTo(2.5, 3);
    expect(result.trailingSec).toBe(0);
    const [cmd, args] = mockRun.mock.calls[0]!;
    expect(cmd).toBe('ffmpeg');
    expect(args.join(' ')).toMatch(/silencedetect/);
    expect(args).toContain('/tmp/a.mp3');
  });

  it('accepts custom threshold and minDuration parameters', async () => {
    mockRun.mockResolvedValueOnce({ stdout: '', stderr: '' });
    await detectSilence('/tmp/a.mp3', 60, -30, 1.0);
    const [, args] = mockRun.mock.calls[0]!;
    expect(args.join(' ')).toMatch(/n=-30dB/);
    expect(args.join(' ')).toMatch(/d=1/);
  });
});

describe('trimSilence', () => {
  beforeEach(() => {
    mockRun.mockReset();
  });

  it('invokes ffmpeg with -ss and -t to strip leading/trailing silence', async () => {
    mockRun.mockResolvedValueOnce({ stdout: '', stderr: '' });
    await trimSilence('/tmp/src.mp3', '/tmp/dst.mp3', 60, 2.0, 1.5);
    const [cmd, args] = mockRun.mock.calls[0]!;
    expect(cmd).toBe('ffmpeg');
    expect(args).toContain('-ss');
    expect(args).toContain('2');
    expect(args).toContain('-t');
    expect(args).toContain(String(60 - 2.0 - 1.5));
    expect(args).toContain('/tmp/src.mp3');
    expect(args).toContain('/tmp/dst.mp3');
  });

  it('trims only leading when trailing is zero', async () => {
    mockRun.mockResolvedValueOnce({ stdout: '', stderr: '' });
    await trimSilence('/tmp/src.mp3', '/tmp/dst.mp3', 60, 3.0, 0);
    const [, args] = mockRun.mock.calls[0]!;
    expect(args).toContain('3');
    expect(args).toContain(String(60 - 3.0));
  });
});
