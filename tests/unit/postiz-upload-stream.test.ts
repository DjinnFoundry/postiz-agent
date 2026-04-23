import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock readFileSync to throw if anyone tries to slurp the upload payload into RAM.
// The postiz module imports readFileSync at the top level, so this mock replaces
// that binding before the SUT is loaded. Other fs members are preserved.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    readFileSync: vi.fn((path: Parameters<typeof actual.readFileSync>[0], opts?: Parameters<typeof actual.readFileSync>[1]) => {
      const p = String(path);
      // The upload-cache JSON is allowed; only flag attempts to read the video payload.
      if (p.endsWith('.mp4')) {
        throw new Error(`regression: uploadMedia slurped ${p} into RAM via readFileSync`);
      }
      return actual.readFileSync(path, opts);
    }),
  };
});

import { PostizClient } from '../../src/platforms/postiz.js';
import { UploadCache } from '../../src/lib/upload-cache.js';

function mockResponse(body: unknown, ok = true, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
    statusText: ok ? 'OK' : 'ERR',
  });
}

function makeClient(cachePath: string) {
  return new PostizClient(
    'https://postiz.test/public/v1',
    'test-key',
    new UploadCache(cachePath),
  );
}

describe('PostizClient.uploadMedia streaming', () => {
  let tmpDir: string;
  let videoPath: string;
  let cachePath: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'postiz-stream-'));
    videoPath = join(tmpDir, 'video.mp4');
    cachePath = join(tmpDir, 'upload-cache.json');
    // 2 MB payload: big enough to matter, small enough to keep the test fast.
    const payload = Buffer.alloc(2 * 1024 * 1024, 0x42);
    writeFileSync(videoPath, payload);
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      mockResponse({ id: 'media-123', path: '/uploads/video.mp4', url: 'https://cdn/x.mp4' }),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not slurp the MP4 into RAM via readFileSync', async () => {
    const client = makeClient(cachePath);
    const result = await client.uploadMedia(videoPath);
    expect(result.id).toBe('media-123');
  });

  it('uploads the file via multipart form and returns the media id', async () => {
    const client = makeClient(cachePath);
    const result = await client.uploadMedia(videoPath);

    expect(result).toEqual({ id: 'media-123', path: '/uploads/video.mp4', url: 'https://cdn/x.mp4' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://postiz.test/public/v1/upload');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeInstanceOf(FormData);
    const form = init!.body as FormData;
    const file = form.get('file');
    expect(file).toBeTruthy();
    expect(typeof (file as Blob).size).toBe('number');
    expect((file as Blob).size).toBe(2 * 1024 * 1024);
    expect((file as File).name).toBe('video.mp4');
  });

  it('reuses the sha256 cache and skips the network on second upload', async () => {
    const client = makeClient(cachePath);
    await client.uploadMedia(videoPath);
    await client.uploadMedia(videoPath);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const raw = JSON.parse(readFileSync(cachePath, 'utf-8'));
    const entries = Object.values(raw.entries) as Array<{ mediaId: string }>;
    expect(entries[0].mediaId).toBe('media-123');
  });
});
