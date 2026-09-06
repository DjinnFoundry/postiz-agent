import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { preflightPlatform } from '../../src/core/preflight.js';
import type { ContentBundle } from '../../src/core/content-bundle.js';

const image: ContentBundle = {
  id: 'product-image',
  kind: 'image-post',
  primaryMedia: resolve(__dirname, '../fixtures/audiokids-output/dragon-marcos-cover.png'),
  text: { body: 'Product announcement' },
  locale: 'en',
};

describe('image platform preflight', () => {
  it('rejects images for the YouTube video uploader before probing or uploading', async () => {
    const probeDuration = vi.fn();
    const result = await preflightPlatform(image, 'youtube', { probeDuration });
    expect(result).toMatchObject({ ok: false, kind: 'permanent' });
    if (!result.ok) expect(result.hint).toMatch(/video/);
    expect(probeDuration).not.toHaveBeenCalled();
  });

  it.each(['x', 'instagram', 'tiktok'] as const)('retains image support for %s', async platform => {
    expect(await preflightPlatform(image, platform)).toEqual({ ok: true });
  });
});
