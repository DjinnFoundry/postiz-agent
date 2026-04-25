import { describe, it, expect } from 'vitest';
import { MockInboxProvider } from '../../src/inbox/mock.js';
import { createInboxRegistry } from '../../src/inbox/registry.js';

describe('MockInboxProvider', () => {
  it('returns deterministic items per platform', async () => {
    const x = new MockInboxProvider('x');
    const a = await x.listPending();
    const b = await x.listPending();
    expect(a.items.map(i => i.id)).toEqual(b.items.map(i => i.id));
    expect(a.platform).toBe('x');
    expect(a.items.length).toBeGreaterThanOrEqual(2);
  });

  it('respects limit', async () => {
    const ig = new MockInboxProvider('instagram');
    const r = await ig.listPending({ limit: 1 });
    expect(r.items).toHaveLength(1);
  });

  it('exposes a cursor when items were returned', async () => {
    const r = await new MockInboxProvider('x').listPending();
    expect(r.cursor).toBeDefined();
  });

  it('postReply records what was posted with a generated id', async () => {
    const yt = new MockInboxProvider('youtube');
    const a = await yt.postReply('youtube-001', 'Gracias por tu comentario');
    expect(a.id).toMatch(/^mock-reply-1-to-youtube-001$/);
    expect(a.url).toMatch(/youtube/);
    const b = await yt.postReply('youtube-002', 'Otra respuesta');
    expect(b.id).toMatch(/^mock-reply-2-to-youtube-002$/);
    expect(yt.__debugPosted()).toHaveLength(2);
  });

  it('postReply rejects empty text', async () => {
    await expect(new MockInboxProvider('x').postReply('id', '')).rejects.toThrowError(/empty text/);
  });

  it('items vary by platform: instagram uses kind="comment" instead of "reply"', async () => {
    const x = await new MockInboxProvider('x').listPending();
    const ig = await new MockInboxProvider('instagram').listPending();
    expect(x.items[1].kind).toBe('reply');
    expect(ig.items[1].kind).toBe('comment');
  });
});

describe('createInboxRegistry', () => {
  it('default: every supported platform has a mock provider', () => {
    const r = createInboxRegistry();
    expect(r.platforms().sort()).toEqual(['instagram', 'tiktok', 'x', 'youtube']);
    expect(r.get('x')).not.toBeNull();
  });

  it('returns null for spotify (no inbox concept)', () => {
    const r = createInboxRegistry();
    expect(r.get('spotify')).toBeNull();
  });

  it('perPlatform overrides win over the default mock', async () => {
    const customProvider = new MockInboxProvider('x');
    const r = createInboxRegistry({ perPlatform: { x: customProvider } });
    expect(r.get('x')).toBe(customProvider);
  });
});
