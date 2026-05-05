import { spawn, type SpawnOptions } from 'node:child_process';

export interface RunResult {
  stdout: string;
  stderr: string;
}

export interface RunOptions extends SpawnOptions {
  /** Write this string to the child's stdin and close it. */
  stdin?: string;
}

/**
 * Thrown when the spawned process exits non-zero. Carries the full captured
 * stdout/stderr (not just the truncated tail in `message`) so callers writing
 * a render log can persist the complete output for post-mortem.
 */
export class ProcessExitError extends Error {
  override readonly name = 'ProcessExitError';
  constructor(
    readonly cmd: string,
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(formatExitMessage(cmd, args, exitCode, stdout, stderr));
  }
}

function formatExitMessage(
  cmd: string,
  args: readonly string[],
  exitCode: number | null,
  stdout: string,
  stderr: string,
): string {
  // Many CLI tools (notably hyperframes lint) write their diagnostics to stdout, not
  // stderr; npm noise tends to show up in stderr. Surface whichever stream actually
  // carried text, preferring stdout when both have content because that is where
  // the real, actionable error usually lives.
  const out = stdout.trim();
  const err = stderr.trim();
  const tail = (s: string) => (s.length > 600 ? `…${s.slice(-600)}` : s);
  const suffix = out
    ? `\n--- stdout ---\n${tail(out)}${err ? `\n--- stderr ---\n${tail(err)}` : ''}`
    : err
      ? `\n--- stderr ---\n${tail(err)}`
      : '';
  return `${cmd} ${args.join(' ')} exited ${exitCode}${suffix}`;
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const { stdin, ...spawnOpts } = opts;
  const stdinMode = stdin !== undefined ? 'pipe' : 'ignore';
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: [stdinMode, 'pipe', 'pipe'], ...spawnOpts });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', d => { stdout += d.toString(); });
    proc.stderr?.on('data', d => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new ProcessExitError(cmd, args, code, stdout, stderr));
    });
    if (stdin !== undefined && proc.stdin) {
      proc.stdin.on('error', reject);
      proc.stdin.write(stdin);
      proc.stdin.end();
    }
  });
}
