import { describe, expect, it } from 'vitest';
import { normalizePublishResult, publicationOutcome, requiresPublicationReconciliation } from '../../src/publication-state.js';
import { findPublicationHold } from '../../src/idempotency.js';

// Explicit malformed legacy-log fixture, not a provider response or delivery proof.
function legacy() {
  return JSON.parse(JSON.stringify({
    id: 'fixture', contentSlug: 'fixture', platform: 'tiktok', action: 'publish.tiktok',
    reason: 'unit fixture', createdAt: '2026-01-01T00:00:00.000Z',
    result: { platform: 'tiktok', success: true, url: 42, timestamp: '2026-01-01T00:00:00.000Z' },
  }));
}

describe('runtime publication facts from legacy JSON', () => {
  it('normalizes malformed multipart results without dropping known references', () => {
    for (const parts of [[{ platform: 'tiktok', postId: 'fixture-part' }, null], {}, 'invalid', 42, null]) {
      const entry = legacy();
      delete entry.result.url;
      entry.result.postId = 'fixture-root';
      entry.result.parts = parts;
      const normalized = normalizePublishResult(entry.result);
      expect(normalized.outcome).toBe('incomplete');
      expect(normalized.success).toBe(false);
      expect(normalized.postId).toBe('fixture-root');
      expect(normalized.parts).toEqual(parts);
    }
  });
  it('holds malformed multipart facts instead of throwing or confirming success', () => {
    for (const parts of [[null], {}, 'invalid', 42, null]) {
      const entry = legacy();
      delete entry.result.url;
      entry.result.parts = parts;
      expect(publicationOutcome(entry.result)).toBe('incomplete');
      expect(requiresPublicationReconciliation(entry)).toBe(true);
      expect(findPublicationHold([entry], 'fixture', 'tiktok')).toBe(entry);
    }
  });
  it('does not treat a string false preview flag as a safe preview', () => {
    const entry = legacy();
    entry.result.url = 'https://example.invalid/fixture';
    entry.result.preview = 'false';
    expect(publicationOutcome(entry.result)).toBe('unknown');
    expect(requiresPublicationReconciliation(entry)).toBe(true);
    expect(findPublicationHold([entry], 'fixture', 'tiktok')).toBe(entry);
  });
  it('holds a non-string remote reference without crashing the selectors', () => {
    const entry = legacy();
    expect(publicationOutcome(entry.result)).toBe('unknown');
    expect(requiresPublicationReconciliation(entry)).toBe(true);
    expect(findPublicationHold([entry], 'fixture', 'tiktok')).toBe(entry);
  });
});
