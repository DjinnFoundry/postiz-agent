import { describe, expect, it } from 'vitest';
import { validateSlug, InvalidSlugError } from '../../src/lib/slug.js';

describe('validateSlug', () => {
  it('accepts a realistic slug', () => {
    expect(validateSlug('dragon-marcos')).toBe('dragon-marcos');
  });

  it('accepts a single lowercase character', () => {
    expect(validateSlug('a')).toBe('a');
  });

  it('accepts digits and hyphens mixed', () => {
    expect(validateSlug('story-42-take-2')).toBe('story-42-take-2');
  });

  it('rejects empty string', () => {
    expect(() => validateSlug('')).toThrow(InvalidSlugError);
  });

  it('rejects slug that starts with a hyphen', () => {
    expect(() => validateSlug('-foo')).toThrow(/must match/);
  });

  it('rejects slugs with path traversal', () => {
    expect(() => validateSlug('../../etc/passwd')).toThrow(InvalidSlugError);
  });

  it('rejects slugs with forward slashes', () => {
    expect(() => validateSlug('foo/bar')).toThrow(InvalidSlugError);
  });

  it('rejects slugs with dots', () => {
    expect(() => validateSlug('foo.bar')).toThrow(InvalidSlugError);
  });

  it('rejects slugs longer than 128 characters', () => {
    const long = 'a' + 'b'.repeat(128);
    expect(() => validateSlug(long)).toThrow(/too long/);
  });

  it('accepts uppercase letters (AudioKids v2 slugs embed an ISO timestamp with T and Z)', () => {
    expect(validateSlug('mati-museo-estrellas-2026-04-26T15-34-00-123Z')).toBe(
      'mati-museo-estrellas-2026-04-26T15-34-00-123Z',
    );
    expect(validateSlug('Dragon-Marcos')).toBe('Dragon-Marcos');
  });

  it('rejects unicode characters', () => {
    expect(() => validateSlug('dragón-marcos')).toThrow(InvalidSlugError);
  });

  it('rejects whitespace', () => {
    expect(() => validateSlug('dragon marcos')).toThrow(InvalidSlugError);
  });

  it('rejects null', () => {
    expect(() => validateSlug(null as unknown as string)).toThrow(InvalidSlugError);
  });

  it('rejects undefined', () => {
    expect(() => validateSlug(undefined as unknown as string)).toThrow(InvalidSlugError);
  });
});
