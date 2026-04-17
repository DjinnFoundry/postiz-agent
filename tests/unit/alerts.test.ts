import { describe, expect, it, vi } from 'vitest';
import { buildFailurePayload, notifyFailure } from '../../src/lib/alerts.js';

describe('buildFailurePayload()', () => {
  it('returns the expected shape with defaults', () => {
    const p = buildFailurePayload({ slug: 'dragon', platform: 'tiktok', error: 'boom' });
    expect(p.slug).toBe('dragon');
    expect(p.platform).toBe('tiktok');
    expect(p.error).toBe('boom');
    expect(p.attempts).toBe(1);
    expect(typeof p.timestamp).toBe('string');
    expect(p.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('honours explicit attempts and timestamp', () => {
    const p = buildFailurePayload({
      slug: 'a', platform: 'x', error: 'e', attempts: 5, timestamp: '2026-04-16T00:00:00Z',
    });
    expect(p.attempts).toBe(5);
    expect(p.timestamp).toBe('2026-04-16T00:00:00Z');
  });
});

describe('notifyFailure()', () => {
  it('is a no-op when no webhookUrl is provided', async () => {
    const fetchSpy = vi.fn();
    const out = await notifyFailure(
      { slug: 'a', platform: 'x', error: 'e' },
      undefined,
      { fetch: fetchSpy as unknown as typeof fetch },
    );
    expect(out).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs the payload as JSON and returns true on 2xx', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const out = await notifyFailure(
      { slug: 'dragon', platform: 'tiktok', error: '500', attempts: 3 },
      'https://hooks.example/test',
      { fetch: fetchSpy as unknown as typeof fetch },
    );
    expect(out).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://hooks.example/test');
    expect((init as RequestInit).method).toBe('POST');
    const body = JSON.parse((init as { body: string }).body);
    expect(body.slug).toBe('dragon');
    expect(body.platform).toBe('tiktok');
    expect(body.error).toBe('500');
    expect(body.attempts).toBe(3);
    expect(typeof body.timestamp).toBe('string');
  });

  it('swallows fetch errors (fire-and-forget)', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('network down'));
    const out = await notifyFailure(
      { slug: 'a', platform: 'x', error: 'e' },
      'https://hooks.example/test',
      { fetch: fetchSpy as unknown as typeof fetch },
    );
    expect(out).toBe(false);
  });

  it('returns false on non-2xx', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const out = await notifyFailure(
      { slug: 'a', platform: 'x', error: 'e' },
      'https://hooks.example/test',
      { fetch: fetchSpy as unknown as typeof fetch },
    );
    expect(out).toBe(false);
  });
});
