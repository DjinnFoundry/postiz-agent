import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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
  it('returns deps array + system panel with tool/treatment/decision counts', () => {
    const { stdout } = runCli(['status', '--json']);
    const report = JSON.parse(stdout);
    expect(report).toHaveProperty('generatedAt');
    expect(Array.isArray(report.deps)).toBe(true);
    const labels = report.deps.map((c: { label: string }) => c.label);
    expect(labels).toEqual(expect.arrayContaining([
      'ffmpeg installed',
      'ffprobe installed',
      'npx installed',
      'AudioKids output dir',
    ]));
    for (const c of report.deps as Array<{ ok: boolean; required: boolean }>) {
      expect(typeof c.ok).toBe('boolean');
      expect(typeof c.required).toBe('boolean');
    }
    expect(report).toHaveProperty('system');
    expect(typeof report.system.tools).toBe('number');
    expect(report.system.tools).toBeGreaterThan(0);
    expect(typeof report.system.treatments).toBe('number');
    expect(report.system.treatments).toBeGreaterThan(0);
    expect(typeof report.system.decisions).toBe('number');
    expect(typeof report.system.themeDecisions).toBe('number');
    expect(report.system).toHaveProperty('uploads');
    expect(typeof report.system.uploads.count).toBe('number');
    expect(typeof report.system.stuckSlugs).toBe('number');
    expect(report.system).toHaveProperty('successRate7d');
    expect(typeof report.system.successRate7d.success).toBe('number');
    expect(typeof report.system.successRate7d.failed).toBe('number');
    expect(typeof report.system.successRate7d.rate).toBe('number');
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

describe('CLI smoke: cta-ab --json --days 30', () => {
  it('returns a well-formed per-platform variant report', () => {
    const { stdout, status } = runCli(['cta-ab', '--json', '--days', '30']);
    expect(status).toBe(0);
    const report = JSON.parse(stdout);
    expect(report).toHaveProperty('windowDays', 30);
    expect(report).toHaveProperty('platforms');
    expect(typeof report.platforms).toBe('object');
    for (const p of Object.values(report.platforms) as Array<{
      variants: Array<{ id: string; uses: number; success: number; failed: number; successRate: number; sampleUrls: string[] }>;
      unknownCount: number;
    }>) {
      expect(Array.isArray(p.variants)).toBe(true);
      expect(typeof p.unknownCount).toBe('number');
      for (const v of p.variants) {
        expect(typeof v.id).toBe('string');
        expect(typeof v.uses).toBe('number');
        expect(typeof v.success).toBe('number');
        expect(typeof v.failed).toBe('number');
        expect(typeof v.successRate).toBe('number');
        expect(Array.isArray(v.sampleUrls)).toBe(true);
      }
    }
  });

  it('accepts --ingest and reports ingestApplied=true with the file path echoed back', () => {
    const tmpFile = resolve(ROOT, 'tmp', 'cta-ab-ingest-smoke.jsonl');
    mkdirSync(resolve(ROOT, 'tmp'), { recursive: true });
    writeFileSync(tmpFile, '', 'utf-8');
    const { stdout, status } = runCli(['cta-ab', '--json', '--days', '30', '--ingest', tmpFile]);
    expect(status).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.ingestApplied).toBe(true);
    expect(report.ingestFile).toBe(tmpFile);
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
  it('prints full descriptor (including examples) as JSON when --json is set', () => {
    const { stdout, status } = runCli(['tools', 'describe', 'transcribe', '--json']);
    expect(status).toBe(0);
    const d = JSON.parse(stdout);
    expect(d.name).toBe('transcribe');
    expect(d.inputSchema).toHaveProperty('properties');
    expect(d.outputSchema).toHaveProperty('properties');
    expect(Array.isArray(d.examples)).toBe(true);
    expect(d.examples.length).toBeGreaterThanOrEqual(1);
    expect(d.examples[0]).toHaveProperty('description');
    expect(d.examples[0]).toHaveProperty('input');
    expect(Array.isArray(d.composes)).toBe(true);
  });

  it('prints a human-readable guide (without --json) mentioning Examples:', () => {
    const { stdout, status } = runCli(['tools', 'describe', 'transcribe']);
    expect(status).toBe(0);
    expect(stdout).toContain('transcribe');
    expect(stdout).toMatch(/Examples:/);
    expect(stdout).toMatch(/Typical next steps/i);
    expect(stdout).toContain('moderate-captions');
  });

  it('exits non-zero for unknown tool', () => {
    const { status, stderr } = runCli(['tools', 'describe', 'nope-tool']);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/unknown tool/);
  });
});

describe('CLI smoke: tools docs', () => {
  it('without args, lists every registered tool with a one-line description', () => {
    const { stdout, status } = runCli(['tools', 'docs']);
    expect(status).toBe(0);
    for (const name of ['transcribe', 'moderate-captions', 'render-slide-video', 'resolve-theme', 'choose-theme']) {
      expect(stdout).toContain(name);
    }
    expect(stdout).toMatch(/tools docs <name>/);
  });

  it('with a tool name, prints a full markdown-ish guide including composes', () => {
    const { stdout, status } = runCli(['tools', 'docs', 'transcribe']);
    expect(status).toBe(0);
    expect(stdout).toContain('# transcribe');
    expect(stdout).toMatch(/## Description/);
    expect(stdout).toMatch(/## Input/);
    expect(stdout).toMatch(/## Output/);
    expect(stdout).toMatch(/## Examples/);
    expect(stdout).toContain('moderate-captions');
  });

  it('exits non-zero for an unknown tool name', () => {
    const { status, stderr } = runCli(['tools', 'docs', 'nope-tool']);
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

describe('CLI smoke: decisions archives --json', () => {
  it('returns a JSON array (possibly empty) listing rotated logs', () => {
    const { stdout, status } = runCli(['decisions', 'archives', '--json']);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    for (const a of parsed) {
      expect(a).toHaveProperty('path');
      expect(a).toHaveProperty('sizeBytes');
    }
  });
});

describe('CLI smoke: tools call rejects unsafe --bundle-file', () => {
  it('refuses /etc/passwd with a clear error', () => {
    const { status, stderr, stdout } = runCli(
      ['tools', 'call', 'render-slide-video', '--bundle-file', '/etc/passwd'],
    );
    expect(status).not.toBe(0);
    expect(stderr + stdout).toMatch(/bundle-file must live under/);
  });
});

describe('CLI smoke: logs prune --json --dry-run', () => {
  it('returns a well-formed prune report without deleting', () => {
    const { stdout, status } = runCli(['logs', 'prune', '--dry-run', '--json']);
    expect(status).toBe(0);
    const report = JSON.parse(stdout);
    expect(report).toHaveProperty('removed');
    expect(report).toHaveProperty('kept');
    expect(report).toHaveProperty('bytesFreed');
    expect(report).toHaveProperty('dryRun', true);
    expect(report).toHaveProperty('olderThanDays');
    expect(typeof report.removed).toBe('number');
    expect(typeof report.kept).toBe('number');
    expect(typeof report.bytesFreed).toBe('number');
    expect(typeof report.olderThanDays).toBe('number');
  });
});

describe('CLI smoke: cache prune --json --dry-run', () => {
  it('returns a well-formed upload-cache prune report', () => {
    const { stdout, status } = runCli(['cache', 'prune', '--dry-run', '--json']);
    expect(status).toBe(0);
    const report = JSON.parse(stdout);
    expect(report).toHaveProperty('removed');
    expect(report).toHaveProperty('kept');
    expect(report).toHaveProperty('dryRun', true);
    expect(typeof report.removed).toBe('number');
    expect(typeof report.kept).toBe('number');
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

describe('CLI smoke: themes check-decisions --json', () => {
  it('returns a JSON array (possibly empty) and exits 0', () => {
    const { stdout, status } = runCli(['themes', 'check-decisions', '--json']);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    for (const entry of parsed) {
      expect(entry).toHaveProperty('bundleId');
      expect(entry).toHaveProperty('reason');
    }
  });
});

describe('CLI smoke: decisions --stuck (human)', () => {
  it('prints a table (or empty message) and never raw JSON when --json is omitted', () => {
    const { stdout, status } = runCli(['decisions', '--stuck']);
    expect(status).toBe(0);
    const trimmed = stdout.trim();
    expect(trimmed.startsWith('[')).toBe(false);
    if (trimmed.length === 0 || /no stuck slugs/i.test(trimmed)) return;
    expect(trimmed).toMatch(/slug/i);
    expect(trimmed).toMatch(/platform/i);
    expect(trimmed).toMatch(/reason/i);
  });
});

describe('CLI smoke: decisions --stuck --json', () => {
  it('still emits a JSON array when --json is passed', () => {
    const { stdout, status } = runCli(['decisions', '--stuck', '--json']);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
  });
});

describe('CLI smoke: copy preview without --id or --bundle-file', () => {
  it('exits 0 and prints a usage hint instead of throwing', () => {
    const { stdout, stderr, status } = runCli(['copy', 'preview']);
    expect(status).toBe(0);
    const text = stdout + stderr;
    expect(text).toMatch(/--id|--bundle-file/);
    expect(text).not.toMatch(/TypeError|at .*\.ts/);
  });
});

describe('CLI smoke: run-pipeline --stream emits NDJSON per step', () => {
  it('one JSON object per completed step, and a final summary line', () => {
    const ROOT_LOCAL = resolve(__dirname, '..', '..');
    const tmpDir = resolve(ROOT_LOCAL, 'tmp', 'stream-smoke');
    mkdirSync(tmpDir, { recursive: true });

    const bundlePath = resolve(tmpDir, 'smoke-bundle.json');
    writeFileSync(bundlePath, JSON.stringify({
      id: 'smoke-stream-bundle',
      kind: 'text',
      text: { title: 'Smoke', body: 'Érase una vez un prompt corto.' },
      locale: 'es',
    }), 'utf-8');

    const specPath = resolve(tmpDir, 'smoke-pipeline.json');
    writeFileSync(specPath, JSON.stringify({
      name: 'smoke-stream',
      version: '1.0.0',
      steps: [
        { tool: 'resolve-theme', args: { preview: true } },
        { tool: 'resolve-theme', args: { preview: true } },
      ],
    }), 'utf-8');

    const { stdout, status } = runCli([
      'run-pipeline', specPath,
      '--bundle-file', bundlePath,
      '--stream',
    ]);
    expect([0, 1]).toContain(status);

    const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);

    const parsed = lines.map(l => {
      try { return JSON.parse(l); } catch { return null; }
    });
    for (const p of parsed) {
      expect(p).not.toBeNull();
    }
    const stepLines = parsed.filter((p): p is { type: string } => !!p && (p as { type?: string }).type === 'step');
    expect(stepLines.length).toBeGreaterThanOrEqual(2);
    const summaryLines = parsed.filter((p): p is { type: string } => !!p && (p as { type?: string }).type === 'summary');
    expect(summaryLines.length).toBe(1);
  });
});
