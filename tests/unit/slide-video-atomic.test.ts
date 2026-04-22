import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * We test the finalize() / assertValidMp4 logic via a subclass that exposes them,
 * because the real build() runs ffmpeg + whisper + hyperframes and those live
 * outside the unit-test scope. The atomicity invariants (tmp + rename, size
 * threshold, duration probe) are pure enough to isolate.
 */
import { SlideVideoBuilder } from '../../src/media/slide-video.js';

class TestableBuilder extends SlideVideoBuilder {
  // Re-expose private helpers for testing by calling through an accessor.
  public async finalizeForTest(rendered: string, outputPath: string): Promise<void> {
    // Access private methods via type-assert bypass.
    await (this as unknown as { finalize: (a: string, b: string) => Promise<void> }).finalize(rendered, outputPath);
  }
  public persistForTest(err: unknown, logFile: string): void {
    (this as unknown as { persistStderr: (a: unknown, b: string) => void }).persistStderr(err, logFile);
  }
}

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'slide-video-'));
});

afterEach(() => {
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* noop */ }
});

/** Minimal "valid" MP4 placeholder: the check requires >=100KB, not a parse, so a padded file suffices for size assertion tests. */
function writePadded(path: string, bytes: number, content = 'x'): void {
  writeFileSync(path, Buffer.alloc(bytes, content));
}

describe('SlideVideoBuilder.finalize', () => {
  it('rejects an empty rendered file and does NOT leave partial output', async () => {
    const rendered = join(scratch, 'render.mp4');
    writeFileSync(rendered, ''); // 0 bytes
    const outputPath = join(scratch, 'out.mp4');
    const builder = new TestableBuilder();
    await expect(builder.finalizeForTest(rendered, outputPath)).rejects.toThrowError(/too small|corrupt|empty/i);
    expect(existsSync(outputPath)).toBe(false);
    expect(existsSync(`${outputPath}.tmp`)).toBe(false);
  });

  it('rejects a render below the minimum size threshold', async () => {
    const rendered = join(scratch, 'render.mp4');
    writePadded(rendered, 50_000); // 50KB < 100KB threshold
    const outputPath = join(scratch, 'out.mp4');
    const builder = new TestableBuilder();
    await expect(builder.finalizeForTest(rendered, outputPath)).rejects.toThrowError(/too small/);
    expect(existsSync(outputPath)).toBe(false);
  });

  it('rejects a render missing entirely', async () => {
    const rendered = join(scratch, 'nope.mp4');
    const outputPath = join(scratch, 'out.mp4');
    const builder = new TestableBuilder();
    await expect(builder.finalizeForTest(rendered, outputPath)).rejects.toThrowError();
  });
});

describe('SlideVideoBuilder.persistStderr', () => {
  it('writes the error message to the provided log file', () => {
    const logFile = join(scratch, 'render.log');
    const builder = new TestableBuilder();
    builder.persistForTest(new Error('something went boom'), logFile);
    expect(existsSync(logFile)).toBe(true);
    const content = require('node:fs').readFileSync(logFile, 'utf-8');
    expect(content).toContain('something went boom');
  });

  it('tolerates non-Error throwables', () => {
    const logFile = join(scratch, 'render.log');
    const builder = new TestableBuilder();
    builder.persistForTest('raw string throw', logFile);
    const content = require('node:fs').readFileSync(logFile, 'utf-8');
    expect(content).toContain('raw string throw');
  });
});
