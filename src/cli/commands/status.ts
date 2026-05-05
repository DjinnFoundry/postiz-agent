import type { Command } from 'commander';
import { runStatus, formatStatusReport } from '../status.js';
import { buildTenantBundle } from '../tenant-context.js';

/**
 * `status`: shallow environment health check. Verifies the binaries, the
 * audiokids dir, the Postiz reachability, and surfaces tenant-scoped counts
 * (decisions, uploads, theme decisions, stuck slugs, 7d success rate).
 */
export function register(program: Command): void {
  program
    .command('status')
    .description('Check environment health: tools installed, services reachable, dirs exist')
    .option('-t, --tenant <slug>', 'tenant slug (decisions/uploads/theme counts come from this tenant)', 'default')
    .option('--json', 'emit machine-readable JSON', false)
    .option('--strict', 'fail (exit 1) on any warning, including disabled integrations', false)
    .addHelpText('after', `
Run this first before a publish to catch config errors early.
Checks: ffmpeg, whisper, hyperframes CLI, Postiz API, AudioKids output dir,
and each Postiz integration for X/TikTok/Instagram/YouTube (warns if disabled
or missing — reconnect via the Postiz UI when that happens).

Exit codes:
  0 → no required check failed (default)
  1 → at least one required check failed, OR any warning fired with --strict
`)
    .action(async (opts) => {
      const ctx = buildTenantBundle(opts.tenant);
      const summaries = ctx.summaries();
      const report = await runStatus({
        decisions: ctx.decisions.list(),
        audiokidsDir: ctx.tenant.audiokids.outputDir,
        postizApiKey: ctx.tenant.postiz.apiKey,
        listIntegrations: () => ctx.postiz().listIntegrations(),
        uploadCache: summaries.uploadCache,
        themeDecisions: summaries.themeDecisions,
      });
      if (opts.json) process.stdout.write(formatStatusReport(report, 'json') + '\n');
      else console.log(formatStatusReport(report, 'human'));

      const failedRequired = report.deps.filter(c => c.required && !c.ok);
      const warnings = report.deps.filter(c => !c.ok && c.warning);
      if (failedRequired.length > 0) process.exit(1);
      if (opts.strict && warnings.length > 0) process.exit(1);
      process.exit(0);
    });
}
