import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { assertSafeBundlePath } from '../../src/lib/safe-path.js';
import { config } from '../../src/config.js';

describe('assertSafeBundlePath', () => {
  it('accepts a path under projectRoot', () => {
    const p = join(config.paths.projectRoot, 'tmp', 'bundle.json');
    expect(() => assertSafeBundlePath(p)).not.toThrow();
  });

  it('accepts a path under audiokids.outputDir', () => {
    const p = join(config.audiokids.outputDir, 'some-slug.json');
    expect(() => assertSafeBundlePath(p)).not.toThrow();
  });

  it('accepts a path under the user home directory', () => {
    const p = join(homedir(), 'bundle.json');
    expect(() => assertSafeBundlePath(p)).not.toThrow();
  });

  it('resolves relative paths against cwd and accepts when they fall under projectRoot', () => {
    // When tests run, cwd is the projectRoot; a bare filename resolves under it.
    expect(() => assertSafeBundlePath('package.json')).not.toThrow();
  });

  it('rejects /etc/passwd', () => {
    expect(() => assertSafeBundlePath('/etc/passwd')).toThrow(/bundle-file must live under/);
  });

  it('rejects a traversal sequence that resolves outside the allowed roots', () => {
    // Craft a deeply nested relative path that post-resolve escapes projectRoot.
    const dir = mkdtempSync(join(tmpdir(), 'postiz-agent-safe-path-'));
    // /tmp is not under projectRoot/audiokids/home unless the test runner's tmpdir is.
    try {
      const traversalTarget = resolve(dir, '..', '..', '..', '..', 'etc', 'passwd');
      // Only meaningful if that resolved path truly lies outside the roots.
      // If homedir() happens to contain it, skip the assertion.
      const home = homedir();
      const root = config.paths.projectRoot;
      const out = config.audiokids.outputDir;
      const outsideAll =
        !traversalTarget.startsWith(home + '/') && traversalTarget !== home &&
        !traversalTarget.startsWith(root + '/') && traversalTarget !== root &&
        !traversalTarget.startsWith(out + '/') && traversalTarget !== out;
      if (outsideAll) {
        expect(() => assertSafeBundlePath(traversalTarget)).toThrow(/bundle-file must live under/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('error message includes the refused path', () => {
    try {
      assertSafeBundlePath('/etc/passwd');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('/etc/passwd');
    }
  });

  it('accepts a real file placed under projectRoot', () => {
    const file = join(config.paths.projectRoot, 'tmp', `safe-path-probe-${Date.now()}.json`);
    writeFileSync(file, '{}', 'utf-8');
    try {
      expect(() => assertSafeBundlePath(file)).not.toThrow();
    } finally {
      rmSync(file, { force: true });
    }
  });
});
