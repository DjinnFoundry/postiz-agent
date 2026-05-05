import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { config } from '../../config.js';
import { pruneRenderLogs } from '../housekeeping.js';
import { printJson } from '../io.js';
import { CliError } from '../errors.js';

/**
 * `logs`: inspect captured render stderr from data/render-logs (written
 * when a HyperFrames render/lint fails). Subcommand `logs prune` rotates
 * out old logs (default 30 days; env RENDER_LOGS_RETENTION_DAYS).
 */
export function register(program: Command): void {
  const logsCmd = program
    .command('logs')
    .description('Inspect captured render stderr from data/render-logs (written when a HyperFrames render/lint fails)')
    .option('-s, --slug <slug>', 'filter by story slug')
    .option('-p, --platform <platform>', 'filter by platform')
    .option('--tail', 'show only the most recent matching log (default prints every match listing)', false)
    .action((opts: { slug?: string; platform?: string; tail?: boolean }) => {
      const logDir = config.paths.renderLogsDir;
      if (!existsSync(logDir)) {
        console.log('no render logs yet');
        return;
      }
      let files = readdirSync(logDir).filter(f => f.endsWith('.log'));
      if (opts.slug) files = files.filter(f => f.startsWith(`${opts.slug}-`));
      if (opts.platform) files = files.filter(f => f.includes(`-${opts.platform}-`));
      files.sort();
      if (!files.length) {
        console.log('no matching render logs');
        return;
      }
      if (opts.tail) {
        const latest = files[files.length - 1];
        console.log(`=== ${latest} ===\n${readFileSync(join(logDir, latest), 'utf-8')}`);
        return;
      }
      for (const f of files) console.log(`${join(logDir, f)}`);
    });

  logsCmd
    .command('prune')
    .description('Delete render logs older than the retention window (default 30 days; env RENDER_LOGS_RETENTION_DAYS)')
    .option('--older-than-days <n>', 'override retention window in days')
    .option('--dry-run', 'report what would be deleted without removing files', false)
    .option('--json', 'emit machine-readable JSON', false)
    .addHelpText('after', `
Examples:
  postiz-agent logs prune --dry-run --json
  postiz-agent logs prune --older-than-days 7
`)
    .action(async (opts: { olderThanDays?: string; dryRun?: boolean; json?: boolean }) => {
      const days = opts.olderThanDays ? Number.parseInt(opts.olderThanDays, 10) : undefined;
      if (days !== undefined && (!Number.isFinite(days) || days < 0)) {
        throw new CliError(`invalid --older-than-days value: ${opts.olderThanDays}`);
      }
      const result = await pruneRenderLogs({ olderThanDays: days, dryRun: opts.dryRun });
      if (opts.json) {
        printJson(result);
      } else {
        const verb = result.dryRun ? 'would remove' : 'removed';
        console.log(`${verb} ${result.removed} log(s), kept ${result.kept}, freed ${result.bytesFreed} bytes from ${result.dir}`);
      }
      process.exit(0);
    });
}
