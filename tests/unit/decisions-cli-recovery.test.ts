import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { register } from '../../src/cli/commands/decisions.js';
import { config } from '../../src/config.js';
import { DecisionLog } from '../../src/decisions/log.js';
import { findStuckSlugs } from '../../src/dispatch.js';
import * as io from '../../src/cli/io.js';

describe('decisions CLI recovery across archives and tenants', () => {
  let dir: string;
  let originalRoot: string;
  let log: DecisionLog;
  let output: string[];
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'decisions-cli-'));
    originalRoot = config.paths.projectRoot;
    config.paths.projectRoot = dir;
    mkdirSync(join(dir, 'tenants', 'brand'), { recursive: true });
    writeFileSync(join(dir, 'tenants', 'brand', 'config.json'), '{}');
    log = new DecisionLog(join(dir, 'data', 'brand', 'decisions.jsonl'));
    await log.record({ action: 'publish.x', storySlug: 'story', platform: 'x', reason: 'test', result: {
      platform: 'x', success: false, errorClass: 'needs-human', timestamp: new Date().toISOString(),
      remediation: { action: 'reconcile-post', humanHint: 'Check the remote post' },
    } });
    log.rotate();
    output = [];
    vi.spyOn(console, 'log').mockImplementation(value => { output.push(String(value)); });
    vi.spyOn(io, 'printJson').mockImplementation(value => { output.push(JSON.stringify(value)); });
  });
  afterEach(() => { config.paths.projectRoot = originalRoot; vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

  async function command(...args: string[]) {
    const program = new Command();
    register(program);
    await program.parseAsync(['node', 'test', 'decisions', '--tenant', 'brand', ...args]);
  }

  it('shows an unresolved archived publication in --stuck', async () => {
    await command('--stuck', '--json');
    expect(JSON.parse(output.at(-1)!)).toEqual([expect.objectContaining({ slug: 'story', reason: 'publication-outcome-unknown' })]);
  });

  it('resets attempts for a platform whose only decisions are archived', async () => {
    await command('--reset-attempts', 'story');
    expect(JSON.parse(output.at(-1)!)).toHaveProperty('platforms', ['x']);
    expect(findStuckSlugs(log.list({ includeArchives: true }), ['x'])).toEqual([]);
  });

  it('resets only the selected platform and preserves another uncertain publication', async () => {
    await log.record({ action: 'publish.instagram', storySlug: 'story', platform: 'instagram', reason: 'test', result: {
      platform: 'instagram', success: false, errorClass: 'needs-human', timestamp: new Date().toISOString(),
      remediation: { action: 'reconcile-post', humanHint: 'Check Instagram before retrying' },
    } });
    await command('--reset-attempts', 'story', '--platform', 'x');
    expect(JSON.parse(output.at(-1)!)).toHaveProperty('platforms', ['x']);
    expect(findStuckSlugs(log.list({ includeArchives: true }), ['x', 'instagram']))
      .toEqual([expect.objectContaining({ platform: 'instagram', reason: 'publication-outcome-unknown' })]);
  });

  it.each(['twitter', ''])('rejects an invalid platform filter %j before resetting anything', async platform => {
    await expect(command('--reset-attempts', 'story', '--platform', platform)).rejects.toThrow();
    expect(log.list({ includeArchives: true }).filter(entry => entry.action.startsWith('reset-attempts.'))).toEqual([]);
  });

  it('finds archived history in the ordinary decision query', async () => {
    await command('--slug', 'story');
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0])).toHaveProperty('storySlug', 'story');
  });

  it('lists only the selected tenant archives', async () => {
    await command('archives', '--json');
    const archives = JSON.parse(output.at(-1)!);
    expect(archives).toHaveLength(1);
    expect(archives[0].path).toContain(join('data', 'brand'));
  });

  it('rotates the selected tenant without touching the default log', async () => {
    const defaultLog = new DecisionLog();
    const params = { action: 'publish.x', storySlug: 'story', platform: 'x' as const, reason: 'test', result: { platform: 'x' as const, success: true, timestamp: new Date().toISOString() } };
    await defaultLog.record(params);
    await log.record(params);
    await command('rotate', '--force', '--json');
    expect(existsSync(join(dir, 'data', 'brand', 'decisions.jsonl'))).toBe(false);
    expect(existsSync(join(dir, 'data', 'decisions.jsonl'))).toBe(true);
  });
});
