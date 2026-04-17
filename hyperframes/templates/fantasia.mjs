#!/usr/bin/env node
/**
 * fantasia mood — warm parchment background, Fraunces serif, book-page pacing.
 * Input (via stdin, JSON):
 *   { title, byline, words, audioSrc, width, height }
 * Output: writes to <cwd>/index.html
 */
import { writeFileSync } from 'node:fs';
import { HEAD_SEC, TAIL_SEC, buildPages, escHtml, emitWordColorTimeline, readStoryFromStdin } from './common.mjs';

const PALETTE = {
  bg: '#F1E8D8',
  ink: '#2B1B0F',
  ember: '#C17B38',
  muted: '#8B6F4F',
};

const story = await readStoryFromStdin();
const { title, byline, words, audioSrc, width, height } = story;

const pages = buildPages(words);
const audioDuration = words.at(-1).end;
const total = HEAD_SEC + audioDuration + TAIL_SEC;

const pageBlocks = pages.map((p, i) => {
  const startAbs = (HEAD_SEC + p.startSec).toFixed(3);
  const dur = ((i + 1 < pages.length ? pages[i + 1].startSec : p.endSec + 0.4) - p.startSec).toFixed(3);
  const folio = `— ${String(i + 1).padStart(2, '0')} —`;
  const wordSpans = p.tokens.map((t, j) =>
    `<span class="w" data-word="${j}">${escHtml(t.text)}</span>`,
  ).join(' ');
  return `    <div class="clip page" id="page-${i}" data-start="${startAbs}" data-duration="${dur}" data-track-index="2">
      <div class="folio">${folio}</div>
      <p class="body">${wordSpans}</p>
    </div>`;
}).join('\n');

const gsapLines = emitWordColorTimeline(pages, {
  activeColor: PALETTE.ember,
  pastColor: PALETTE.ink,
});

const html = `<!doctype html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=${width}, height=${height}" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:wght@400;500;700&family=Inter:wght@400;500;700&display=swap" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: ${width}px; height: ${height}px; overflow: hidden; background: ${PALETTE.bg}; font-family: 'Inter', sans-serif; }
    #root { position: relative; width: ${width}px; height: ${height}px; }

    .bg {
      position: absolute; inset: 0;
      background:
        radial-gradient(ellipse at 25% 20%, rgba(232,184,74,0.12) 0%, transparent 55%),
        radial-gradient(ellipse at 75% 80%, rgba(193,123,56,0.10) 0%, transparent 60%);
    }

    .intro {
      position: absolute; inset: 0;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      padding: 0 10%; text-align: center;
    }
    .intro .kicker {
      font-size: 24px; letter-spacing: 6px; text-transform: uppercase;
      color: ${PALETTE.ember}; margin-bottom: 40px;
    }
    .intro .title {
      font-family: 'Fraunces', serif; font-weight: 700;
      font-size: 108px; line-height: 1.04; color: ${PALETTE.ink};
    }
    .intro .byline {
      font-size: 32px; color: ${PALETTE.muted}; margin-top: 48px; letter-spacing: 1px;
    }

    .page {
      position: absolute; inset: 0;
      padding: 180px 96px 200px 96px;
      display: flex; align-items: center;
    }
    .folio {
      position: absolute; top: 96px; left: 96px;
      font-size: 20px; letter-spacing: 4px; text-transform: uppercase;
      color: ${PALETTE.muted}; opacity: 0.75;
    }
    .body {
      font-family: 'Fraunces', serif; font-weight: 500;
      font-size: 64px; line-height: 1.38;
      color: ${PALETTE.muted};
      text-align: left;
    }
    .w { color: ${PALETTE.muted}; }

    .brand {
      position: absolute; bottom: 0; left: 0; right: 0;
      padding: 24px 48px;
      font-size: 22px; letter-spacing: 4px; text-transform: uppercase;
      color: ${PALETTE.muted}; text-align: center;
    }
  </style>
</head>
<body>
  <div id="root"
       data-composition-id="main"
       data-start="0" data-duration="${total.toFixed(2)}"
       data-width="${width}" data-height="${height}">

    <div class="clip bg" data-start="0" data-duration="${total.toFixed(2)}" data-track-index="0"></div>

    <div class="clip intro" data-start="0" data-duration="${HEAD_SEC}" data-track-index="1">
      <div class="kicker">un cuento de audiokids</div>
      <div class="title">${escHtml(title)}</div>
      <div class="byline">${escHtml(byline)}</div>
    </div>

    <audio id="narration" class="clip" data-start="${HEAD_SEC}" data-duration="${audioDuration.toFixed(3)}" data-track-index="9" src="${escHtml(audioSrc)}"></audio>

${pageBlocks}

    <div class="clip brand" data-start="0" data-duration="${total.toFixed(2)}" data-track-index="3">audiokids · cuentos con corazón</div>
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
console.log(`wrote index.html: ${pages.length} pages, ${words.length} words, ${total.toFixed(2)}s`);
