import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from '../config.js';
import { loadCatalog, type ThemeCatalog } from '../theme/catalog.js';
import type { ContentBundle } from '../core/content-bundle.js';
import { resolveTagline } from '../core/content-bundle.js';
import type { FontPairing, Palette, Treatment } from '../theme/types.js';

const EDITORIAL_TEMPLATE = resolve(config.paths.projectRoot, 'hyperframes', 'templates', 'editorial.mjs');

export type GalleryAspect = 'square' | 'portrait' | 'landscape';

const ASPECT_DIMENSIONS: Record<GalleryAspect, { width: number; height: number }> = {
  square: { width: 1080, height: 1080 },
  portrait: { width: 1080, height: 1920 },
  landscape: { width: 1920, height: 1080 },
};

export interface GalleryOptions {
  bundle: ContentBundle;
  /** Optional subset of treatment ids; when omitted every treatment in the catalog is rendered. */
  includeTreatments?: string[];
  aspect?: GalleryAspect;
  outputPath?: string;
  catalog?: ThemeCatalog;
  now?: () => Date;
  /** Seconds-per-word used to synthesise timings for the editorial.mjs payload (QA preview only). */
  secondsPerWord?: number;
  /** Injected renderer for tests; defaults to spawning editorial.mjs via node. */
  renderTreatment?: (payload: unknown) => string;
}

export interface GalleryResult {
  outputPath: string;
  generated: Array<{ treatmentId: string; bytes: number }>;
  skipped: Array<{ treatmentId: string; reason: string }>;
}

export function generateGallery(opts: GalleryOptions): GalleryResult {
  const catalog = opts.catalog ?? loadCatalog();
  const aspect = opts.aspect ?? 'square';
  const dim = ASPECT_DIMENSIONS[aspect];
  const now = opts.now ?? (() => new Date());
  const render = opts.renderTreatment ?? spawnEditorial;

  const allById = new Map(catalog.treatments.map(t => [t.id, t]));
  // Intentional: we intersect with the catalog so a typo in --include-treatments becomes a visible skip.
  const treatments: Treatment[] = opts.includeTreatments
    ? opts.includeTreatments.map(id => allById.get(id)).filter((t): t is Treatment => Boolean(t))
    : [...catalog.treatments];

  const skipped: Array<{ treatmentId: string; reason: string }> = [];
  if (opts.includeTreatments) {
    for (const id of opts.includeTreatments) {
      if (!allById.has(id)) skipped.push({ treatmentId: id, reason: 'not in catalog' });
    }
  }

  const outputPath = opts.outputPath ?? defaultOutputPath(opts.bundle.id, now());
  mkdirSync(dirname(outputPath), { recursive: true });

  const byPalette = new Map(catalog.palettes.map(p => [p.id, p]));
  const byPairing = new Map(catalog.pairings.map(p => [p.id, p]));

  const title = opts.bundle.text.title ?? opts.bundle.id;
  const byline = resolveTagline(opts.bundle) ?? '';
  const words = synthesiseWords(opts.bundle.text.body, opts.secondsPerWord ?? 0.35);
  const audioSrc = opts.bundle.primaryMedia ?? '';

  const generated: Array<{ treatmentId: string; bytes: number; html: string }> = [];
  for (const treatment of treatments) {
    const palette = firstPalette(treatment, byPalette) ?? catalog.palettes[0];
    const fontPairing = byPairing.get(treatment.fontPairing) ?? catalog.pairings[0];
    const payload = {
      title,
      byline,
      words,
      audioSrc,
      width: dim.width,
      height: dim.height,
      theme: { treatment, palette, fontPairing, source: 'explicit' as const },
    };
    try {
      const html = render(payload);
      generated.push({ treatmentId: treatment.id, bytes: html.length, html });
    } catch (err) {
      skipped.push({
        treatmentId: treatment.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const containerHtml = buildContainerHtml({
    bundleId: opts.bundle.id,
    title,
    aspect,
    dim,
    generatedAt: now().toISOString(),
    frames: generated,
  });
  writeFileSync(outputPath, containerHtml, 'utf-8');

  return {
    outputPath,
    generated: generated.map(g => ({ treatmentId: g.treatmentId, bytes: g.bytes })),
    skipped,
  };
}

function firstPalette(treatment: Treatment, byPalette: Map<string, Palette>): Palette | undefined {
  for (const id of treatment.palettes) {
    const p = byPalette.get(id);
    if (p) return p;
  }
  return undefined;
}

// Deterministic equal-cadence timings so editorial.mjs has the word-level shape it expects.
// Real captions come from whisper at publish time; the gallery is a QA surface, not a deliverable.
function synthesiseWords(body: string, secondsPerWord: number): Array<{ text: string; start: number; end: number }> {
  const tokens = body.split(/\s+/).filter(Boolean);
  const safeTokens = tokens.length > 0 ? tokens : ['...'];
  const out: Array<{ text: string; start: number; end: number }> = [];
  for (let i = 0; i < safeTokens.length; i++) {
    const start = i * secondsPerWord;
    const end = start + secondsPerWord;
    out.push({ text: safeTokens[i], start, end });
  }
  return out;
}

function spawnEditorial(payload: unknown): string {
  const workspace = mkdtempSync(join(tmpdir(), 'postiz-gallery-'));
  try {
    const result = spawnSync('node', [EDITORIAL_TEMPLATE], {
      cwd: workspace,
      input: JSON.stringify(payload),
      encoding: 'utf-8',
      timeout: 30_000,
    });
    if (result.status !== 0) {
      throw new Error(`editorial.mjs exited ${result.status}: ${result.stderr?.trim() ?? ''}`);
    }
    return readFileSync(join(workspace, 'index.html'), 'utf-8');
  } finally {
    try { rmSync(workspace, { recursive: true, force: true }); } catch { /* noop */ }
  }
}

function defaultOutputPath(bundleId: string, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return resolve(config.paths.projectRoot, 'data', 'galleries', `${bundleId}-${stamp}.html`);
}

interface ContainerInput {
  bundleId: string;
  title: string;
  aspect: GalleryAspect;
  dim: { width: number; height: number };
  generatedAt: string;
  frames: Array<{ treatmentId: string; html: string }>;
}

function buildContainerHtml(input: ContainerInput): string {
  // iframes keep each treatment's CSS/fonts isolated — otherwise the twelve themes
  // would trample each other's :root variables and global resets.
  const frames = input.frames.map(f => {
    const srcdoc = escapeHtmlAttr(f.html);
    return `
      <article class="frame">
        <header>
          <h2>${escapeHtmlText(f.treatmentId)}</h2>
          <span class="aspect">${input.dim.width} x ${input.dim.height}</span>
        </header>
        <iframe
          title="${escapeHtmlAttr(f.treatmentId)}"
          loading="lazy"
          sandbox="allow-scripts"
          srcdoc="${srcdoc}"
          style="width:${input.dim.width}px;height:${input.dim.height}px"
        ></iframe>
      </article>`;
  }).join('\n');

  // Scale individual iframes down when the viewport is narrower than the native
  // 1080/1920 frame so twelve renders remain browsable on a laptop.
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<title>Gallery: ${escapeHtmlText(input.bundleId)}</title>
<style>
  :root { --bg: #0e1117; --fg: #f5f5f5; --muted: #8b949e; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; background: var(--bg); color: var(--fg); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
  h1 { margin: 0 0 4px 0; font-size: 22px; }
  .meta { color: var(--muted); font-size: 13px; margin-bottom: 32px; }
  .frame { margin-bottom: 48px; border: 1px solid #30363d; border-radius: 8px; overflow: hidden; background: #161b22; }
  .frame header { display: flex; align-items: baseline; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid #30363d; }
  .frame h2 { margin: 0; font-size: 18px; font-family: ui-monospace, Menlo, monospace; }
  .frame .aspect { color: var(--muted); font-size: 12px; }
  .frame iframe { display: block; border: 0; transform-origin: top left; }
  @media (max-width: 1200px) {
    .frame iframe { transform: scale(0.5); margin-bottom: calc(var(--h, 0px) * -0.5); }
  }
</style>
</head>
<body>
<h1>Gallery: ${escapeHtmlText(input.bundleId)} — ${escapeHtmlText(input.title)}</h1>
<p class="meta">aspect=${input.aspect} · ${input.frames.length} treatments · generated ${escapeHtmlText(input.generatedAt)}</p>
${frames}
</body>
</html>
`;
}

function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface GalleryCliFormatOpts {
  json?: boolean;
}

export function formatGalleryResult(result: GalleryResult, opts: GalleryCliFormatOpts = {}): string {
  if (opts.json) return JSON.stringify(result, null, 2);
  const lines: string[] = [];
  lines.push(`wrote ${result.outputPath}`);
  lines.push(`  generated: ${result.generated.length}`);
  for (const g of result.generated) {
    lines.push(`    ${g.treatmentId.padEnd(24)} ${g.bytes} bytes`);
  }
  if (result.skipped.length > 0) {
    lines.push(`  skipped: ${result.skipped.length}`);
    for (const s of result.skipped) {
      lines.push(`    ${s.treatmentId.padEnd(24)} ${s.reason}`);
    }
  }
  return lines.join('\n');
}

export { ASPECT_DIMENSIONS };
