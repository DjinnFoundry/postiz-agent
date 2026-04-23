import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { config } from '../config.js';

/**
 * A user-supplied bundle-file path must live under one of the trusted roots,
 * otherwise an attacker could point the CLI at /etc/passwd or any arbitrary
 * JSON file on disk and trick the agent into loading it as a ContentBundle.
 */
export function assertSafeBundlePath(inputPath: string): string {
  const abs = resolve(inputPath);
  const roots = [
    config.paths.projectRoot,
    config.audiokids.outputDir,
    homedir(),
  ];
  for (const root of roots) {
    if (abs === root || abs.startsWith(root + '/')) return abs;
  }
  throw new Error(
    `bundle-file must live under projectRoot, audiokids output, or home. Refused: ${inputPath}`,
  );
}
