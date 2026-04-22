import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { preflightPlatform } from '../../src/core/preflight.js';
import type { ContentBundle } from '../../src/core/content-bundle.js';

const FIXTURE = resolve(__dirname, '../fixtures/audiokids-output/dragon-marcos.mp3');

const baseBundle: ContentBundle = {
  id: 'dragon-marcos',
  kind: 'audio-story',
  primaryMedia: FIXTURE,
  text: { title: 'El dragón curioso', body: 'érase una vez' },
  locale: 'es-ES',
};

describe('preflightPlatform', () => {
  it('spotify always preflights as soft-skip (RSS-only)', async () => {
    const r = await preflightPlatform(baseBundle, 'spotify', { probeDuration: async () => 60 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('skip');
  });

  it('missing primaryMedia for audio-story → permanent', async () => {
    const r = await preflightPlatform({ ...baseBundle, primaryMedia: undefined }, 'tiktok', { probeDuration: async () => 60 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('permanent');
  });

  it('primaryMedia does not exist on disk → permanent', async () => {
    const r = await preflightPlatform({ ...baseBundle, primaryMedia: '/tmp/nope-123.mp3' }, 'tiktok', { probeDuration: async () => 60 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('permanent');
      expect(r.reason).toMatch(/not found on disk/);
    }
  });

  it('cover path declared but missing → permanent', async () => {
    const r = await preflightPlatform(
      { ...baseBundle, cover: '/tmp/no-cover.png' },
      'tiktok',
      { probeDuration: async () => 60 },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('permanent');
  });

  it('audio > platform cap on non-splittable platform → permanent with actionable hint', async () => {
    const r = await preflightPlatform(baseBundle, 'tiktok', { probeDuration: async () => 700 }); // 700s > 600s TikTok cap
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('permanent');
      expect(r.hint).toMatch(/shorten|drop tiktok/);
    }
  });

  it('audio > platform cap on instagram → OK (splittable)', async () => {
    const r = await preflightPlatform(baseBundle, 'instagram', { probeDuration: async () => 700 });
    expect(r.ok).toBe(true);
  });

  it('audio under cap → OK', async () => {
    const r = await preflightPlatform(baseBundle, 'tiktok', { probeDuration: async () => 60 });
    expect(r.ok).toBe(true);
  });

  it('ffprobe failure → needs-config', async () => {
    const r = await preflightPlatform(baseBundle, 'tiktok', {
      probeDuration: async () => { throw new Error('ffprobe exited 1'); },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('needs-config');
  });

  it('X cap at 4h gives an X-Premium hint when exceeded', async () => {
    const r = await preflightPlatform(baseBundle, 'x', { probeDuration: async () => 15_000 }); // > 14400 (4h)
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toMatch(/Premium/);
  });
});
