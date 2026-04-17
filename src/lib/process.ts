import { spawn, type SpawnOptions } from 'node:child_process';

export interface RunResult {
  stdout: string;
  stderr: string;
}

export interface RunOptions extends SpawnOptions {
  /** Write this string to the child's stdin and close it. */
  stdin?: string;
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
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${stderr.slice(-400)}`));
    });
    if (stdin !== undefined && proc.stdin) {
      proc.stdin.on('error', reject);
      proc.stdin.write(stdin);
      proc.stdin.end();
    }
  });
}
