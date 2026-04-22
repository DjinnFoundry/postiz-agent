import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { AudioKidsAdapter } from '../../src/adapters/audiokids.js';
import { ContentBundleSchema, resolveTagline } from '../../src/core/content-bundle.js';

const FIXTURE_DIR = resolve(__dirname, '../fixtures/audiokids-output');

describe('AudioKidsAdapter.loadBundle', () => {
  const adapter = new AudioKidsAdapter(FIXTURE_DIR);

  it('produces a schema-valid ContentBundle', () => {
    const bundle = adapter.loadBundle('dragon-marcos');
    expect(() => ContentBundleSchema.parse(bundle)).not.toThrow();
  });

  it('maps core AudioKids fields into bundle fields (not sourceMeta)', () => {
    const b = adapter.loadBundle('dragon-marcos');
    expect(b.id).toBe('dragon-marcos');
    expect(b.kind).toBe('audio-story');
    expect(b.text.title).toBe('El dragón curioso');
    expect(b.text.body).toMatch(/Marcos caminaba por el bosque/);
    expect(b.locale).toBe('es-ES');
    expect(b.theme?.mood).toBe('fantasia');
    expect(b.primaryMedia).toMatch(/dragon-marcos\.mp3$/);
    expect(b.cover).toMatch(/dragon-marcos(-cover)?\.png$/);
  });

  it('derives recipient from AudioKids meta.name + meta.age with first-name-only consent', () => {
    const b = adapter.loadBundle('dragon-marcos');
    expect(b.recipient).toBeDefined();
    expect(b.recipient?.name).toBe('Marcos');
    expect(b.recipient?.age).toBe(6);
    expect(b.recipient?.shareConsent).toBe('first-name-only');
  });

  it('preserves beats for multi-part splitting', () => {
    const b = adapter.loadBundle('dragon-marcos');
    expect(b.beats?.length).toBe(5);
    expect(b.beats?.[0].type).toBe('intro');
  });

  it('keeps AudioKids-specific fields in sourceMeta as escape hatch', () => {
    const b = adapter.loadBundle('dragon-marcos');
    expect(b.sourceMeta?.wordCount).toBe(145);
    expect(b.sourceMeta?.estimatedDurationMin).toBe(1.0);
  });

  it('resolveTagline respects first-name-only consent', () => {
    const b = adapter.loadBundle('dragon-marcos');
    const tagline = resolveTagline(b);
    expect(tagline).toBe('Marcos · 6 años');
  });

  it('throws a clear error when slug does not exist', () => {
    expect(() => adapter.loadBundle('does-not-exist')).toThrowError(/metadata not found/);
  });
});

describe('AudioKidsAdapter.listCandidates', () => {
  const adapter = new AudioKidsAdapter(FIXTURE_DIR);

  it('lists every story with a matching .json + .mp3 pair', () => {
    const candidates = adapter.listCandidates();
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    const marcos = candidates.find(c => c.slug === 'dragon-marcos');
    expect(marcos).toBeDefined();
    expect(typeof marcos!.mtimeMs).toBe('number');
  });
});

describe('resolveTagline', () => {
  it('returns undefined when no recipient and no explicit tagline', () => {
    const b = {
      id: 't', kind: 'text' as const, text: { body: 'x' }, locale: 'es',
    };
    expect(resolveTagline(b as never)).toBeUndefined();
  });

  it('returns explicit tagline verbatim when present', () => {
    const b = {
      id: 't', kind: 'text' as const, text: { body: 'x', tagline: 'custom' }, locale: 'es',
    };
    expect(resolveTagline(b as never)).toBe('custom');
  });

  it('respects anonymous consent by hiding the name', () => {
    const b = {
      id: 't', kind: 'text' as const, text: { body: 'x' }, locale: 'es',
      recipient: { name: 'Ana', age: 5, shareConsent: 'anonymous' as const },
    };
    expect(resolveTagline(b as never)).toBe('para un niño de 5 años');
  });

  it('uses first name only when consent is first-name-only', () => {
    const b = {
      id: 't', kind: 'text' as const, text: { body: 'x' }, locale: 'es',
      recipient: { name: 'Ana María García', age: 7, shareConsent: 'first-name-only' as const },
    };
    expect(resolveTagline(b as never)).toBe('Ana · 7 años');
  });
});
