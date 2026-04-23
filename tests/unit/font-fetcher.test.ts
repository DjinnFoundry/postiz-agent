import { describe, expect, it } from 'vitest';
import {
  slugifyFamily,
  parseFontFaces,
  rewriteCssUrls,
} from '../../scripts/lib/fonts.mjs';

describe('slugifyFamily', () => {
  it('lowercases single-word families', () => {
    expect(slugifyFamily('Fraunces')).toBe('fraunces');
  });

  it('converts spaces to hyphens', () => {
    expect(slugifyFamily('JetBrains Mono')).toBe('jetbrains-mono');
    expect(slugifyFamily('Playfair Display')).toBe('playfair-display');
    expect(slugifyFamily('Cormorant Garamond')).toBe('cormorant-garamond');
  });

  it('handles PascalCase compound names without splitting them', () => {
    // The family is literally "UnifrakturMaguntia" in Google Fonts; we keep it as one slug token.
    expect(slugifyFamily('UnifrakturMaguntia')).toBe('unifrakturmaguntia');
    expect(slugifyFamily('MedievalSharp')).toBe('medievalsharp');
  });

  it('strips digits-suffix spacing (e.g. "Baloo 2")', () => {
    expect(slugifyFamily('Baloo 2')).toBe('baloo-2');
  });

  it('collapses multiple whitespace characters', () => {
    expect(slugifyFamily('Space   Mono')).toBe('space-mono');
  });

  it('rejects empty or nullish input', () => {
    expect(() => slugifyFamily('')).toThrow();
    expect(() => slugifyFamily(null as unknown as string)).toThrow();
  });
});

describe('parseFontFaces', () => {
  const fixture = `
/* latin */
@font-face {
  font-family: 'Fraunces';
  font-style: normal;
  font-weight: 400;
  src: url(https://fonts.gstatic.com/s/fraunces/v32/abc-400.woff2) format('woff2');
  unicode-range: U+0000-00FF, U+0131;
}
@font-face {
  font-family: 'Fraunces';
  font-style: normal;
  font-weight: 700;
  src: url(https://fonts.gstatic.com/s/fraunces/v32/abc-700.woff2) format('woff2');
}
@font-face {
  font-family: 'Fraunces';
  font-style: italic;
  font-weight: 400;
  src: url(https://fonts.gstatic.com/s/fraunces/v32/abc-it.woff2) format('woff2');
}
`;

  it('extracts every @font-face block', () => {
    const faces = parseFontFaces(fixture);
    expect(faces).toHaveLength(3);
  });

  it('extracts family, weight, style, and url correctly', () => {
    const faces = parseFontFaces(fixture);
    expect(faces[0]).toMatchObject({
      family: 'Fraunces',
      weight: '400',
      style: 'normal',
      url: 'https://fonts.gstatic.com/s/fraunces/v32/abc-400.woff2',
    });
    expect(faces[1].weight).toBe('700');
    expect(faces[2].style).toBe('italic');
  });

  it('ignores @font-face blocks whose src is not a woff2 url', () => {
    const mixed = `
@font-face {
  font-family: 'Old';
  font-weight: 400;
  src: url(https://example.com/old.ttf) format('truetype');
}
@font-face {
  font-family: 'Good';
  font-weight: 400;
  src: url(https://fonts.gstatic.com/s/good/v1/abc.woff2) format('woff2');
}
`;
    const faces = parseFontFaces(mixed);
    expect(faces).toHaveLength(1);
    expect(faces[0].family).toBe('Good');
  });

  it('returns an empty array for empty or unrelated CSS', () => {
    expect(parseFontFaces('')).toEqual([]);
    expect(parseFontFaces('body { color: red; }')).toEqual([]);
  });
});

describe('rewriteCssUrls', () => {
  it('replaces remote woff2 urls with the provided local paths', () => {
    const css = `
@font-face {
  font-family: 'X';
  font-weight: 400;
  src: url(https://fonts.gstatic.com/s/x/abc-400.woff2) format('woff2');
}
@font-face {
  font-family: 'X';
  font-weight: 700;
  src: url(https://fonts.gstatic.com/s/x/abc-700.woff2) format('woff2');
}
`;
    const urlMap = new Map([
      ['https://fonts.gstatic.com/s/x/abc-400.woff2', './abc-400.woff2'],
      ['https://fonts.gstatic.com/s/x/abc-700.woff2', './abc-700.woff2'],
    ]);
    const out = rewriteCssUrls(css, urlMap);
    expect(out).toContain('url(./abc-400.woff2)');
    expect(out).toContain('url(./abc-700.woff2)');
    expect(out).not.toContain('fonts.gstatic.com');
  });

  it('leaves urls untouched when no entry in the map matches', () => {
    const css = `src: url(https://fonts.gstatic.com/s/other.woff2) format('woff2');`;
    const urlMap = new Map([['https://fonts.gstatic.com/s/x.woff2', './x.woff2']]);
    const out = rewriteCssUrls(css, urlMap);
    expect(out).toContain('fonts.gstatic.com/s/other.woff2');
  });
});
