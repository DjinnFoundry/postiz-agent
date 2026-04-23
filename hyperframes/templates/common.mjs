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

/** Read story payload from stdin as a single JSON blob. */
export async function readStoryFromStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}
