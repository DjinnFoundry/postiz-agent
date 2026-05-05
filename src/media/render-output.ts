import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { probeDurationSec } from '../lib/ffprobe.js';
import { ProcessExitError } from '../lib/process.js';

export const MIN_VALID_MP4_BYTES = 100 * 1024;

export function assertValidMp4(path: string): void {
  if (!existsSync(path)) throw new Error(`rendered MP4 missing: ${path}`);
  const stat = statSync(path);
  if (stat.size < MIN_VALID_MP4_BYTES) {
    throw new Error(`rendered MP4 too small (${stat.size} bytes); minimum ${MIN_VALID_MP4_BYTES}. Likely corrupt or empty.`);
  }
}

export async function finalizeRender(renderedPath: string, outputPath: string): Promise<void> {
  mkdirSync(dirname(outputPath), { recursive: true });
  const tmpPath = `${outputPath}.tmp`;
  copyFileSync(renderedPath, tmpPath);
  try {
    assertValidMp4(tmpPath);
    const duration = await probeDurationSec(tmpPath);
    if (!(duration > 0)) {
      throw new Error(`rendered MP4 reports duration=${duration}s; treated as corrupt`);
    }
    renameSync(tmpPath, outputPath);
  } catch (err) {
    try { rmSync(tmpPath, { force: true }); } catch { /* noop */ }
    throw err;
  }
}

export function persistStderr(err: unknown, logFile: string): void {
  const payload = formatRenderLog(err);
  try {
    writeFileSync(logFile, payload);
    console.error(`  render log written to ${logFile}`);
  } catch {
    /* logging the logger is a lost cause */
  }
}

function formatRenderLog(err: unknown): string {
  if (err instanceof ProcessExitError) {
    return [
      `${err.name}: ${err.cmd} ${err.args.join(' ')} exited ${err.exitCode}`,
      '',
      '=== stdout ===',
      err.stdout || '(empty)',
      '',
      '=== stderr ===',
      err.stderr || '(empty)',
      '',
      err.stack ?? '',
    ].join('\n');
  }
  if (err instanceof Error) {
    return `${err.name}: ${err.message}\n${err.stack ?? ''}\n`;
  }
  return String(err);
}
