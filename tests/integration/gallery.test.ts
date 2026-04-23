import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, statSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadCatalog } from '../../src/theme/catalog.js';

const ROOT = resolve(__dirname, '..', '..');
const FIXTURE_OUTPUT = resolve(ROOT, 'tests', 'fixtures', 'audiokids-output');

function runCli(args: string[], opts: { timeout?: number } = {}) {
  const tsx = resolve(ROOT, 'node_modules', '.bin', 'tsx');
  const result = spawnSync(tsx, ['src/cli.ts', ...args], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: opts.timeout ?? 90_000,
    env: {
      ...process.env,
      NO_COLOR: '1',
      AUDIOKIDS_OUTPUT_DIR: FIXTURE_OUTPUT,
      POSTIZ_API_KEY: process.env.POSTIZ_API_KEY ?? 'test',
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('CLI: gallery', () => {
  it('renders every treatment into a single QA HTML file for an existing bundle', () => {
    const work = mkdtempSync(join(tmpdir(), 'gallery-'));
    const out = join(work, 'dragon-gallery.html');
    try {
      const { status, stderr } = runCli(['gallery', '--id', 'dragon-marcos', '--output', out], { timeout: 120_000 });
      expect(status, `stderr: ${stderr}`).toBe(0);
      expect(existsSync(out)).toBe(true);
      const html = readFileSync(out, 'utf-8');
      expect(html).toContain('<!doctype html>');
      const catalog = loadCatalog();
      for (const t of catalog.treatments) {
        expect(html, `treatment ${t.id} missing from gallery`).toContain(t.id);
      }
      // Real gallery output is hefty — twelve iframes plus their srcdoc payloads.
      const bytes = statSync(out).size;
      expect(bytes).toBeGreaterThan(100_000);
    } finally {
      try { rmSync(work, { recursive: true, force: true }); } catch { /* noop */ }
    }
  }, 180_000);

  it('supports --include-treatments to render a subset', () => {
    const work = mkdtempSync(join(tmpdir(), 'gallery-subset-'));
    const out = join(work, 'subset.html');
    try {
      const { status } = runCli(
        ['gallery', '--id', 'dragon-marcos', '--output', out, '--include-treatments', 'hero-display,midnight'],
        { timeout: 60_000 },
      );
      expect(status).toBe(0);
      const html = readFileSync(out, 'utf-8');
      expect(html).toContain('hero-display');
      expect(html).toContain('midnight');
      expect(html).not.toContain('terminal-crt');
    } finally {
      try { rmSync(work, { recursive: true, force: true }); } catch { /* noop */ }
    }
  }, 90_000);
});
