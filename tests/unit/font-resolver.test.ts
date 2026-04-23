import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveFontLinks } from '../../hyperframes/templates/common.mjs';
import { slugifyFamily as scriptsSlugify } from '../../scripts/lib/fonts.mjs';

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'font-resolver-'));
});

afterEach(() => {
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* noop */ }
});

/** Emit a pre-cached local css file at the conventional path for a given family slug. */
function cacheFontCss(root: string, slug: string): string {
  const dir = join(root, slug);
  mkdirSync(dir, { recursive: true });
  const cssPath = join(dir, `${slug}.css`);
  writeFileSync(cssPath, `/* cached */ @font-face { font-family: '${slug}'; src: url(./x.woff2) format('woff2'); }`);
  return cssPath;
}

describe('resolveFontLinks', () => {
  it('returns remote URLs when no local cache exists', () => {
    const fp = {
      display: { family: 'Fraunces', url: 'https://fonts.googleapis.com/css2?family=Fraunces' },
      body:    { family: 'Inter',    url: 'https://fonts.googleapis.com/css2?family=Inter' },
    };
    const links = resolveFontLinks(fp, { localRoot: scratch });
    expect(links).toEqual([
      'https://fonts.googleapis.com/css2?family=Fraunces',
      'https://fonts.googleapis.com/css2?family=Inter',
    ]);
  });

  it('prefers local CSS paths when they exist on disk', () => {
    cacheFontCss(scratch, 'fraunces');
    cacheFontCss(scratch, 'inter');
    const fp = {
      display: { family: 'Fraunces', url: 'https://fonts.googleapis.com/css2?family=Fraunces' },
      body:    { family: 'Inter',    url: 'https://fonts.googleapis.com/css2?family=Inter' },
    };
    const links = resolveFontLinks(fp, { localRoot: scratch, publicPrefix: 'assets/fonts' });
    expect(links).toEqual([
      'assets/fonts/fraunces/fraunces.css',
      'assets/fonts/inter/inter.css',
    ]);
  });

  it('mixes local and remote when only some faces are cached', () => {
    cacheFontCss(scratch, 'fraunces');
    const fp = {
      display: { family: 'Fraunces', url: 'https://fonts.googleapis.com/css2?family=Fraunces' },
      body:    { family: 'Inter',    url: 'https://fonts.googleapis.com/css2?family=Inter' },
    };
    const links = resolveFontLinks(fp, { localRoot: scratch, publicPrefix: 'assets/fonts' });
    expect(links[0]).toBe('assets/fonts/fraunces/fraunces.css');
    expect(links[1]).toBe('https://fonts.googleapis.com/css2?family=Inter');
  });

  it('includes folio faces when present and deduplicates identical URLs', () => {
    cacheFontCss(scratch, 'jetbrains-mono');
    const fp = {
      display: { family: 'JetBrains Mono', url: 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700' },
      body:    { family: 'JetBrains Mono', url: 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500' },
      folio:   { family: 'Space Mono',     url: 'https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700' },
    };
    const links = resolveFontLinks(fp, { localRoot: scratch, publicPrefix: 'assets/fonts' });
    // JetBrains Mono resolves to one local CSS and should appear only once; Space Mono stays remote.
    expect(links.filter(l => l === 'assets/fonts/jetbrains-mono/jetbrains-mono.css')).toHaveLength(1);
    expect(links).toContain('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700');
  });

  it('handles fontPairing with a missing body gracefully', () => {
    const fp = {
      display: { family: 'Fraunces', url: 'https://fonts.googleapis.com/css2?family=Fraunces' },
    };
    const links = resolveFontLinks(fp, { localRoot: scratch });
    expect(links).toEqual(['https://fonts.googleapis.com/css2?family=Fraunces']);
  });

  // Guard the intentional duplication: the template's inline slugifier and the
  // scripts/lib one must agree on every family in fonts.json so the resolver
  // finds files the fetcher actually wrote. If they drift the local cache
  // silently falls back to the CDN URL and renders re-acquire network deps.
  it('template and scripts slugifiers agree on every production family', () => {
    // Sample the tricky shapes from hyperframes/themes/fonts.json.
    const families = [
      'Fraunces', 'Inter', 'Playfair Display', 'Cormorant Garamond',
      'Baloo 2', 'Nunito', 'Caveat', 'Patrick Hand', 'Quicksand',
      'UnifrakturMaguntia', 'MedievalSharp', 'Lora', 'Cinzel', 'Lato',
      'Tangerine', 'JetBrains Mono', 'Space Mono',
    ];
    for (const family of families) {
      const fp = {
        display: { family, url: `https://fonts.googleapis.com/css2?family=${family.replace(/\s+/g, '+')}` },
      };
      const expectedSlug = scriptsSlugify(family);
      // Seed the cache with the slug the scripts/ side would produce, then
      // verify the template-side resolver finds it.
      cacheFontCss(scratch, expectedSlug);
      const links = resolveFontLinks(fp, { localRoot: scratch, publicPrefix: 'assets/fonts' });
      expect(links[0]).toBe(`assets/fonts/${expectedSlug}/${expectedSlug}.css`);
    }
  });
});
