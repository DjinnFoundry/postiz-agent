import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  buildCaption,
  buildCaptionRich,
  extractTeaser,
} from '../../src/copy/caption-builder.js';
import type {
  ContentBundle,
  Recipient,
  RecipientShareConsent,
} from '../../src/core/content-bundle.js';
import type { Platform } from '../../src/types.js';

fc.configureGlobal({ numRuns: 50 });

const shareConsentArb = fc.constantFrom<RecipientShareConsent>(
  'public',
  'first-name-only',
  'anonymous',
);

const localeArb = fc.constantFrom('es', 'en', 'es-ES', 'en-US', 'fr-FR');
const platformArb = fc.constantFrom<Platform>(
  'x',
  'tiktok',
  'instagram',
  'youtube',
  'spotify',
);

const nameArb = fc
  .stringMatching(/^[\p{L}][\p{L}\p{M} '\-]{0,39}$/u)
  .filter((s) => s.trim().length > 0 && /[\p{L}]/u.test(s));

const recipientArb = fc.record({
  name: nameArb,
  age: fc.option(fc.integer({ min: 0, max: 18 }), { nil: undefined }),
  interests: fc.option(
    fc.array(fc.string({ minLength: 1, maxLength: 20 }), { maxLength: 3 }),
    { nil: undefined },
  ),
  shareConsent: shareConsentArb,
}) as fc.Arbitrary<Recipient>;

const bundleArb: fc.Arbitrary<ContentBundle> = fc.record({
  id: fc
    .string({ minLength: 1, maxLength: 30 })
    .filter((s) => s.trim().length > 0),
  kind: fc.constant('audio-story' as const),
  text: fc.record({
    title: fc.option(fc.string({ minLength: 1, maxLength: 120 }), {
      nil: undefined,
    }),
    body: fc.string({ minLength: 1, maxLength: 800 }),
  }),
  locale: localeArb,
  theme: fc.option(
    fc.record({
      mood: fc.option(fc.string({ minLength: 1, maxLength: 30 }), {
        nil: undefined,
      }),
    }),
    { nil: undefined },
  ),
  recipient: fc.option(recipientArb, { nil: undefined }),
}) as fc.Arbitrary<ContentBundle>;

const LENGTH_CAP: Record<Platform, number> = {
  x: 280,
  tiktok: 2200,
  instagram: 2200,
  youtube: 5000,
  spotify: 0,
};

function wordsOf(s: string): string[] {
  return s.split(/\s+/).filter(Boolean);
}

describe('property: extractTeaser', () => {
  it('never exceeds cap by more than 2 chars (ellipsis slack)', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 1000 }),
        fc.integer({ min: 20, max: 500 }),
        (body, maxChars) => {
          const out = extractTeaser(body, { maxChars });
          expect(out.length).toBeLessThanOrEqual(maxChars + 2);
        },
      ),
    );
  });

  it('is deterministic (same input -> same output)', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 1000 }),
        fc.integer({ min: 20, max: 500 }),
        (body, maxChars) => {
          const a = extractTeaser(body, { maxChars });
          const b = extractTeaser(body, { maxChars });
          expect(a).toBe(b);
        },
      ),
    );
  });

  it('never leaves a trailing whitespace and the hard-cut path closes with an ellipsis on a word end', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 1000 }),
        fc.integer({ min: 20, max: 500 }),
        (body, maxChars) => {
          const out = extractTeaser(body, { maxChars });
          if (!out) return;
          expect(out.endsWith(' ')).toBe(false);
          if (out.endsWith('…')) {
            const pre = out.slice(0, -1);
            if (pre.length > 0) {
              expect(pre.endsWith(' ')).toBe(false);
            }
            const stripped = pre.trim();
            if (stripped.length > 0) {
              const lastWord = wordsOf(stripped).pop()!;
              const cleaned = lastWord.replace(/[.!?…]+$/u, '');
              if (/[\p{L}\p{N}]/u.test(cleaned[cleaned.length - 1] ?? '')) {
                expect(body).toContain(cleaned);
              }
            }
          }
        },
      ),
    );
  });

  it('returns empty string when body is empty', () => {
    expect(extractTeaser('')).toBe('');
    expect(extractTeaser('', { maxChars: 100 })).toBe('');
  });
});

function redactViaTeaser(input: string, recipient: Recipient | undefined): string {
  const bundle: ContentBundle = {
    id: 'probe',
    kind: 'audio-story',
    text: { title: 'Probe', body: 'Dummy body.' },
    locale: 'es',
    recipient,
  };
  return buildCaptionRich({
    bundle,
    platform: 'instagram',
    teaser: input,
  }).teaser;
}

describe('property: redactName (via buildCaptionRich.teaser)', () => {
  it('public and first-name-only consent do not alter the teaser (modulo trim)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim().length > 0),
        nameArb,
        fc.constantFrom<RecipientShareConsent>('public', 'first-name-only'),
        (text, name, consent) => {
          const recipient: Recipient = { name, shareConsent: consent };
          const out = redactViaTeaser(text, recipient);
          expect(out).toBe(text.trim());
        },
      ),
    );
  });

  it('anonymous consent: first token of recipient.name does not appear as whole word', () => {
    fc.assert(
      fc.property(
        nameArb,
        fc.string({ maxLength: 50 }),
        fc.string({ maxLength: 50 }),
        (name, prefix, suffix) => {
          const firstToken = name.trim().split(/\s+/).filter(Boolean)[0];
          if (!firstToken) return;
          const text = `${prefix} ${firstToken} ${suffix}`.trim();
          const recipient: Recipient = { name, shareConsent: 'anonymous' };
          const out = redactViaTeaser(text, recipient);
          const wordBoundary = new RegExp(
            `(?<![\\p{L}\\p{M}\\p{N}_])${firstToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{M}\\p{N}_])`,
            'iu',
          );
          expect(wordBoundary.test(out)).toBe(false);
        },
      ),
    );
  });

  it('does not crash on regex metacharacters or unicode in the name', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 200 }),
        fc.oneof(
          fc.constant('.*+?^${}()|[]\\'),
          fc.constant('a|b'),
          fc.constant('(?:test)'),
          fc.constant('María García'),
          fc.constant('Ñoño'),
          fc.constant('\u{1F600}'),
          fc.constant('Ana García'),
          nameArb,
        ),
        (text, name) => {
          const recipient: Recipient = { name, shareConsent: 'anonymous' };
          expect(() => redactViaTeaser(text, recipient)).not.toThrow();
        },
      ),
    );
  });

  it('is idempotent: redacting twice equals redacting once (anonymous)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim().length > 0),
        nameArb,
        (text, name) => {
          const recipient: Recipient = { name, shareConsent: 'anonymous' };
          const once = redactViaTeaser(text, recipient);
          const twice = redactViaTeaser(once, recipient);
          expect(twice).toBe(once);
        },
      ),
    );
  });
});

describe('property: buildCaption global invariants', () => {
  it('caption length <= LENGTH_CAP[platform] for any bundle', () => {
    fc.assert(
      fc.property(bundleArb, platformArb, (bundle, platform) => {
        const caption = buildCaption({ bundle, platform });
        expect(caption.length).toBeLessThanOrEqual(LENGTH_CAP[platform]);
      }),
    );
  });

  it('caption never contains the literal string "undefined"', () => {
    fc.assert(
      fc.property(bundleArb, platformArb, (bundle, platform) => {
        const caption = buildCaption({ bundle, platform });
        expect(caption.includes('undefined')).toBe(false);
      }),
    );
  });

  it('deterministic: same bundle + platform -> same caption', () => {
    fc.assert(
      fc.property(bundleArb, platformArb, (bundle, platform) => {
        const a = buildCaption({ bundle, platform });
        const b = buildCaption({ bundle, platform });
        expect(a).toBe(b);
      }),
    );
  });

  it('spotify always returns empty string', () => {
    fc.assert(
      fc.property(bundleArb, (bundle) => {
        expect(buildCaption({ bundle, platform: 'spotify' })).toBe('');
      }),
    );
  });

  it('anonymous consent: recipient first-name never leaks into the caption as a whole word', () => {
    fc.assert(
      fc.property(
        bundleArb,
        fc.constantFrom<Platform>('x', 'tiktok', 'instagram', 'youtube'),
        (bundle, platform) => {
          if (!bundle.recipient) return;
          const anonBundle: ContentBundle = {
            ...bundle,
            recipient: { ...bundle.recipient, shareConsent: 'anonymous' },
          };
          const firstToken = anonBundle
            .recipient!.name.trim()
            .split(/\s+/)
            .filter(Boolean)[0];
          if (!firstToken) return;
          const caption = buildCaption({ bundle: anonBundle, platform });
          const wordBoundary = new RegExp(
            `(?<![\\p{L}\\p{M}\\p{N}_])${firstToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{M}\\p{N}_])`,
            'iu',
          );
          expect(wordBoundary.test(caption)).toBe(false);
        },
      ),
    );
  });
});
