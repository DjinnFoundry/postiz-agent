import { describe, it, expect } from 'vitest';
import { AdapterRegistry, type BundleAdapter, type BundleCandidate } from '../../src/adapters/registry.js';
import type { ContentBundle } from '../../src/core/content-bundle.js';

function makeAdapter(name: string, candidates: BundleCandidate[] = []): BundleAdapter {
  const bundles = new Map<string, ContentBundle>(
    candidates.map(c => [c.id, {
      id: c.id,
      kind: 'audio-story',
      text: { title: c.id, body: 'body' },
      locale: 'es',
    } as ContentBundle]),
  );
  return {
    name,
    description: `test adapter ${name}`,
    loadBundle: (id: string) => {
      const b = bundles.get(id);
      if (!b) throw new Error(`unknown id ${id}`);
      return b;
    },
    listCandidates: () => candidates,
  };
}

describe('AdapterRegistry', () => {
  it('registers and retrieves adapters by name', () => {
    const reg = new AdapterRegistry();
    const a = makeAdapter('audiokids');
    reg.register(a);
    expect(reg.has('audiokids')).toBe(true);
    expect(reg.get('audiokids')).toBe(a);
  });

  it('rejects duplicate registrations', () => {
    const reg = new AdapterRegistry();
    reg.register(makeAdapter('audiokids'));
    expect(() => reg.register(makeAdapter('audiokids'))).toThrowError(/already registered/);
  });

  it('throws with helpful message when getting an unknown adapter', () => {
    const reg = new AdapterRegistry()
      .register(makeAdapter('audiokids'))
      .register(makeAdapter('zetaread'));
    expect(() => reg.get('missing')).toThrowError(/unknown adapter.*audiokids.*zetaread/);
  });

  it('list() returns descriptors with name + description + candidate count', () => {
    const reg = new AdapterRegistry()
      .register(makeAdapter('audiokids', [{ id: 'a', generatedAtMs: 1 }, { id: 'b', generatedAtMs: 2 }]))
      .register(makeAdapter('zetaread'));
    const list = reg.list();
    const audiokids = list.find(d => d.name === 'audiokids')!;
    const zetaread = list.find(d => d.name === 'zetaread')!;
    expect(audiokids.candidateCount).toBe(2);
    expect(zetaread.candidateCount).toBe(0);
    expect(audiokids.description).toMatch(/test adapter/);
  });

  it('names() returns sorted adapter names', () => {
    const reg = new AdapterRegistry()
      .register(makeAdapter('zetaread'))
      .register(makeAdapter('audiokids'));
    expect(reg.names()).toEqual(['audiokids', 'zetaread']);
  });

  it('loadBundle delegates to the named adapter', () => {
    const reg = new AdapterRegistry()
      .register(makeAdapter('audiokids', [{ id: 'dragon', generatedAtMs: 1 }]));
    const bundle = reg.get('audiokids').loadBundle('dragon');
    expect(bundle.id).toBe('dragon');
    expect(bundle.kind).toBe('audio-story');
  });
});

describe('AdapterRegistry: default registry contains audiokids', () => {
  it('createDefaultRegistry registers audiokids', async () => {
    const { createDefaultRegistry } = await import('../../src/adapters/registry.js');
    const reg = createDefaultRegistry();
    expect(reg.has('audiokids')).toBe(true);
    const audiokids = reg.get('audiokids');
    expect(audiokids.name).toBe('audiokids');
    expect(audiokids.description.length).toBeGreaterThan(10);
  });
});
