/**
 * Story slugs are used to build file paths and URLs. A malicious slug could
 * traverse out of the intended directory (`../../../etc/passwd`) or inject
 * characters that break downstream tooling. We accept only a conservative
 * lowercase-with-hyphens format that matches what AudioKids actually emits.
 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

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
  if (slug.length > 80) throw new InvalidSlugError(slug, 'too long (max 80 characters)');
  if (!SLUG_RE.test(slug)) {
    throw new InvalidSlugError(
      slug,
      'must match /^[a-z0-9][a-z0-9-]{0,79}$/ (lowercase alphanumerics and hyphens, cannot start with a hyphen)',
    );
  }
  return slug;
}
