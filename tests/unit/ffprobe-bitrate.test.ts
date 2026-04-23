import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/process.js', () => ({
  run: vi.fn(),
}));

import { run } from '../../src/lib/process.js';
import { probeBitrateKbps } from '../../src/lib/ffprobe.js';

const mockRun = vi.mocked(run);

describe('probeBitrateKbps', () => {
  beforeEach(() => {
    mockRun.mockReset();
  });

  it('parses a plain bps value and returns kbps (bits/sec divided by 1000)', async () => {
    mockRun.mockResolvedValueOnce({ stdout: '128000\n', stderr: '' });
    const kbps = await probeBitrateKbps('/tmp/audio.mp3');
    expect(kbps).toBe(128);
  });

  it('returns a small number for a very low-bitrate MP3', async () => {
    mockRun.mockResolvedValueOnce({ stdout: '8000\n', stderr: '' });
    const kbps = await probeBitrateKbps('/tmp/audio.mp3');
    expect(kbps).toBe(8);
  });

  it('trims surrounding whitespace', async () => {
    mockRun.mockResolvedValueOnce({ stdout: '   192000   \n', stderr: '' });
    const kbps = await probeBitrateKbps('/tmp/audio.mp3');
    expect(kbps).toBe(192);
  });

  it('throws a descriptive error when ffprobe returns N/A (no bitrate stream)', async () => {
    mockRun.mockResolvedValueOnce({ stdout: 'N/A\n', stderr: '' });
    await expect(probeBitrateKbps('/tmp/audio.mp3')).rejects.toThrow(/bitrate/i);
  });

  it('throws a descriptive error on empty stdout', async () => {
    mockRun.mockResolvedValueOnce({ stdout: '', stderr: '' });
    await expect(probeBitrateKbps('/tmp/audio.mp3')).rejects.toThrow(/bitrate/i);
  });

  it('propagates ffprobe process errors', async () => {
    mockRun.mockRejectedValueOnce(new Error('ffprobe exited 1: file not found'));
    await expect(probeBitrateKbps('/tmp/audio.mp3')).rejects.toThrow(/ffprobe/);
  });

  it('invokes ffprobe with the expected CLI args (stream bit_rate, audio stream)', async () => {
    mockRun.mockResolvedValueOnce({ stdout: '128000\n', stderr: '' });
    await probeBitrateKbps('/tmp/audio.mp3');
    const [cmd, args] = mockRun.mock.calls[0]!;
    expect(cmd).toBe('ffprobe');
    expect(args).toContain('-show_entries');
    expect(args).toContain('stream=bit_rate');
    expect(args).toContain('-select_streams');
    expect(args).toContain('a:0');
    expect(args).toContain('/tmp/audio.mp3');
  });
});
