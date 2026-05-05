import type { Command } from 'commander';
import { runDoctor, formatDoctorReport } from '../doctor.js';
import { buildTenantBundle } from '../tenant-context.js';
import { printJsonOrHuman } from '../io.js';

/**
 * `doctor`: deep diagnostic. Groups every signal an autonomous agent needs
 * to self-triage into one report (env, postiz integrations, audiokids dir,
 * stuck slugs, recent failures, upload-cache, theme-decisions). Exits 1
 * on any blocking section so cron / CI can gate on it.
 */
export function register(program: Command): void {
  program
    .command('doctor')
    .description('Deep diagnostic: integrations, stuck slugs, recent failures, caches. Prints remediation hints.')
    .option('-t, --tenant <slug>', 'tenant slug (each tenant has its own decisions log + caches)', 'default')
    .option('--json', 'emit the full report as JSON (one object on stdout)', false)
    .addHelpText('after', `
Groups every signal an autonomous agent needs to self-triage into one command:
environment, postiz, audiokids, stuck-slugs, recent-failures, upload-cache,
theme-decisions. Exit 1 when any section reports a blocking issue (permanent,
needs-config, needs-human) or when >0 stuck slugs are detected.
`)
    .action(async (opts: { tenant: string; json?: boolean }) => {
      const ctx = buildTenantBundle(opts.tenant);
      const summaries = ctx.summaries();
      const report = await runDoctor({
        decisions: ctx.decisions.list(),
        audiokidsDir: ctx.tenant.audiokids.outputDir,
        postizApiKey: ctx.tenant.postiz.apiKey,
        listIntegrations: () => ctx.postiz().listIntegrations(),
        uploadCache: summaries.uploadCache,
        themeDecisions: summaries.themeDecisions,
      });
      printJsonOrHuman(opts.json, report, () => formatDoctorReport(report), { pretty: true });
      process.exit(report.ok ? 0 : 1);
    });
}
