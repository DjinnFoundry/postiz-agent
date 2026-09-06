import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTenant } from '../../src/core/tenant.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tenant-config-mistakes-'));
  mkdirSync(join(root, 'tenants', 'brand'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
it.each([
  { postiz: { apiKye: 'must-not-appear-in-error' } },
  { postizz: { apiKey: 'must-not-appear-in-error' } },
  { youtubecli: { projectPath: '/other/account' } },
  { postiz: { integrationIds: { twitter: 'wrong-platform-key' } } },
])('rejects misspelled routing config without exposing values', (value) => {
  writeFileSync(join(root, 'tenants', 'brand', 'config.json'), JSON.stringify(value));
  expect(() => loadTenant('brand', { rootDir: root })).toThrow(/Invalid tenant.*config/);
  try { loadTenant('brand', { rootDir: root }); } catch (error) {
    expect(String(error)).not.toContain('must-not-appear-in-error');
  }
});
