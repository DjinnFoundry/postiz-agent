/**
 * Shared helpers for every mood template.
 * Templates consume normalized transcripts + story metadata and emit HTML.
 */

export const HEAD_SEC = 2;
export const TAIL_SEC = 1.5;

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
