/**
 * Shared helpers for every mood template.
 * Templates consume normalized transcripts + story metadata and emit HTML.
 */
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HEAD_SEC = 2;
export const TAIL_SEC = 1.5;

/**
 * Default root where fetch-fonts.ts caches downloaded Google Fonts. We resolve
 * it from this file's location so the resolver works both inside an isolated
 * render workspace (where hyperframes/templates lives under <workspace>/templates)
 * and from the repo root during tests or gallery runs.
 */
const TEMPLATES_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOCAL_ROOT = resolve(TEMPLATES_DIR, '..', 'assets', 'fonts');

/**
 * Slugify a Google Fonts family name using the same algorithm as the
 * fetch-fonts script. Kept inline (rather than imported from scripts/) so the
 * template has no dependency on the scripts/ workspace, which is NOT copied
 * into render workspaces.
 */
function slugifyFamily(family) {
  return String(family)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

/**
 * Build the ordered list of <link href> values the editorial template needs.
 * For every face (display, body, optional folio) prefer the cached local CSS
 * at `<localRoot>/<slug>/<slug>.css` when it exists, falling back to the
 * remote Google Fonts URL otherwise. De-duplicates identical resolved values
 * so identical faces (e.g. same JetBrains Mono for display + body) emit one
 * <link> tag.
 */
export function resolveFontLinks(fp, opts = {}) {
  if (!fp) return [];
  const localRoot = opts.localRoot ?? DEFAULT_LOCAL_ROOT;
  const publicPrefix = opts.publicPrefix ?? 'assets/fonts';
  const faces = [fp.display, fp.body, fp.folio].filter(Boolean);
  const out = [];
  for (const face of faces) {
    if (!face?.family || !face?.url) continue;
    const slug = slugifyFamily(face.family);
    const localCss = join(localRoot, slug, `${slug}.css`);
    const link = existsSync(localCss)
      ? `${publicPrefix}/${slug}/${slug}.css`
      : face.url;
    if (!out.includes(link)) out.push(link);
  }
  return out;
}

/** Group whisper word-level entries into book-page-sized slides. */
export function buildPages(words, opts = {}) {
  const targetWords = opts.targetWordsPerPage ?? 18;
  const maxWords = opts.maxWordsPerPage ?? 28;
  const minBeforeBreak = opts.minWordsBeforeBreak ?? 8;

  const pages = [];
  let cur = [];
  let pageStart = 0;

  const flush = () => {
    if (!cur.length) return;
    pages.push({ startSec: pageStart, endSec: cur.at(-1).end, tokens: cur });
    cur = [];
  };

  for (const w of words) {
    if (!cur.length) { pageStart = w.start; cur.push(w); continue; }
    cur.push(w);
    const endsSentence = /[.!?…]$/.test(w.text);
    const pastTarget = cur.length >= targetWords;
    const hardCap = cur.length >= maxWords;
    if (endsSentence && pastTarget) flush();
    else if (hardCap) flush();
  }

  if (cur.length) {
    if (cur.length < minBeforeBreak && pages.length) {
      pages.at(-1).tokens.push(...cur);
      pages.at(-1).endSec = cur.at(-1).end;
    } else {
      flush();
    }
  }
  return pages;
}

export function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Emit GSAP `set` calls that recolour each word on its timeline moment:
 *   at word.start: word becomes active (activeColor)
 *   at word.end:   word becomes past (pastColor)
 * All default initial state is mutedColor (future tense), set via CSS.
 */
export function emitWordColorTimeline(pages, { activeColor, pastColor, headSec = HEAD_SEC }) {
  const lines = [];
  pages.forEach((p, pi) => {
    p.tokens.forEach((t, wi) => {
      const selector = `#page-${pi} [data-word='${wi}']`;
      const startAbs = (headSec + t.start).toFixed(3);
      const endAbs = (headSec + t.end).toFixed(3);
      lines.push(`  tl.set("${selector}", { color: "${activeColor}" }, ${startAbs});`);
      lines.push(`  tl.set("${selector}", { color: "${pastColor}" }, ${endAbs});`);
    });
  });
  return lines.join('\n');
}

/**
 * Return a small HTML ribbon string like `PARTE 1 / 3` when the payload is a
 * multi-part publish. Returns an empty string for single-part payloads so
 * callers can inline it unconditionally.
 */
export function renderPartRibbon(payload) {
  if (!payload?.partIndex || !payload?.partTotal || payload.partTotal <= 1) return '';
  const idx = Number(payload.partIndex);
  const total = Number(payload.partTotal);
  return `<div class="part-ribbon">PARTE ${idx} / ${total}</div>`;
}

export function renderCornerOrnaments({ accent, size = 180 }) {
  const svg = (cls) => `<div class="corner-ornament ${cls}" style="width:${size}px;height:${size}px;">`
    + `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">`
    + `<g fill="none" stroke="${accent}" stroke-width="1.6" stroke-linecap="round" opacity="0.65">`
    + `<path d="M 6 6 L 6 44"/>`
    + `<path d="M 6 6 L 44 6"/>`
    + `<path d="M 6 22 C 18 22, 22 18, 22 6"/>`
    + `<path d="M 10 10 C 28 12, 40 22, 42 42"/>`
    + `<path d="M 14 6 C 16 12, 20 14, 26 14"/>`
    + `<path d="M 6 14 C 12 16, 14 20, 14 26"/>`
    + `<circle cx="22" cy="22" r="2.2" fill="${accent}" stroke="none"/>`
    + `<circle cx="34" cy="10" r="1.4" fill="${accent}" stroke="none"/>`
    + `<circle cx="10" cy="34" r="1.4" fill="${accent}" stroke="none"/>`
    + `</g></svg></div>`;
  return [
    svg('corner-ornament-tl'),
    svg('corner-ornament-tr'),
    svg('corner-ornament-bl'),
    svg('corner-ornament-br'),
  ].join('');
}

export function renderScrollBorders({ accent, width, height: _height }) {
  const patternId = 'laurel-pattern';
  const bandHeight = 72;
  const pattern = `<svg class="scroll-border-svg" viewBox="0 0 ${width} ${bandHeight}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">`
    + `<defs>`
    + `<pattern id="${patternId}" x="0" y="0" width="120" height="${bandHeight}" patternUnits="userSpaceOnUse">`
    + `<g fill="none" stroke="${accent}" stroke-width="1.5" stroke-linecap="round" opacity="0.7">`
    + `<path d="M 0 36 L 120 36"/>`
    + `<path d="M 10 36 C 18 20, 34 20, 42 36"/>`
    + `<path d="M 42 36 C 50 52, 66 52, 74 36"/>`
    + `<path d="M 74 36 C 82 20, 98 20, 106 36"/>`
    + `<circle cx="10" cy="36" r="2.4" fill="${accent}" stroke="none"/>`
    + `<circle cx="42" cy="36" r="2.4" fill="${accent}" stroke="none"/>`
    + `<circle cx="74" cy="36" r="2.4" fill="${accent}" stroke="none"/>`
    + `<circle cx="106" cy="36" r="2.4" fill="${accent}" stroke="none"/>`
    + `<path d="M 26 28 L 26 44"/>`
    + `<path d="M 58 28 L 58 44"/>`
    + `<path d="M 90 28 L 90 44"/>`
    + `</g>`
    + `</pattern>`
    + `</defs>`
    + `<rect x="0" y="0" width="${width}" height="${bandHeight}" fill="url(#${patternId})"/>`
    + `</svg>`;
  const top = `<div class="scroll-border scroll-border-top" style="height:${bandHeight}px;">${pattern}</div>`;
  const bottom = `<div class="scroll-border scroll-border-bottom" style="height:${bandHeight}px;">${pattern}</div>`;
  return top + bottom;
}

export function renderEndCard({ treatment, startSec, durationSec = TAIL_SEC }) {
  const startAbs = Number(startSec).toFixed(3);
  const dur = Number(durationSec).toFixed(3);
  const base = `class="clip end-card" data-start="${startAbs}" data-duration="${dur}" data-track-index="3"`;
  switch (treatment) {
    case 'medieval-manuscript':
      return `<div ${base.replace('end-card', 'end-card end-card-medieval')}>`
        + `<span class="end-card-ornament" aria-hidden="true">&#9819;</span>`
        + `<span class="end-card-text">fin</span>`
        + `<span class="end-card-ornament" aria-hidden="true">&#9819;</span>`
        + `</div>`;
    case 'mythic-scroll':
      return `<div ${base.replace('end-card', 'end-card end-card-mythic')}>`
        + `<span class="end-card-text">·fin·</span>`
        + `</div>`;
    case 'storybook-pop':
      return `<div ${base.replace('end-card', 'end-card end-card-storybook')}>`
        + `<span class="end-card-text">&iexcl;y colorín colorado!</span>`
        + `</div>`;
    case 'crayon-doodle':
      return `<div ${base.replace('end-card', 'end-card end-card-doodle')}>`
        + `<span class="end-card-text">~ fin ~</span>`
        + `</div>`;
    case 'bubble-pastel':
      return `<div ${base.replace('end-card', 'end-card end-card-bubble')}>`
        + `<span class="end-card-text">buenas noches</span>`
        + `<span class="end-card-heart" aria-hidden="true">&#9825;</span>`
        + `</div>`;
    case 'terminal-crt':
      return `<div ${base.replace('end-card', 'end-card end-card-terminal')}>`
        + `<span class="prompt">&gt; </span>`
        + `<span class="end-card-text">EOF</span>`
        + `<span class="terminal-cursor"></span>`
        + `</div>`;
    case 'epic-cinematic':
      return `<div ${base.replace('end-card', 'end-card end-card-cinema')}>`
        + `<span class="end-card-text">FIN</span>`
        + `</div>`;
    case 'midnight':
      return `<div ${base.replace('end-card', 'end-card end-card-midnight')}>`
        + `<span class="end-card-text">dulces sueños</span>`
        + `</div>`;
    case 'rose-stamp':
      return `<div ${base.replace('end-card', 'end-card end-card-rose')}>`
        + `<span class="end-card-text">con cariño</span>`
        + `</div>`;
    default:
      return `<div ${base.replace('end-card', 'end-card end-card-default')}>`
        + `<span class="end-card-text">audiokids · cuentos a medida</span>`
        + `</div>`;
  }
}

/** Read story payload from stdin as a single JSON blob. */
export async function readStoryFromStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}
