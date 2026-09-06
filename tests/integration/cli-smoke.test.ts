import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');
const POSTIZ_URL = 'http://127.0.0.1:1/public/v1';
let workspace: string;

beforeAll(() => {
  // config resolves its paths from import.meta.url, so changing cwd alone would
  // still read the operator's .env and mutate their data. Copy only source and
  // checked-in fixtures, and share dependencies without sharing runtime state.
  workspace = mkdtempSync(resolve(tmpdir(), 'postiz-cli-smoke-'));
  for (const path of ['src', 'hyperframes/themes', 'tests/fixtures/audiokids-output', 'package.json', 'tsconfig.json']) {
    cpSync(resolve(ROOT, path), resolve(workspace, path), { recursive: true });
  }
  symlinkSync(resolve(ROOT, 'node_modules'), resolve(workspace, 'node_modules'), 'dir');
  mkdirSync(resolve(workspace, 'smoke-bin'));
  for (const [name, flag] of Object.entries({ ffmpeg: '-version', ffprobe: '-version', whisper: '--help', npx: '--version' })) {
    const replies: Record<string, string> = { [JSON.stringify([flag])]: 'smoke fixture\n' };
    if (name === 'ffprobe') {
      const audio = resolve(workspace, 'tests', 'fixtures', 'audiokids-output', 'dragon-marcos.mp3');
      replies[JSON.stringify(['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', audio])] = '180\n';
      // Deliberately below the production minimum: dispatch exercises a complete
      // rejected preflight, without starting Whisper or a renderer.
      replies[JSON.stringify(['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=bit_rate', '-of', 'csv=p=0', audio])] = '32000\n';
    }
    const script = resolve(workspace, 'smoke-bin', `${name}.mjs`);
    writeFileSync(script, `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const output = ${JSON.stringify(replies)}[JSON.stringify(process.argv.slice(2))];
if (output !== undefined) {
  process.stdout.write(output);
} else {
  appendFileSync(process.env.SMOKE_UNEXPECTED_CALLS, JSON.stringify(process.argv) + '\\n');
  process.exitCode = 1;
}
`, { mode: 0o755 });
    symlinkSync(script, resolve(workspace, 'smoke-bin', name));
  }
  writeFileSync(resolve(workspace, 'smoke-network.mjs'), `
import { appendFileSync } from 'node:fs';
globalThis.fetch = async (input, options) => {
  if (String(input) === 'http://127.0.0.1:1/' && options?.method === 'GET') {
    return new Response('', { status: 200 });
  }
  appendFileSync(process.env.SMOKE_UNEXPECTED_CALLS, 'unexpected fetch: ' + String(input) + '\\n');
  throw new Error('network disabled in CLI smoke tests');
};
`);
});

beforeEach(() => {
  for (const path of ['data', 'tmp', 'tenants', 'empty-audiokids']) {
    rmSync(resolve(workspace, path), { recursive: true, force: true });
  }
  mkdirSync(resolve(workspace, 'tmp'));
  mkdirSync(resolve(workspace, 'empty-audiokids'));
  mkdirSync(resolve(workspace, 'tenants', 'smoke-tenant'), { recursive: true });
  writeFileSync(resolve(workspace, 'tenants', 'smoke-tenant', 'config.json'), JSON.stringify({
    postiz: { apiUrl: POSTIZ_URL, apiKey: 'smoke-fixture-key' },
  }));
});

afterAll(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

function runCli(args: string[], opts: { timeout?: number; env?: Record<string, string> } = {}) {
  const unexpectedCalls = resolve(workspace, 'tmp', 'unexpected-calls.log');
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--import', './smoke-network.mjs', 'src/cli.ts', ...args], {
    cwd: workspace,
    encoding: 'utf-8',
    timeout: opts.timeout ?? 15_000,
    // No inherited credentials, NODE_OPTIONS, .env, PATH tools, or service URLs.
    env: {
      PATH: resolve(workspace, 'smoke-bin'),
      NO_COLOR: '1',
      TZ: 'UTC',
      POSTIZ_API_URL: POSTIZ_URL,
      POSTIZ_API_KEY: '',
      AUDIOKIDS_OUTPUT_DIR: resolve(workspace, 'tests', 'fixtures', 'audiokids-output'),
      YOUTUBECLI_PATH: resolve(workspace, 'missing-youtubecli'),
      SMOKE_UNEXPECTED_CALLS: unexpectedCalls,
      ...(opts.env ?? {}),
    },
  });
  expect(result.error, `CLI failed to finish: ${args.join(' ')}\n${result.stderr}`).toBeUndefined();
  expect(result.signal, `CLI terminated: ${args.join(' ')}\n${result.stderr}`).toBeNull();
  expect(existsSync(unexpectedCalls) ? readFileSync(unexpectedCalls, 'utf-8') : '', 'unexpected network/media execution').toBe('');
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('CLI smoke: top-level --help', () => {
  it('lists every shipped subcommand', () => {
    const { stdout, status } = runCli(['--help']);
    expect(status).toBe(0);
    for (const cmd of ['publish', 'render', 'rss', 'decisions', 'status', 'integrations', 'dispatch', 'themes', 'gallery', 'adapters']) {
      expect(stdout).toContain(cmd);
    }
  });
});

describe('CLI smoke: adapters list', () => {
  it('returns at least the audiokids adapter as JSON', () => {
    const { stdout, status } = runCli(['adapters', 'list', '--json']);
    expect(status).toBe(0);
    const list = JSON.parse(stdout);
    expect(Array.isArray(list)).toBe(true);
    const audiokids = list.find((a: { name: string }) => a.name === 'audiokids');
    expect(audiokids).toBeDefined();
    expect(audiokids).toHaveProperty('description');
    expect(audiokids.candidateCount).toBe(1);
  });
});

describe('CLI smoke: publish accepts --bundle-file (no AudioKids needed)', () => {
  it('--dry-run accepts an inline bundle and returns a complete JSON report', () => {
    const bundlePath = resolve(workspace, 'tmp', 'smoke-inline-bundle.json');
    mkdirSync(resolve(workspace, 'tmp'), { recursive: true });
    const bundle = {
      id: 'smoke-inline-bundle',
      kind: 'audio-story',
      text: { title: 'inline test', body: 'érase una vez' },
      locale: 'es-ES',
    };
    writeFileSync(bundlePath, JSON.stringify(bundle));
    // We use spotify because preflight short-circuits it as 'skip' kind so we don't
    // need ffmpeg/whisper/hyperframes for this smoke test. The point is to prove
    // the inline-bundle path works; spotify exercises the orchestrator without rendering.
    const { stdout, status } = runCli([
      'publish',
      '--bundle-file', bundlePath,
      '--platforms', 'spotify',
      '--dry-run',
      '--skip-transcription',
      '--json',
    ], { timeout: 15_000 });
    expect(status).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.slug).toBe('smoke-inline-bundle');
    expect(report.results).toEqual([expect.objectContaining({ platform: 'spotify', success: true, skipped: true })]);
  });

  it('rejects when both --slug and --bundle-file are passed', () => {
    const { status, stderr } = runCli([
      'publish',
      '--slug', 'whatever',
      '--bundle-file', '/tmp/nope.json',
      '--platforms', 'spotify',
      '--dry-run',
    ]);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/either.*bundle.*or.*id|both/i);
  });
});

describe('CLI smoke: tenants list', () => {
  it('returns at least the default tenant as JSON', () => {
    const { stdout, status } = runCli(['tenants', 'list', '--json']);
    expect(status).toBe(0);
    const list = JSON.parse(stdout);
    expect(Array.isArray(list)).toBe(true);
    const def = list.find((t: { slug: string }) => t.slug === 'default');
    expect(def).toBeDefined();
    expect(def).toHaveProperty('dataDir');
    expect(def).toHaveProperty('postizApiUrl');
  });
});

describe('CLI smoke: publish --tenant isolates data dir', () => {
  it('records an RSS-only skip under data/<tenant>/decisions.jsonl', () => {
    const tenantSlug = 'smoke-tenant';
    const tenantDataDir = resolve(workspace, 'data', tenantSlug);
    const bundlePath = resolve(workspace, 'tmp', 'smoke-tenant-bundle.json');
    mkdirSync(resolve(workspace, 'tmp'), { recursive: true });
    writeFileSync(bundlePath, JSON.stringify({
      id: 'tenant-isolation-test',
      kind: 'text',
      text: { title: 'tenant test', body: 'aislamiento de datos' },
      locale: 'es',
    }));
    // Spotify is always a local preflight skip; this records a decision without
    // invoking a publisher, transcription, media tooling, or a remote service.
    const { status, stdout } = runCli([
      'publish',
      '--tenant', tenantSlug,
      '--bundle-file', bundlePath,
      '--platforms', 'spotify',
      '--json',
    ]);
    expect(status, stdout).toBe(0);
    expect(JSON.parse(stdout).results).toEqual([expect.objectContaining({ platform: 'spotify', success: true, skipped: true })]);
    const decisions = readFileSync(resolve(tenantDataDir, 'decisions.jsonl'), 'utf-8').trim().split('\n').map(line => JSON.parse(line));
    expect(decisions).toEqual([expect.objectContaining({ storySlug: 'tenant-isolation-test', platform: 'spotify' })]);
    expect(existsSync(resolve(workspace, 'data', 'decisions.jsonl'))).toBe(false);
  });

  it('dry-run succeeds without adding a publication to any decision log', () => {
    const bundlePath = resolve(workspace, 'tmp', 'dry-run-bundle.json');
    writeFileSync(bundlePath, JSON.stringify({
      id: 'dry-run-test', kind: 'text', text: { body: 'Publicación de prueba.' }, locale: 'es',
    }));
    const { stdout, stderr, status } = runCli([
      'publish', '--tenant', 'smoke-tenant', '--bundle-file', bundlePath,
      '--platforms', 'x', '--dry-run', '--json',
    ]);
    expect(status, stderr || stdout).toBe(0);
    expect(JSON.parse(stdout).results).toEqual([expect.objectContaining({ platform: 'x', success: true, skipped: true, reason: 'dry-run' })]);
    expect(existsSync(resolve(workspace, 'data', 'smoke-tenant', 'decisions.jsonl'))).toBe(false);
    expect(existsSync(resolve(workspace, 'data', 'decisions.jsonl'))).toBe(false);
  });
});

describe('CLI smoke: unknown tenant', () => {
  it('rejects an unconfigured tenant without creating its data directory', () => {
    const { status, stderr } = runCli(['dispatch', '--tenant', 'missing-tenant', '--dry-run', '--json']);
    expect(status).toBe(1);
    expect(stderr).toMatch(/missing-tenant/);
    expect(existsSync(resolve(workspace, 'data', 'missing-tenant'))).toBe(false);
  });
});

describe('CLI smoke: dispatch --adapter', () => {
  it('dispatches a fixture candidate and emits its rejected preflight as complete JSON', () => {
    const { stdout, status } = runCli([
      'dispatch',
      '--adapter', 'audiokids',
      '--platforms', 'x',
      '--dry-run',
      '--json',
    ], { timeout: 10_000 });
    expect(status).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed).toMatchObject({ dispatched: true, slug: 'dragon-marcos', adapter: 'audiokids', platforms: ['x'], tenant: 'default' });
    expect(parsed.report.results).toEqual([expect.objectContaining({
      platform: 'x', success: false, skipped: true, reason: expect.stringContaining('below minimum'),
    })]);
  });

  it('does not dispatch individual episodes to the RSS-only Spotify target', () => {
    const { stdout, status } = runCli(['dispatch', '--platforms', 'spotify', '--dry-run', '--json']);
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ dispatched: false, reason: 'nothing pending', tenant: 'default' });
  });

  it('exits non-zero with a clear error for an unknown adapter', () => {
    const { status, stderr, stdout } = runCli([
      'dispatch',
      '--adapter', 'no-such-adapter',
      '--platforms', 'tiktok',
      '--dry-run',
    ]);
    expect(status).not.toBe(0);
    expect(stderr + stdout).toMatch(/unknown adapter|no-such-adapter/);
  });
});

describe('CLI smoke: status --json', () => {
  it('returns deps array + system panel with tool/treatment/decision counts', () => {
    const { stdout, status } = runCli(['status', '--json']);
    expect(status).toBe(0);
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
    const { stdout, status } = runCli(['dispatch', '--platforms', 'tiktok', '--dry-run', '--json'], {
      env: { AUDIOKIDS_OUTPUT_DIR: resolve(workspace, 'empty-audiokids') },
    });
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ dispatched: false, reason: 'nothing pending', tenant: 'default' });
  });
});

describe('CLI smoke: rss produces valid XML', () => {
  it('writes a feed.xml to the requested path', () => {
    const out = resolve(workspace, 'tmp', 'smoke-feed.xml');
    const { status } = runCli(['rss', '--output', out]);
    expect(status).toBe(0);
    const xml = readFileSync(out, 'utf-8');
    expect(xml).toContain('<?xml');
    expect(xml).toContain('<rss');
    expect(xml).toContain('<guid isPermaLink="false">dragon-marcos</guid>');
    expect(xml).toContain('<itunes:duration>180</itunes:duration>');
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
    expect(report.ok).toBe(false);
    expect(status).toBe(1); // The fixture deliberately has no Postiz API key.
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
    const tmpFile = resolve(workspace, 'tmp', 'cta-ab-ingest-smoke.jsonl');
    mkdirSync(resolve(workspace, 'tmp'), { recursive: true });
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
    const tmpDir = resolve(workspace, 'tmp', 'stream-smoke');
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
    expect(status).toBe(0);

    const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
    expect(lines).toHaveLength(3);

    const parsed = lines.map(l => {
      try { return JSON.parse(l); } catch { return null; }
    });
    for (const p of parsed) {
      expect(p).not.toBeNull();
    }
    const stepLines = parsed.filter((p): p is { type: string } => !!p && (p as { type?: string }).type === 'step');
    expect(stepLines).toHaveLength(2);
    const summaryLines = parsed.filter((p): p is { type: string } => !!p && (p as { type?: string }).type === 'summary');
    expect(summaryLines).toEqual([expect.objectContaining({ ok: true, stepCount: 2 })]);
  });
});
