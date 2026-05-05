import type { Command } from 'commander';
import { runStats, formatStatsReport } from '../stats.js';
import { buildTenantBundle } from '../tenant-context.js';
import { PlatformSchema } from '../../types.js';
import { printJsonOrHuman } from '../io.js';

/**
 * `stats`: rollup of the decision log over a window. Per-platform success
 * rate, top remediations, top stuck slugs, CTA variant distribution. Always
 * exits 0 — read-only digest.
 */
export function register(program: Command): void {
  program
    .command('stats')
    .description('Roll up the decision log: success rate, top remediations, stuck slugs, CTA variants.')
    .option('-t, --tenant <slug>', 'tenant slug (rolls up that tenant\'s decisions log)', 'default')
    .option('--days <n>', 'window in days', '30')
    .option('--platform <platform>', 'filter to a single platform (x, tiktok, instagram, youtube, spotify)')
    .option('--json', 'emit the report as JSON', false)
    .addHelpText('after', `
Read-only digest for a quick operational pulse. Always exits 0.
`)
    .action(async (opts: { tenant: string; days?: string; platform?: string; json?: boolean }) => {
      const days = opts.days ? Number.parseInt(opts.days, 10) : 30;
      if (!Number.isFinite(days) || days <= 0) {
        console.error(`invalid --days value: ${opts.days}`);
        process.exit(1);
      }
      const platform = opts.platform ? PlatformSchema.parse(opts.platform) : undefined;
      const ctx = buildTenantBundle(opts.tenant);
      const report = await runStats({ days, platform, decisions: ctx.decisions.list() });
      printJsonOrHuman(opts.json, report, () => formatStatsReport(report), { pretty: true });
      process.exit(0);
    });
}
