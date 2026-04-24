#!/usr/bin/env node
/**
 * Universal editorial template driven by a resolved theme (C.1 theme engine).
 * Input (via stdin, JSON):
 *   {
 *     title, byline, words, audioSrc, width, height,
 *     clipStartSec?, clipDurationSec?, partIndex?, partTotal?,
 *     theme: {
 *       treatment: { id, family, layoutHints?, palettes, fontPairing, description },
 *       palette: { id, bg, ink, accent, muted, highlight },
 *       fontPairing: { id, display: { family, weights, url }, body: {...}, folio?: {...} }
 *     }
 *   }
 *
 * Output: writes index.html to <cwd>. One template, twelve treatments. Each
 * treatment picks its own background, markup decorations, and word animation
 * flavour via the `layoutHints` block. Invariant: body text never renders below
 * the MIN_BODY_PX floor (checked before rendering so linter catches violations).
 */
import { writeFileSync } from 'node:fs';
import {
  HEAD_SEC, TAIL_SEC, buildPages, escHtml, emitWordColorTimeline,
  readStoryFromStdin, renderPartRibbon, resolveFontLinks,
  renderCornerOrnaments, renderScrollBorders, renderEndCard,
} from './common.mjs';

const MIN_BODY_PX = 32;
const MIN_BODY_PX_VERTICAL = 24;

const story = await readStoryFromStdin();
const { title, byline, words, audioSrc, width, height, theme } = story;

if (!theme?.treatment || !theme?.palette || !theme?.fontPairing) {
  throw new Error('editorial.mjs requires theme.{treatment, palette, fontPairing} in the payload');
}

const pal = theme.palette;
const fp = theme.fontPairing;
const hints = theme.treatment.layoutHints ?? {};
const pages = buildPages(words);
const audioDuration = words.at(-1).end;
const total = HEAD_SEC + audioDuration + TAIL_SEC;

// ─── Sizing ──────────────────────────────────────────────────────────────
const vertical = height > width;
const minBody = vertical ? MIN_BODY_PX_VERTICAL : MIN_BODY_PX;
const bodyPx = Math.max(minBody, vertical ? 52 : 64);
const titlePx = Math.max(bodyPx * 2, hints.titleSize ?? 140);

// ─── Per-treatment feature flags ─────────────────────────────────────────
const t = theme.treatment.id;
const isDark = hints.background === 'dark' || ['midnight', 'coal-ember', 'terminal-green', 'terminal-amber', 'terminal-cyan', 'cinema-amber', 'bronze-dusk', 'cold-steel', 'deep-ocean'].includes(pal.id);
const useDropCap = Boolean(hints.dropCap || hints.illuminatedCap);
const dropCapSize = hints.illuminatedCap?.size ?? hints.dropCap?.size ?? 0;
const useStamp = Boolean(hints.stamp);
const useLetterbox = Boolean(hints.letterbox);
const useScanLines = Boolean(hints.scanLines);
const useBubbles = Boolean(hints.bubbles);
const useCornerOrnaments = Boolean(hints.marginDecorations);
const useScrollBorders = Boolean(hints.scrollBorders);
const useMonoPrompt = Boolean(hints.prompt);
const textAlign = hints.textAlign ?? 'left';
const folioStyle = hints.showFolio ? (hints.folioStyle ?? 'classic') : 'none';

// ─── Word timeline colouring ─────────────────────────────────────────────
const gsapLines = emitWordColorTimeline(pages, {
  activeColor: pal.accent,
  pastColor: pal.ink,
});

// ─── Page blocks ─────────────────────────────────────────────────────────
const pageBlocks = pages.map((p, i) => {
  const startAbs = (HEAD_SEC + p.startSec).toFixed(3);
  const dur = ((i + 1 < pages.length ? pages[i + 1].startSec : p.endSec + 0.4) - p.startSec).toFixed(3);
  const wordSpans = p.tokens.map((tok, j) => {
    let rendered = escHtml(tok.text);
    // Drop cap only on the first word of the first page.
    if (useDropCap && i === 0 && j === 0) {
      const first = rendered[0];
      const rest = rendered.slice(1);
      rendered = `<span class="drop-cap">${first}</span>${rest}`;
    }
    const prefix = useMonoPrompt && j === 0 ? '<span class="prompt">&gt; </span>' : '';
    return `${prefix}<span class="w" data-word="${j}">${rendered}</span>`;
  }).join(' ');
  const trailingCursor = useMonoPrompt ? '<span class="terminal-cursor"></span>' : '';
  const folio = renderFolio(i + 1, folioStyle);
  return `    <div class="clip page" id="page-${i}" data-start="${startAbs}" data-duration="${dur}" data-track-index="2">
      ${folio}
      <p class="body">${wordSpans}${trailingCursor}</p>
    </div>`;
}).join('\n');

function renderFolio(n, style) {
  const padded = String(n).padStart(2, '0');
  switch (style) {
    case 'medieval': return `<div class="folio folio-medieval">capítulo ${padded}</div>`;
    case 'doodle':   return `<div class="folio folio-doodle">~ ${padded} ~</div>`;
    case 'ornate':   return `<div class="folio folio-ornate">§ ${padded} §</div>`;
    case 'bracket':  return `<div class="folio folio-bracket">[ PAGE ${padded} ]</div>`;
    case 'classic':  return `<div class="folio folio-classic">- ${padded} -</div>`;
    default: return '';
  }
}

// ─── Treatment-specific decorations ──────────────────────────────────────
const stampMarkup = useStamp ? renderStamp(hints.stamp) : '';
const letterboxMarkup = useLetterbox ? '<div class="letterbox-top"></div><div class="letterbox-bottom"></div>' : '';
const scanLinesMarkup = useScanLines ? '<div class="scanlines"></div>' : '';
const bubblesMarkup = useBubbles ? renderBubbles(pal) : '';
const cornerOrnamentsMarkup = useCornerOrnaments
  ? renderCornerOrnaments({ accent: pal.accent, size: vertical ? 220 : 200 })
  : '';
const scrollBordersMarkup = useScrollBorders
  ? renderScrollBorders({ accent: pal.accent, width, height })
  : '';

function renderStamp({ text, rotate }) {
  return `<div class="stamp${rotate ? ' stamp-rotate' : ''}"><svg viewBox="0 0 200 200"><defs><path id="circ" d="M 100 100 m -78 0 a 78 78 0 1 1 156 0 a 78 78 0 1 1 -156 0"/></defs><text><textPath href="#circ" startOffset="0">${escHtml(text)}</textPath></text></svg></div>`;
}
function renderBubbles() {
  const n = 8;
  return Array.from({ length: n }, (_, i) =>
    `<span class="bubble" style="--x:${(i * 127) % 100}%; --y:${(i * 89) % 100}%; --s:${120 + (i * 53) % 180}px; --d:${(i * 2) % 10}s"></span>`,
  ).join('');
}

// ─── CSS ─────────────────────────────────────────────────────────────────
// Prefer on-disk cached CSS (see scripts/fetch-fonts.ts) so renders do not
// block on Google Fonts network calls. Falls through to the remote CDN URL
// per face when the local cache is absent.
const fontLinks = resolveFontLinks(fp)
  .map(u => `  <link href="${u}" rel="stylesheet">`).join('\n');

const displayFamily = fp.display?.family ?? 'Fraunces';
const bodyFamily = fp.body?.family ?? 'Inter';
const folioFamily = fp.folio?.family ?? bodyFamily;

const css = `
* { margin: 0; padding: 0; box-sizing: border-box; }
:root {
  --bg: ${pal.bg};
  --ink: ${pal.ink};
  --accent: ${pal.accent};
  --muted: ${pal.muted};
  --highlight: ${pal.highlight};
  --font-display: '${displayFamily}', serif;
  --font-body:    '${bodyFamily}', sans-serif;
  --font-folio:   '${folioFamily}', sans-serif;
  --title-px: ${titlePx}px;
  --body-px: ${bodyPx}px;
}
html, body { width: ${width}px; height: ${height}px; overflow: hidden; background: var(--bg); font-family: var(--font-body); color: var(--ink); }
#root { position: relative; width: ${width}px; height: ${height}px; }

.bg {
  position: absolute; inset: 0;
  ${isDark
    ? 'background: radial-gradient(ellipse at 50% 30%, rgba(255,255,255,0.04) 0%, transparent 60%);'
    : 'background: radial-gradient(ellipse at 25% 20%, rgba(255,255,255,0.10) 0%, transparent 55%), radial-gradient(ellipse at 75% 80%, rgba(0,0,0,0.05) 0%, transparent 60%);'
  }
}

.intro {
  position: absolute; inset: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  padding: 0 10%; text-align: center; gap: 36px;
}
.intro .kicker {
  font-family: var(--font-body);
  font-size: clamp(${minBody}px, 3vw, 32px);
  letter-spacing: 6px; text-transform: uppercase; color: var(--accent);
}
.intro .title {
  font-family: var(--font-display); font-weight: 900;
  font-size: var(--title-px); line-height: 1.04; color: var(--ink);
  ${hints.uppercase ? 'text-transform: uppercase;' : ''}
  ${hints.trackingPx ? `letter-spacing: ${hints.trackingPx}px;` : ''}
  ${hints.outlineStroke ? `-webkit-text-stroke: ${hints.outlineStroke}px var(--ink); color: var(--bg);` : ''}
}
.intro .byline {
  font-family: var(--font-body); font-size: clamp(24px, 2.2vw, 32px);
  color: var(--muted); letter-spacing: 1px;
}

.page {
  position: absolute; inset: 0;
  padding: ${vertical ? '220px 80px 240px 80px' : '180px 96px 200px 96px'};
  display: flex; align-items: center;
  text-align: ${textAlign};
}
.folio {
  position: absolute; top: ${vertical ? '120' : '96'}px; left: ${vertical ? '80' : '96'}px;
  font-family: var(--font-folio);
  font-size: clamp(${minBody}px, 2.4vw, 32px); letter-spacing: 4px; text-transform: uppercase;
  color: var(--muted); opacity: 0.75;
}
.folio-doodle { text-transform: none; letter-spacing: 2px; }
.folio-medieval { letter-spacing: 3px; }
.folio-bracket { font-family: var(--font-folio); letter-spacing: 2px; }
.body {
  font-family: var(--font-body); font-weight: 500;
  font-size: var(--body-px); line-height: 1.42;
  color: var(--muted);
  text-align: ${textAlign};
  ${textAlign === 'justify' ? 'hyphens: auto;' : ''}
}
.w {
  color: var(--muted);
  display: inline-block;
  transition: color 0.18s ease, font-weight 0.18s ease, transform 0.18s ease;
}
.w.active {
  font-weight: 700;
  transform: scale(1.05);
}

.prompt { color: var(--accent); font-family: var(--font-folio); }

${useMonoPrompt ? `
.terminal-cursor {
  display: inline-block;
  width: 16px; height: 28px;
  margin-left: 6px;
  vertical-align: -4px;
  background: var(--accent);
  animation: cursor-blink 1s steps(2) infinite;
}
@keyframes cursor-blink { 50% { opacity: 0; } }
` : ''}

.end-card {
  position: absolute; left: 0; right: 0; bottom: 0;
  padding: ${vertical ? '48px 56px 72px' : '36px 64px 56px'};
  display: flex; align-items: center; justify-content: center;
  gap: 18px;
  font-family: var(--font-body);
  font-size: clamp(28px, 2.6vw, 44px);
  letter-spacing: 4px;
  text-transform: uppercase;
  color: var(--muted);
  text-align: center;
}
.end-card-text { font-family: var(--font-display); font-weight: 700; }
.end-card-ornament { color: var(--accent); font-size: 1.4em; }
.end-card-heart { color: var(--accent); font-size: 1.3em; }

.end-card-medieval {
  color: var(--accent);
  letter-spacing: 12px;
  border-top: 3px double var(--accent);
  border-bottom: 3px double var(--accent);
  padding-top: 28px; padding-bottom: 28px;
  margin: 0 ${vertical ? '80' : '160'}px ${vertical ? '80' : '56'}px;
}
.end-card-medieval .end-card-text { font-size: 1.2em; }

.end-card-mythic {
  color: var(--accent);
  letter-spacing: 8px;
  font-style: italic;
}
.end-card-mythic .end-card-text { font-family: var(--font-display); font-size: 1.4em; }

.end-card-storybook {
  color: var(--accent);
  letter-spacing: 2px;
  text-transform: none;
}
.end-card-storybook .end-card-text {
  font-family: var(--font-display); font-weight: 900;
  -webkit-text-stroke: 3px var(--ink);
  font-size: 1.3em;
}

.end-card-doodle {
  color: var(--ink);
  letter-spacing: 2px;
  text-transform: none;
  font-style: italic;
}

.end-card-bubble {
  color: var(--ink);
  letter-spacing: 2px;
  text-transform: none;
  font-weight: 400;
}
.end-card-bubble .end-card-text { font-family: var(--font-display); }

.end-card-terminal {
  color: var(--accent);
  font-family: var(--font-folio);
  letter-spacing: 3px;
  justify-content: flex-start;
  padding-left: ${vertical ? '80' : '120'}px;
}
.end-card-terminal .end-card-text { font-family: var(--font-folio); font-weight: 400; }

.end-card-cinema {
  color: var(--ink);
  letter-spacing: 18px;
  font-weight: 700;
}
.end-card-cinema .end-card-text { font-size: 1.5em; }

.end-card-midnight {
  color: var(--accent);
  letter-spacing: 6px;
  text-transform: none;
  font-style: italic;
}

.end-card-rose {
  color: var(--accent);
  letter-spacing: 8px;
  text-transform: none;
}

.end-card-default {
  color: var(--muted);
  letter-spacing: 4px;
}

@media (prefers-reduced-motion: reduce) {
  .bubble { animation: none !important; }
  .stamp-rotate svg { animation: none !important; }
  .terminal-cursor { animation: none !important; opacity: 1; }
}

${useDropCap && hints.illuminatedCap ? `
.drop-cap {
  position: relative;
  float: left; display: block;
  font-family: var(--font-display); font-weight: 900;
  font-size: ${dropCapSize}px; line-height: 0.85;
  background-image: linear-gradient(135deg, var(--accent) 0%, var(--highlight) 55%, var(--accent) 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  text-shadow: 0 2px 0 rgba(0, 0, 0, 0.18), 0 0 1px rgba(255, 255, 255, 0.25);
  margin: 0.05em 0.12em 0 0;
  ${hints.illuminatedCap.border ? 'padding: 0.08em 0.12em; border: 4px double var(--accent); border-radius: 12px;' : ''}
  z-index: 0;
}
.drop-cap::before {
  content: "";
  position: absolute;
  inset: -0.18em;
  z-index: -1;
  pointer-events: none;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 120'><g fill='none' stroke='%238A681A' stroke-width='1.6' opacity='0.55'><path d='M8 8 Q28 2 48 8 T88 8 Q108 2 112 16'/><path d='M8 112 Q28 118 48 112 T88 112 Q108 118 112 104'/><path d='M8 8 Q2 28 8 48 T8 88 Q2 108 16 112'/><path d='M112 8 Q118 28 112 48 T112 88 Q118 108 104 112'/><circle cx='12' cy='12' r='3' fill='%23DDB25E'/><circle cx='108' cy='12' r='3' fill='%23DDB25E'/><circle cx='12' cy='108' r='3' fill='%23DDB25E'/><circle cx='108' cy='108' r='3' fill='%23DDB25E'/><path d='M60 4 Q66 14 60 24 Q54 14 60 4' fill='%23DDB25E' stroke='none' opacity='0.7'/><path d='M60 116 Q66 106 60 96 Q54 106 60 116' fill='%23DDB25E' stroke='none' opacity='0.7'/></g></svg>");
  background-size: 100% 100%;
  background-repeat: no-repeat;
  border-radius: 14px;
  opacity: 0.85;
}` : useDropCap ? `
.drop-cap {
  float: left; display: block;
  font-family: var(--font-display); font-weight: 900;
  font-size: ${dropCapSize}px; line-height: 0.85;
  color: var(--accent);
  margin: 0.05em 0.12em 0 0;
}` : ''}

${useLetterbox ? `
.letterbox-top, .letterbox-bottom {
  position: absolute; left: 0; right: 0;
  background: #000; z-index: 10;
}
.letterbox-top { top: 0; height: ${Math.round(height * 0.09)}px; }
.letterbox-bottom { bottom: 0; height: ${Math.round(height * 0.09)}px; }
` : ''}

${useStamp ? `
.stamp {
  position: absolute; top: ${vertical ? '140' : '120'}px; right: ${vertical ? '80' : '120'}px;
  width: 240px; height: 240px; color: var(--accent);
}
.stamp svg { width: 100%; height: 100%; }
.stamp text { font-family: var(--font-body); font-size: 22px; letter-spacing: 6px; text-transform: uppercase; fill: var(--accent); }
.stamp-rotate svg { animation: stamp-rotate 30s linear infinite; transform-origin: center; }
@keyframes stamp-rotate { to { transform: rotate(360deg); } }
` : ''}

${useScanLines ? `
.scanlines {
  position: absolute; inset: 0; pointer-events: none; z-index: 9;
  background: repeating-linear-gradient(to bottom, rgba(0,0,0,0.18) 0px, rgba(0,0,0,0.18) 1px, transparent 2px, transparent 4px);
  mix-blend-mode: multiply;
}
` : ''}

${useBubbles ? `
.bubble {
  position: absolute; left: var(--x); top: var(--y);
  width: var(--s); height: var(--s); border-radius: 50%;
  background: radial-gradient(circle at 35% 35%, var(--highlight) 0%, transparent 70%);
  opacity: 0.55; filter: blur(12px);
  animation: bubble-drift 22s var(--d) ease-in-out infinite alternate;
}
@keyframes bubble-drift { to { transform: translate(40px, -60px); } }
` : ''}

${useCornerOrnaments ? `
.corner-ornament {
  position: absolute;
  pointer-events: none;
  z-index: 2;
}
.corner-ornament svg { width: 100%; height: 100%; display: block; }
.corner-ornament-tl { top: 32px; left: 32px; }
.corner-ornament-tr { top: 32px; right: 32px; transform: scaleX(-1); }
.corner-ornament-bl { bottom: 32px; left: 32px; transform: scaleY(-1); }
.corner-ornament-br { bottom: 32px; right: 32px; transform: scale(-1, -1); }
` : ''}

${useScrollBorders ? `
.scroll-border {
  position: absolute; left: 0; right: 0;
  pointer-events: none;
  z-index: 2;
}
.scroll-border-svg { width: 100%; height: 100%; display: block; }
.scroll-border-top { top: 48px; }
.scroll-border-bottom { bottom: 48px; transform: scaleY(-1); }
` : ''}

.part-ribbon {
  position: absolute; top: ${vertical ? '140' : '96'}px; right: ${vertical ? '80' : '96'}px;
  font-family: var(--font-body); font-size: 22px;
  letter-spacing: 4px; text-transform: uppercase;
  color: var(--accent); padding: 10px 20px;
  border: 2px solid var(--accent); border-radius: 999px;
}
.part-ribbon-medieval {
  font-family: var(--font-display);
  letter-spacing: 6px;
  text-transform: uppercase;
  color: var(--accent);
  border: none;
  border-top: 2px double var(--accent);
  border-bottom: 2px double var(--accent);
  border-radius: 0;
  padding: 8px 28px;
  background: transparent;
}
.part-ribbon-terminal {
  font-family: var(--font-folio);
  letter-spacing: 2px;
  text-transform: none;
  color: var(--accent);
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid var(--accent);
  border-radius: 4px;
  padding: 8px 14px;
  font-size: 20px;
}
.part-ribbon-epic {
  font-family: var(--font-display);
  letter-spacing: 10px;
  text-transform: uppercase;
  color: var(--ink);
  border: none;
  border-radius: 0;
  padding: 6px 0;
  background: transparent;
  font-weight: 700;
}
.part-ribbon-pop {
  font-family: var(--font-body);
  font-weight: 700;
  letter-spacing: 1px;
  text-transform: none;
  color: var(--bg);
  background: var(--accent);
  border: 3px solid var(--ink);
  border-radius: 999px;
  padding: 10px 22px;
  font-size: 24px;
}
.part-ribbon-scroll {
  font-family: var(--font-display);
  font-style: italic;
  letter-spacing: 2px;
  text-transform: none;
  color: var(--accent);
  border: none;
  border-radius: 0;
  padding: 6px 18px;
  background: transparent;
  font-size: 26px;
}
`;

const html = `<!doctype html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=${width}, height=${height}" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
${fontLinks}
  <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
  <style>${css}</style>
</head>
<body>
  <div id="root"
       data-composition-id="main"
       data-start="0" data-duration="${total.toFixed(2)}"
       data-width="${width}" data-height="${height}">

    <div class="clip bg" data-start="0" data-duration="${total.toFixed(2)}" data-track-index="0">
${letterboxMarkup}
${scanLinesMarkup}
${bubblesMarkup}
${cornerOrnamentsMarkup}
${scrollBordersMarkup}
    </div>

    <div class="clip intro" data-start="0" data-duration="${HEAD_SEC}" data-track-index="1">
      <div class="kicker">un audiocuento · ${escHtml(theme.treatment.family)}</div>
      <div class="title">${escHtml(title)}</div>
      <div class="byline">${escHtml(byline ?? '')}</div>
      ${stampMarkup}
      ${renderPartRibbon(story)}
    </div>

    <audio id="narration" class="clip"
           data-start="${HEAD_SEC}" data-duration="${audioDuration.toFixed(3)}"
           data-track-index="9" src="${escHtml(audioSrc)}"></audio>

${pageBlocks}

    ${renderEndCard({ treatment: t, startSec: total - TAIL_SEC, durationSec: TAIL_SEC })}
  </div>

  <script>
    const tl = gsap.timeline({ paused: true });
    tl.fromTo(".intro", { opacity: 1 }, { opacity: 0, duration: 0.3 }, ${(HEAD_SEC - 0.3).toFixed(2)});

${gsapLines}

    window.__timelines = window.__timelines || {};
    window.__timelines["main"] = tl;
  </script>
</body>
</html>
`;

writeFileSync('index.html', html);
console.log(`wrote index.html: treatment=${t} palette=${pal.id} pairing=${fp.id} ${pages.length} pages, ${words.length} words, ${total.toFixed(2)}s`);
