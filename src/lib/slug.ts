/**
 * Story slugs are used to build file paths and URLs. A malicious slug could
 * traverse out of the intended directory (`../../../etc/passwd`) or inject
 * characters that break downstream tooling. We accept ASCII alphanumerics +
 * hyphen only — no slashes, dots, whitespace, or unicode. Uppercase is allowed
 * because AudioKids v2 slugs embed an ISO timestamp (`-2026-04-26T15-34-00-123Z`)
 * which contains capital `T`/`Z`. Length is capped at 128 to absorb timestamped
 * slugs comfortably while still bounding risk.
 */
const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$/;
const MAX_SLUG_LEN = 128;

export class InvalidSlugError extends Error {
  constructor(slug: string, reason: string) {
    super(`Invalid slug "${slug}": ${reason}`);
    this.name = 'InvalidSlugError';
  }
}

/**
 * Returns the slug if it is safe to use in file paths; throws otherwise.
 * Call this at every CLI entry that accepts a user-provided slug.
 */
export function validateSlug(slug: string): string {
  if (slug === undefined || slug === null) throw new InvalidSlugError(String(slug), 'missing');
  if (typeof slug !== 'string') throw new InvalidSlugError(String(slug), 'must be a string');
  if (slug.length === 0) throw new InvalidSlugError(slug, 'cannot be empty');
  if (slug.length > MAX_SLUG_LEN) throw new InvalidSlugError(slug, `too long (max ${MAX_SLUG_LEN} characters)`);
  if (!SLUG_RE.test(slug)) {
    throw new InvalidSlugError(
      slug,
      'must match /^[a-zA-Z0-9][a-zA-Z0-9-]+$/ (ASCII alphanumerics and hyphens, cannot start with a hyphen)',
    );
  }
  return slug;
}
