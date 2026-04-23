/**
 * Pure helpers for the font-fetcher script. Kept side-effect free so they can
 * be unit tested without touching the network or disk. The fetch/download/write
 * orchestration lives in scripts/fetch-fonts.ts and composes these primitives.
 */

/**
 * Convert a Google-Fonts family name into a filesystem-safe slug used both as
 * the cache directory name and the CSS filename. We keep digits, lowercase
 * Latin letters, and hyphens; whitespace collapses to a single hyphen.
 */
export function slugifyFamily(family) {
  if (typeof family !== 'string' || family.length === 0) {
    throw new Error('slugifyFamily requires a non-empty string');
  }
  return family
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

/**
 * Parse @font-face blocks from a CSS payload. Google Fonts css2 responses are
 * machine-generated and follow a narrow shape: every block declares
 * font-family, font-style, font-weight, and a single woff2 src url. A simple
 * regex pass is sufficient and far cheaper than pulling a full CSS parser.
 */
export function parseFontFaces(css) {
  if (typeof css !== 'string' || css.length === 0) return [];
  const blocks = css.match(/@font-face\s*\{[^}]*\}/g);
  if (!blocks) return [];
  const faces = [];
  for (const block of blocks) {
    const family = matchFirst(block, /font-family:\s*['"]?([^;'"]+)['"]?\s*;/);
    const style = matchFirst(block, /font-style:\s*([^;\s]+)\s*;/);
    const weight = matchFirst(block, /font-weight:\s*([^;\s]+)\s*;/);
    // Only woff2 is kept; ttf/otf are legacy formats we do not serve locally.
    const url = matchFirst(block, /src:\s*url\(([^)]+\.woff2)\)\s*format\(['"]woff2['"]\)/);
    if (!family || !url) continue;
    faces.push({
      family: family.trim(),
      style: (style ?? 'normal').trim(),
      weight: (weight ?? '400').trim(),
      url: url.trim(),
    });
  }
  return faces;
}

/**
 * Rewrite @font-face src urls from their remote gstatic form to the given
 * local paths. urlMap keys are the original remote urls; values are the local
 * replacement (typically a relative path next to the rewritten CSS).
 */
export function rewriteCssUrls(css, urlMap) {
  if (typeof css !== 'string') return '';
  if (!urlMap || urlMap.size === 0) return css;
  let out = css;
  for (const [from, to] of urlMap.entries()) {
    // Escape regex specials in the url; dots and slashes are the common ones.
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'g'), to);
  }
  return out;
}

function matchFirst(source, re) {
  const m = source.match(re);
  return m ? m[1] : undefined;
}
