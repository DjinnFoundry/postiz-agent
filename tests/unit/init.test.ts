import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInit, type Prompter } from '../../src/cli/init.js';

let scratchRoot: string;
beforeEach(() => { scratchRoot = mkdtempSync(join(tmpdir(), 'init-test-')); });
afterEach(() => { try { rmSync(scratchRoot, { recursive: true, force: true }); } catch {} });

function scriptedPrompter(answers: Record<string, string>): Prompter {
  return {
    async ask(_question, opts) {
      const key = opts?.key ?? '';
      const val = answers[key];
      if (val === undefined) return opts?.default ?? '';
      return val;
    },
  };
}

describe('runInit', () => {
  it('writes tenants/<slug>/config.json with the answers', async () => {
    const prompter = scriptedPrompter({
      slug: 'zetaread',
      brandName: 'ZetaRead',
      hashtags: 'booklovers, dailyread, reading',
      postizApiUrl: 'http://localhost:5000/public/v1',
      postizApiKey: 'sk-test',
      audiokidsDir: '/home/juan/zetaread/output',
    });
    const report = await runInit({ rootDir: scratchRoot, prompter });
    expect(report.ok).toBe(true);
    expect(report.tenantSlug).toBe('zetaread');
    expect(report.configPath).toBe(join(scratchRoot, 'tenants', 'zetaread', 'config.json'));

    const config = JSON.parse(readFileSync(report.configPath, 'utf-8'));
    expect(config.brand.name).toBe('ZetaRead');
    expect(config.brand.defaultHashtags).toEqual(['booklovers', 'dailyread', 'reading']);
    expect(config.postiz.apiUrl).toBe('http://localhost:5000/public/v1');
    expect(config.postiz.apiKey).toBe('sk-test');
    expect(config.audiokids.outputDir).toBe('/home/juan/zetaread/output');
  });

  it('also creates the tenant data dir', async () => {
    const prompter = scriptedPrompter({
      slug: 'newproduct',
      brandName: 'NewProduct',
      hashtags: '',
      postizApiUrl: 'http://localhost:5000/public/v1',
      postizApiKey: 'k',
      audiokidsDir: '/x',
    });
    await runInit({ rootDir: scratchRoot, prompter });
    expect(existsSync(join(scratchRoot, 'data', 'newproduct'))).toBe(true);
  });

  it('refuses to overwrite an existing tenant unless force is true', async () => {
    const prompter = scriptedPrompter({
      slug: 'existing',
      brandName: 'Existing',
      hashtags: '',
      postizApiUrl: 'u',
      postizApiKey: 'k',
      audiokidsDir: '/x',
    });
    const first = await runInit({ rootDir: scratchRoot, prompter });
    expect(first.ok).toBe(true);

    const second = await runInit({ rootDir: scratchRoot, prompter });
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/already exists/i);

    const forced = await runInit({ rootDir: scratchRoot, prompter, force: true });
    expect(forced.ok).toBe(true);
  });

  it('rejects invalid slugs', async () => {
    const prompter = scriptedPrompter({
      slug: '../etc',
      brandName: 'X',
      hashtags: '',
      postizApiUrl: 'u',
      postizApiKey: 'k',
      audiokidsDir: '/x',
    });
    const report = await runInit({ rootDir: scratchRoot, prompter });
    expect(report.ok).toBe(false);
    expect(report.error).toMatch(/invalid.*slug/i);
  });

  it('honors initial answers (non-interactive batch mode)', async () => {
    const report = await runInit({
      rootDir: scratchRoot,
      // No prompter; answers passed directly.
      answers: {
        slug: 'batch',
        brandName: 'BatchBrand',
        hashtags: 'one, two',
        postizApiUrl: 'http://x',
        postizApiKey: 'kkk',
        audiokidsDir: '/x',
      },
    });
    expect(report.ok).toBe(true);
    const config = JSON.parse(readFileSync(report.configPath, 'utf-8'));
    expect(config.brand.name).toBe('BatchBrand');
  });

  it('emits a summary listing the next-step commands', async () => {
    const lines: string[] = [];
    const prompter = scriptedPrompter({
      slug: 'demo', brandName: 'Demo', hashtags: '', postizApiUrl: 'u', postizApiKey: 'k', audiokidsDir: '/x',
    });
    await runInit({ rootDir: scratchRoot, prompter, writer: (s) => lines.push(s) });
    const out = lines.join('\n');
    expect(out).toMatch(/doctor --tenant demo/);
    expect(out).toMatch(/dispatch --tenant demo/);
  });

  it('skips empty hashtags and produces no defaultHashtags key', async () => {
    const prompter = scriptedPrompter({
      slug: 'nohash',
      brandName: 'X',
      hashtags: '',
      postizApiUrl: 'u',
      postizApiKey: 'k',
      audiokidsDir: '/x',
    });
    const report = await runInit({ rootDir: scratchRoot, prompter });
    const config = JSON.parse(readFileSync(report.configPath, 'utf-8'));
    expect(config.brand?.defaultHashtags).toBeUndefined();
  });
});
