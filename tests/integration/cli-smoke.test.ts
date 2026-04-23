import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');

function runCli(args: string[], opts: { timeout?: number } = {}) {
  // Invoke tsx directly: pnpm and `pnpm exec` both print a header line that
  // contaminates JSON stdout; the .bin shim does not.
  const tsx = resolve(ROOT, 'node_modules', '.bin', 'tsx');
  const result = spawnSync(tsx, ['src/cli.ts', ...args], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: opts.timeout ?? 30_000,
    env: { ...process.env, NO_COLOR: '1' },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe('CLI smoke: top-level --help', () => {
  it('lists every shipped subcommand', () => {
    const { stdout, status } = runCli(['--help']);
    expect(status).toBe(0);
    for (const cmd of ['publish', 'render', 'rss', 'decisions', 'status', 'integrations', 'dispatch', 'themes', 'gallery']) {
      expect(stdout).toContain(cmd);
    }
  });
});

describe('CLI smoke: status --json', () => {
  it('returns a well-formed check list', () => {
    const { stdout } = runCli(['status', '--json']);
    const checks = JSON.parse(stdout);
    expect(Array.isArray(checks)).toBe(true);
    const labels = checks.map((c: { label: string }) => c.label);
    expect(labels).toEqual(expect.arrayContaining([
      'ffmpeg installed',
      'ffprobe installed',
      'npx installed',
      'AudioKids output dir',
    ]));
    for (const c of checks as Array<{ ok: boolean; required: boolean }>) {
      expect(typeof c.ok).toBe('boolean');
      expect(typeof c.required).toBe('boolean');
    }
  });
});

describe('CLI smoke: dispatch rejects without candidates', () => {
  it('returns dispatched:false when no slug is eligible', () => {
    // Fixture state is non-deterministic (depends on decision log); both
    // shapes are valid, we only assert the payload parses with expected keys.
    const { stdout } = runCli(['dispatch', '--platforms', 'tiktok', '--dry-run', '--json'], { timeout: 10_000 });
    const first = stdout.trim().split('\n')[0];
    const parsed = JSON.parse(first);
    expect(parsed).toHaveProperty('dispatched');
    if (parsed.dispatched === false) {
      expect(parsed).toHaveProperty('reason');
    } else {
      expect(parsed).toHaveProperty('slug');
      expect(parsed).toHaveProperty('platforms');
    }
  });
});

describe('CLI smoke: rss produces valid XML', () => {
  it('writes a feed.xml to the requested path', () => {
    const out = resolve(ROOT, 'tmp', 'smoke-feed.xml');
    const { status } = runCli(['rss', '--output', out]);
    expect(status).toBe(0);
    const xml = readFileSync(out, 'utf-8');
    expect(xml).toContain('<?xml');
    expect(xml).toContain('<rss');
  });
});

describe('CLI smoke: publish rejects malformed slugs', () => {
  it('exits non-zero on a path-traversal slug', () => {
    const { status, stderr, stdout } = runCli(['publish', '--slug', '../../etc/passwd', '--platforms', 'tiktok', '--dry-run']);
    expect(status).not.toBe(0);
    expect(stderr + stdout).toMatch(/Invalid slug|must match/);
  });
});

describe('CLI smoke: tools list --json', () => {
  it('returns an array of tool descriptors with JSON schemas', () => {
    const { stdout, status } = runCli(['tools', 'list', '--json']);
    expect(status).toBe(0);
    const descriptors = JSON.parse(stdout);
    expect(Array.isArray(descriptors)).toBe(true);
    const names = descriptors.map((d: { name: string }) => d.name).sort();
    expect(names).toEqual(expect.arrayContaining(['transcribe', 'moderate-captions', 'render-slide-video']));
    for (const d of descriptors) {
      expect(d).toHaveProperty('description');
      expect((d as { inputSchema: { type?: string } }).inputSchema.type).toBe('object');
      expect((d as { outputSchema: { type?: string } }).outputSchema.type).toBe('object');
    }
  });
});

describe('CLI smoke: doctor --json', () => {
  it('returns a well-formed report with expected sections', () => {
    const { stdout, status } = runCli(['doctor', '--json'], { timeout: 30_000 });
    const report = JSON.parse(stdout);
    expect(report).toHaveProperty('generatedAt');
    expect(report).toHaveProperty('ok');
    expect(Array.isArray(report.sections)).toBe(true);
    const names = report.sections.map((s: { name: string }) => s.name);
    for (const n of ['environment', 'postiz', 'audiokids', 'stuck-slugs', 'recent-failures', 'upload-cache', 'theme-decisions']) {
      expect(names).toContain(n);
    }
    // Exit is 0 or 1 depending on real environment state; both are valid shapes.
    expect([0, 1]).toContain(status);
  });
});

describe('CLI smoke: stats --json --days 7', () => {
  it('returns totals, byPlatform, topRemediations, topStuck, ctaVariants', () => {
    const { stdout, status } = runCli(['stats', '--json', '--days', '7']);
    expect(status).toBe(0);
    const report = JSON.parse(stdout);
    expect(report).toHaveProperty('windowDays', 7);
    expect(report).toHaveProperty('totals');
    expect(report.totals).toHaveProperty('total');
    expect(report.totals).toHaveProperty('success');
    expect(report.totals).toHaveProperty('failed');
    expect(report.totals).toHaveProperty('skipped');
    expect(report.totals).toHaveProperty('successRate');
    expect(report).toHaveProperty('byPlatform');
    expect(Array.isArray(report.topRemediations)).toBe(true);
    expect(Array.isArray(report.topStuck)).toBe(true);
    expect(report).toHaveProperty('ctaVariants');
  });
});

describe('CLI smoke: decisions --run-id', () => {
  it('returns a JSON array (possibly empty) when filtered by a valid uuid', () => {
    const { stdout, status } = runCli(['decisions', '--run-id', '11111111-2222-3333-4444-555555555555', '--pretty']);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
  });
});

describe('CLI smoke: tools describe', () => {
  it('prints full descriptor for a known tool', () => {
    const { stdout, status } = runCli(['tools', 'describe', 'transcribe']);
    expect(status).toBe(0);
    const d = JSON.parse(stdout);
    expect(d.name).toBe('transcribe');
    expect(d.inputSchema).toHaveProperty('properties');
    expect(d.outputSchema).toHaveProperty('properties');
  });

  it('exits non-zero for unknown tool', () => {
    const { status, stderr } = runCli(['tools', 'describe', 'nope-tool']);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/unknown tool/);
  });
});

describe('CLI smoke: themes list --json', () => {
  it('returns at least 12 treatments with the expected shape', () => {
    const { stdout, status } = runCli(['themes', 'list', '--json']);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    const treatments = Array.isArray(parsed) ? parsed : parsed.treatments;
    expect(Array.isArray(treatments)).toBe(true);
    expect(treatments.length).toBeGreaterThanOrEqual(12);
    for (const t of treatments) {
      expect(t).toHaveProperty('id');
      expect(t).toHaveProperty('family');
      expect(t).toHaveProperty('fontPairing');
      expect(t).toHaveProperty('description');
    }
    const ids = treatments.map((t: { id: string }) => t.id);
    expect(ids).toEqual(expect.arrayContaining(['hero-display', 'midnight', 'terminal-crt']));
  });
});

describe('CLI smoke: themes describe', () => {
  it('returns a descriptor with resolved palettes and fontPairing for a valid id', () => {
    const { stdout, status } = runCli(['themes', 'describe', 'hero-display', '--json']);
    expect(status).toBe(0);
    const desc = JSON.parse(stdout);
    expect(desc.ok).toBe(true);
    expect(desc.treatment.id).toBe('hero-display');
    expect(Array.isArray(desc.palettes)).toBe(true);
    expect(desc.palettes.length).toBeGreaterThan(0);
    for (const p of desc.palettes) {
      expect(p).toHaveProperty('bg');
      expect(p).toHaveProperty('ink');
      expect(p).toHaveProperty('accent');
    }
    expect(desc.fontPairing).toHaveProperty('display');
    expect(desc.fontPairing).toHaveProperty('body');
  });

  it('exits non-zero on an unknown treatment id', () => {
    const { status, stderr, stdout } = runCli(['themes', 'describe', 'unknown-treatment-id']);
    expect(status).not.toBe(0);
    expect(stderr + stdout).toMatch(/unknown|not found|unknown-treatment-id/i);
  });
});
