import { resolve } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { config } from '../config.js';

/**
 * A user-supplied bundle-file path must live under one of the trusted roots,
 * otherwise an attacker could point the CLI at /etc/passwd or any arbitrary
 * JSON file on disk and trick the agent into loading it as a ContentBundle.
 *
 * Trusted roots:
 *  - the repo root (so dev fixtures work)
 *  - the AudioKids output dir (the canonical adapter source)
 *  - the user's home directory (where most ad-hoc files live)
 *  - the OS temp dir AND /tmp (where external agents naturally drop short-lived
 *    bundles; on macOS these are different locations behind symlinks, so we
 *    accept both forms)
 *  - any colon-separated path in POSTIZ_AGENT_BUNDLE_DIRS (operator escape hatch)
 *
 * Symlinks are resolved on both the input path and the trusted roots before
 * comparison, so /tmp (symlink) and /private/tmp (real path) on macOS both work.
 */
export function assertSafeBundlePath(inputPath: string): string {
  const abs = resolve(inputPath);
  const absReal = canonicalise(abs);

  const rawRoots = [
    config.paths.projectRoot,
    config.audiokids.outputDir,
    homedir(),
    tmpdir(),
    '/tmp',
    ...((process.env.POSTIZ_AGENT_BUNDLE_DIRS ?? '')
      .split(':')
      .map(s => s.trim())
      .filter(Boolean)),
  ];
  const roots = rawRoots.map(r => canonicalise(resolve(r)));

  for (const root of roots) {
    if (absReal === root || absReal.startsWith(root + '/')) return abs;
  }
  throw new Error(
    `bundle-file must live under projectRoot, audiokids output, home, tmpdir, ` +
    `or a path in POSTIZ_AGENT_BUNDLE_DIRS. Refused: ${inputPath}`,
  );
}

/** Resolve symlinks when possible, fall back to the raw path when the file
 *  does not exist (input may be a path the caller is about to create). */
function canonicalise(p: string): string {
  return existsSync(p) ? realpathSync(p) : p;
}
