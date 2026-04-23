import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * We test the finalize / persistStderr invariants against the pure helpers in
 * render-output.ts. The real build() runs ffmpeg + whisper + hyperframes which
 * lives outside the unit-test scope. The atomicity invariants (tmp + rename,
 * size threshold, duration probe) are pure enough to isolate here.
 */
import { finalizeRender, persistStderr } from '../../src/media/render-output.js';

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

describe('finalizeRender', () => {
  it('rejects an empty rendered file and does NOT leave partial output', async () => {
    const rendered = join(scratch, 'render.mp4');
    writeFileSync(rendered, '');
    const outputPath = join(scratch, 'out.mp4');
    await expect(finalizeRender(rendered, outputPath)).rejects.toThrowError(/too small|corrupt|empty/i);
    expect(existsSync(outputPath)).toBe(false);
    expect(existsSync(`${outputPath}.tmp`)).toBe(false);
  });

  it('rejects a render below the minimum size threshold', async () => {
    const rendered = join(scratch, 'render.mp4');
    writePadded(rendered, 50_000);
    const outputPath = join(scratch, 'out.mp4');
    await expect(finalizeRender(rendered, outputPath)).rejects.toThrowError(/too small/);
    expect(existsSync(outputPath)).toBe(false);
  });

  it('rejects a render missing entirely', async () => {
    const rendered = join(scratch, 'nope.mp4');
    const outputPath = join(scratch, 'out.mp4');
    await expect(finalizeRender(rendered, outputPath)).rejects.toThrowError();
  });
});

describe('persistStderr', () => {
  it('writes the error message to the provided log file', () => {
    const logFile = join(scratch, 'render.log');
    persistStderr(new Error('something went boom'), logFile);
    expect(existsSync(logFile)).toBe(true);
    const content = readFileSync(logFile, 'utf-8');
    expect(content).toContain('something went boom');
  });

  it('tolerates non-Error throwables', () => {
    const logFile = join(scratch, 'render.log');
    persistStderr('raw string throw', logFile);
    const content = readFileSync(logFile, 'utf-8');
    expect(content).toContain('raw string throw');
  });
});
