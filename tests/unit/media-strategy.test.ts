import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveMediaForPlatform } from '../../src/core/media-strategy.js';
import type { ContentBundle } from '../../src/core/content-bundle.js';
import type { WordEntry } from '../../src/types.js';

function mkTmpFile(name: string, bytes = 100): string {
  const dir = mkdtempSync(join(tmpdir(), 'media-strategy-'));
  const path = join(dir, name);
  writeFileSync(path, Buffer.alloc(bytes, 'x'));
  return path;
}

function bundle(over: Partial<ContentBundle>): ContentBundle {
  return {
    id: 'test-id',
    kind: 'audio-story',
    text: { title: 't', body: 'b' },
    locale: 'es',
    ...over,
  } as ContentBundle;
}

const FAKE_WORDS: WordEntry[] = [{ text: 'hola', start: 0, end: 0.3 }];

describe('resolveMediaForPlatform', () => {
  it('audio-story: invokes slide builder and returns rendered MP4 + needsSlideRender:true', async () => {
    let called = false;
    const builder = {
      build: async () => {
        called = true;
        return { outputPath: '/tmp/rendered.mp4', warnings: ['mood fallback'] };
      },
    };
    const result = await resolveMediaForPlatform({
      bundle: bundle({ kind: 'audio-story', primaryMedia: '/tmp/in.mp3' }),
      platform: 'tiktok',
      words: FAKE_WORDS,
      slideBuilder: builder,
      workDir: '/tmp/work',
    });
    expect(called).toBe(true);
    expect(result.mediaPath).toBe('/tmp/rendered.mp4');
    expect(result.needsSlideRender).toBe(true);
    expect(result.warnings).toEqual(['mood fallback']);
  });

  it('video: returns primaryMedia as-is, no slide rendering', async () => {
    const mp4 = mkTmpFile('clip.mp4');
    let builderCalled = false;
    const builder = { build: async () => { builderCalled = true; return { outputPath: '', warnings: [] }; } };
    const result = await resolveMediaForPlatform({
      bundle: bundle({ kind: 'video', primaryMedia: mp4 }),
      platform: 'tiktok',
      words: [],
      slideBuilder: builder,
      workDir: '/tmp/work',
    });
    expect(builderCalled).toBe(false);
    expect(result.mediaPath).toBe(mp4);
    expect(result.needsSlideRender).toBe(false);
    rmSync(mp4, { force: true });
  });

  it('image-post: returns primaryMedia (the image) as-is', async () => {
    const png = mkTmpFile('cover.png');
    const result = await resolveMediaForPlatform({
      bundle: bundle({ kind: 'image-post', primaryMedia: png }),
      platform: 'instagram',
      words: [],
      slideBuilder: { build: async () => { throw new Error('should not call'); } },
      workDir: '/tmp/work',
    });
    expect(result.mediaPath).toBe(png);
    expect(result.needsSlideRender).toBe(false);
    rmSync(png, { force: true });
  });

  it('text: returns null mediaPath (caption-only post)', async () => {
    const result = await resolveMediaForPlatform({
      bundle: bundle({ kind: 'text', primaryMedia: undefined }),
      platform: 'x',
      words: [],
      slideBuilder: { build: async () => { throw new Error('should not call'); } },
      workDir: '/tmp/work',
    });
    expect(result.mediaPath).toBeNull();
    expect(result.needsSlideRender).toBe(false);
  });

  it('audio-story without primaryMedia: throws', async () => {
    await expect(resolveMediaForPlatform({
      bundle: bundle({ kind: 'audio-story', primaryMedia: undefined }),
      platform: 'tiktok',
      words: FAKE_WORDS,
      slideBuilder: { build: async () => ({ outputPath: '', warnings: [] }) },
      workDir: '/tmp/work',
    })).rejects.toThrowError(/audio-story.*primaryMedia/);
  });

  it('video without primaryMedia: throws', async () => {
    await expect(resolveMediaForPlatform({
      bundle: bundle({ kind: 'video', primaryMedia: undefined }),
      platform: 'tiktok',
      words: [],
      slideBuilder: { build: async () => ({ outputPath: '', warnings: [] }) },
      workDir: '/tmp/work',
    })).rejects.toThrowError(/video.*primaryMedia/);
  });

  it('image-post without primaryMedia: throws', async () => {
    await expect(resolveMediaForPlatform({
      bundle: bundle({ kind: 'image-post', primaryMedia: undefined }),
      platform: 'instagram',
      words: [],
      slideBuilder: { build: async () => ({ outputPath: '', warnings: [] }) },
      workDir: '/tmp/work',
    })).rejects.toThrowError(/image-post.*primaryMedia/);
  });
});
