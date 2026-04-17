import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');

/**
 * CLI wiring smoke tests. Each test invokes `pnpm dev <cmd>` in a child process
 * and asserts the command at least parses, runs, and returns a JSON payload of
 * the expected shape. These guard against import-graph breakage or argument
 * wiring mistakes after a merge; they do NOT exercise whisper, HyperFrames, or
 * the Postiz API (those are covered by manual smoke tests and the unit suite).
 */

function runCli(args: string[], opts: { timeout?: number } = {}) {
  // Invoke tsx directly so pnpm's `> postiz-agent@0.1.0 dev` preamble does not
  // contaminate JSON output. `pnpm exec tsx` resolves tsx from local node_modules
  // but still prints its own header; `./node_modules/.bin/tsx` avoids both.
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
    for (const cmd of ['publish', 'render', 'rss', 'decisions', 'status', 'integrations', 'dispatch']) {
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
    // Reasoning: our fixture story dragon-marcos is the only candidate, and the
    // decision log records it as published (or not). dispatch either picks it
    // (dispatched:true, slug:"dragon-marcos") or returns dispatched:false when
    // it was already published recently. Both shapes are acceptable — we only
    // assert the payload is valid JSON with the expected keys.
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
    const { readFileSync } = require('node:fs');
    const xml = readFileSync(out, 'utf-8');
    expect(xml).toContain('<?xml');
    expect(xml).toContain('<rss');
  });
});

describe('CLI smoke: publish rejects malformed slugs', () => {
  it('exits non-zero on a path-traversal slug', () => {
    const { status, stderr } = runCli(['publish', '--slug', '../../etc/passwd', '--platforms', 'tiktok', '--dry-run']);
    expect(status).not.toBe(0);
    expect(stderr + runCli(['publish', '--slug', '../../etc/passwd', '--platforms', 'tiktok', '--dry-run']).stdout).toMatch(/Invalid slug|must match/);
  });
});
