#!/usr/bin/env node
/**
 * Download every Google Fonts pairing declared in hyperframes/themes/fonts.json
 * to hyperframes/assets/fonts/<family-slug>/ as a self-contained bundle:
 *   - <slug>.css with @font-face blocks rewritten to point at local .woff2 files
 *   - one or more *.woff2 binaries (one per weight + style)
 *
 * Why: editorial.mjs currently relies on <link> tags to fonts.googleapis.com,
 * which blocks rendering when the operator's network is slow or offline. After
 * this script runs once, resolveFontLinks() in common.mjs picks the local CSS
 * and we stop depending on Google's CDN at render time.
 *
 * Idempotent by default: skips any family whose <slug>.css already exists.
 * Pass --force to re-download everything. Network errors on a single pairing
 * emit a warning and continue so one flaky family does not kill the batch.
 *
 * Usage: pnpm fetch-fonts [--force]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseFontFaces,
  rewriteCssUrls,
  slugifyFamily,
} from './lib/fonts.mjs';

interface FontFace {
  family: string;
  weights: number[];
  url: string;
}

interface FontPairing {
  id: string;
  display: FontFace;
  body: FontFace;
  folio?: FontFace;
}

interface FontsManifest {
  version: number;
  pairings: FontPairing[];
}

interface FetchResult {
  family: string;
  cssPath: string;
  fileCount: number;
}

// Google's css2 endpoint serves different @font-face blocks depending on the
// User-Agent. A modern Chrome string coaxes it into returning woff2-only CSS.
const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..');
const MANIFEST_PATH = resolve(PROJECT_ROOT, 'hyperframes', 'themes', 'fonts.json');
const OUT_ROOT = resolve(PROJECT_ROOT, 'hyperframes', 'assets', 'fonts');

async function main(): Promise<void> {
  const force = process.argv.includes('--force');
  const manifest = readManifest(MANIFEST_PATH);

  // Flatten faces across pairings then de-dup by family so we fetch shared
  // families (e.g. Inter appears in multiple pairings) exactly once.
  const uniqueFaces = new Map<string, FontFace>();
  for (const p of manifest.pairings) {
    for (const face of [p.display, p.body, p.folio].filter(Boolean) as FontFace[]) {
      if (!uniqueFaces.has(face.family)) uniqueFaces.set(face.family, face);
    }
  }

  mkdirSync(OUT_ROOT, { recursive: true });
  const results: FetchResult[] = [];
  const warnings: string[] = [];

  for (const face of uniqueFaces.values()) {
    try {
      const result = await fetchFamily(face, { outRoot: OUT_ROOT, force });
      results.push(result);
      console.log(`  OK ${face.family}: ${result.fileCount} file(s) -> ${result.cssPath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`${face.family}: ${msg}`);
      console.warn(`  WARN ${face.family}: ${msg}`);
    }
  }

  console.log(`\n${results.length} families cached, ${warnings.length} warning(s).`);
  if (warnings.length > 0) {
    console.log('Re-run `pnpm fetch-fonts --force` to retry failed families.');
  }
}

function readManifest(path: string): FontsManifest {
  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw) as FontsManifest;
  if (!parsed?.pairings?.length) {
    throw new Error(`No pairings found in ${path}`);
  }
  return parsed;
}

async function fetchFamily(
  face: FontFace,
  opts: { outRoot: string; force: boolean },
): Promise<FetchResult> {
  const slug = slugifyFamily(face.family);
  const familyDir = join(opts.outRoot, slug);
  const cssPath = join(familyDir, `${slug}.css`);

  if (!opts.force && existsSync(cssPath)) {
    return { family: face.family, cssPath, fileCount: countWoff2(familyDir) };
  }

  const css = await fetchCss(face.url);
  const faces = parseFontFaces(css);
  if (faces.length === 0) {
    throw new Error(`no @font-face blocks returned for ${face.family}`);
  }

  mkdirSync(familyDir, { recursive: true });

  // Two-phase write: stage every woff2 first, then write the CSS as the final
  // marker. If any binary download fails mid-flight we wipe the directory so
  // the next run redownloads cleanly, and the missing .css keeps the idempotent
  // skip guard above from treating a half-finished family as cached.
  try {
    const urlMap = new Map<string, string>();
    let fileIndex = 0;
    for (const f of faces) {
      const fname = woff2Filename(f, fileIndex++);
      const binPath = join(familyDir, fname);
      const bin = await fetchBinary(f.url);
      writeFileSync(binPath, bin);
      urlMap.set(f.url, `./${fname}`);
    }
    const rewritten = rewriteCssUrls(css, urlMap);
    writeFileSync(cssPath, rewritten);
  } catch (err) {
    rmSync(familyDir, { recursive: true, force: true });
    throw err;
  }

  return { family: face.family, cssPath, fileCount: faces.length };
}

async function fetchCss(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': CHROME_UA, Accept: 'text/css,*/*;q=0.1' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching CSS ${url}`);
  return res.text();
}

async function fetchBinary(url: string): Promise<Buffer> {
  const res = await fetch(url, { headers: { 'User-Agent': CHROME_UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching binary ${url}`);
  const buf = await res.arrayBuffer();
  return Buffer.from(buf);
}

/** Deterministic filename so re-runs overwrite cleanly instead of accumulating variants. */
function woff2Filename(face: { weight: string; style: string }, index: number): string {
  const style = face.style === 'italic' ? '-italic' : '';
  return `w${face.weight}${style}-${index}.woff2`;
}

function countWoff2(dir: string): number {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.woff2')).length;
  } catch {
    return 0;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
