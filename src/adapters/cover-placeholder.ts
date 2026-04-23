/**
 * Cover placeholder generator. The real AudioKids pipeline may not emit a cover
 * asset for every story, so callers that *need* a visual (e.g. future thumbnail
 * renderers) can opt in to a deterministic SVG fallback instead of throwing.
 *
 * Kept intentionally tiny: no external deps, pure string output, one color per
 * mood, title centered. Any richer design belongs in the real cover pipeline,
 * not here.
 */

const MOOD_PALETTE: Record<string, string> = {
  fantasia: '#F1E8D8',
  aventura: '#E76F51',
  calma: '#EDE4FB',
  comedia: '#FFF2E6',
  misterio: '#0E1320',
  emocionante: '#FFE5D9',
  naturaleza: '#DFF5EE',
};

const DEFAULT_BG = '#F5ECDB';

export interface GenerateCoverSvgInput {
  slug: string;
  title: string;
  mood?: string;
}

export function generateCoverSvg(input: GenerateCoverSvgInput): string {
  const { title, mood } = input;
  const bg = (mood && MOOD_PALETTE[mood]) || DEFAULT_BG;
  const fg = pickForeground(bg);
  const lines = wrapTitle(title, 18).slice(0, 4);
  const lineHeight = 96;
  const totalHeight = lines.length * lineHeight;
  const firstY = 540 - totalHeight / 2 + lineHeight * 0.75;
  const tspans = lines
    .map((line, i) => `    <tspan x="540" y="${firstY + i * lineHeight}">${escapeXml(line)}</tspan>`)
    .join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080">
  <rect width="1080" height="1080" fill="${bg}"/>
  <rect x="60" y="60" width="960" height="960" fill="none" stroke="${fg}" stroke-opacity="0.25" stroke-width="4"/>
  <text text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="84" font-weight="700" fill="${fg}">
${tspans}
  </text>
</svg>
`;
}

function wrapTitle(title: string, maxChars: number): string[] {
  const words = title.trim().split(/\s+/);
  const out: string[] = [];
  let current = '';
  for (const w of words) {
    if (!current) {
      current = w;
      continue;
    }
    if (current.length + 1 + w.length <= maxChars) {
      current += ' ' + w;
    } else {
      out.push(current);
      current = w;
    }
  }
  if (current) out.push(current);
  return out.length ? out : [title];
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Dark backgrounds (e.g. misterio #0E1320) need light text to stay legible.
function pickForeground(hex: string): string {
  const n = hex.replace('#', '');
  const r = parseInt(n.substring(0, 2), 16);
  const g = parseInt(n.substring(2, 4), 16);
  const b = parseInt(n.substring(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.55 ? '#2A1E12' : '#F5ECDB';
}
