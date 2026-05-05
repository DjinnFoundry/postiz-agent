import type { Command } from 'commander';
import { Option } from 'commander';
import { Orchestrator } from '../../orchestrator.js';
import { selectNextStory } from '../../dispatch.js';
import { buildTenantBundle } from '../tenant-context.js';
import { brandFromTenant } from '../../copy/brand.js';
import { DEFAULT_ADAPTER } from '../../adapters/registry.js';
import { parsePlatforms } from '../runner.js';
import { printJson } from '../io.js';
import { CliError } from '../errors.js';

/**
 * `dispatch`: cron entry point. Walks the chosen adapter, consults the
 * decision log, and picks the OLDEST candidate that does NOT yet have a
 * successful publish in the last 30 days on ALL requested platforms. Exits
 * 0 with a "nothing pending" payload when no work is found, so it is safe
 * to run more often than the content cadence.
 */
export function register(program: Command): void {
  program
    .command('dispatch')
    .description('Autonomously pick the next bundle to publish and run it. Cron-safe.')
    .option('-t, --tenant <slug>', 'tenant slug', 'default')
    .addOption(
      new Option('-p, --platforms <list>', 'comma-separated target platforms')
        .default('x,tiktok,instagram,youtube'),
    )
    .option('-a, --adapter <name>', `BundleAdapter to walk for candidates (default: ${DEFAULT_ADAPTER})`, DEFAULT_ADAPTER)
    .option('--dry-run', 'resolve the next id and render videos, but do not upload', false)
    .option('--json', 'emit machine-readable JSON on stdout (nothing else)', false)
    .option('--reason <text>', 'reason recorded in the decision log', 'scheduled autonomous dispatch')
    .addHelpText('after', `
Walks the chosen BundleAdapter for candidates, consults the decision log, and
picks the OLDEST one that does NOT yet have a successful publish in the last
30 days on ALL of the requested platforms. Exits 0 with {"dispatched": false,
"reason": "nothing pending"} when nothing is to be done. Cron-safe.

Examples:
  postiz-agent dispatch --json
  postiz-agent dispatch --platforms tiktok,instagram
  postiz-agent dispatch --adapter audiokids --dry-run
`)
    .action(async (opts) => {
      const platforms = parsePlatforms(opts.platforms);
      const ctx = buildTenantBundle(opts.tenant);
      const log = ctx.decisions.list();
      if (!ctx.adapters.has(opts.adapter)) {
        throw new CliError(`unknown adapter "${opts.adapter}". Known: ${ctx.adapters.names().join(', ')}`);
      }
      const adapter = ctx.adapters.get(opts.adapter);
      const candidates = adapter.listCandidates().map(c => ({ slug: c.id, generatedAtMs: c.generatedAtMs }));
      const slug = selectNextStory(candidates, log, platforms);
      if (!slug) {
        const payload = { dispatched: false, reason: 'nothing pending', tenant: opts.tenant };
        if (opts.json) printJson(payload);
        else console.log('nothing pending');
        process.exit(0);
      }
      if (opts.json) printJson({ dispatched: true, slug, adapter: opts.adapter, platforms, tenant: opts.tenant });
      else console.log(`dispatching ${slug} (tenant=${opts.tenant}, adapter=${opts.adapter}) → ${platforms.join(',')}`);

      const orch = new Orchestrator({ adapters: ctx.adapters, decisions: ctx.decisions });
      const brand = brandFromTenant(ctx.tenant);
      const report = await orch.publish({
        id: slug,
        adapter: opts.adapter,
        platforms,
        dryRun: opts.dryRun,
        reason: opts.reason,
        brand,
      });
      if (!opts.json) console.log('\n' + JSON.stringify(report, null, 2));
      if (report.fatalCaptionFailure) process.exit(1);
      process.exit(report.results.every(r => r.success) ? 0 : 1);
    });
}
