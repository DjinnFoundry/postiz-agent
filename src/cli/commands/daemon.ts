import type { Command } from 'commander';
import { Option } from 'commander';
import { runDaemon } from '../daemon.js';
import { parsePlatforms } from '../runner.js';

/**
 * `daemon`: long-running heartbeat loop. Every interval, dispatch the next
 * pending bundle for the chosen tenant. Suitable for systemd / launchd /
 * docker. Stops cleanly on SIGINT / SIGTERM. Per-iteration failures log
 * and continue (transient blips do not kill the daemon).
 */
export function register(program: Command): void {
  program
    .command('daemon')
    .description('Long-running heartbeat: every interval, dispatch the next pending bundle for one tenant.')
    .option('-t, --tenant <slug>', 'tenant slug', 'default')
    .addOption(
      new Option('-p, --platforms <list>', 'comma-separated platforms')
        .default('x,tiktok,instagram,youtube'),
    )
    .option('--interval-minutes <n>', 'minutes between heartbeats (default: 60)', '60')
    .option('--max-iterations <n>', 'stop after N iterations (default: forever). Useful for cron-driven supervisors.')
    .addHelpText('after', `
Suitable for systemd / launchd / docker. Stops cleanly on SIGINT / SIGTERM.
On any per-iteration failure, logs the error and keeps going (transient
network blips should not kill the daemon).

Examples:
  postiz-agent daemon --tenant audiokids --interval-minutes 60
  postiz-agent daemon --tenant zetaread --platforms x,instagram --interval-minutes 240
`)
    .action(async (opts: { tenant: string; platforms: string; intervalMinutes: string; maxIterations?: string }) => {
      const platforms = parsePlatforms(opts.platforms);
      const intervalMs = Math.max(1, Number.parseInt(opts.intervalMinutes, 10) || 60) * 60_000;
      const maxIterations = opts.maxIterations ? Math.max(1, Number.parseInt(opts.maxIterations, 10) || 0) : undefined;

      let stopRequested = false;
      const onStop = () => { stopRequested = true; };
      process.on('SIGINT', onStop);
      process.on('SIGTERM', onStop);

      await runDaemon({
        tenant: opts.tenant,
        platforms,
        intervalMs,
        ...(maxIterations !== undefined ? { maxIterations } : {}),
        shouldStop: () => stopRequested,
      });
    });
}
