import type { Command } from 'commander';
import { runCtaAb, formatCtaAbReport } from '../cta-ab.js';
import { buildTenantBundle } from '../tenant-context.js';
import { PlatformSchema } from '../../types.js';

/**
 * `cta-ab`: zoom into CTA variant performance. Per variant: uses, success rate,
 * sample URLs. With --ingest <file.jsonl>, layer engagement metrics on top.
 * Read-only, always exits 0.
 */
export function register(program: Command): void {
  program
    .command('cta-ab')
    .description('Per-CTA-variant mini report: uses, success rate, sample urls. Read-only.')
    .option('--days <n>', 'window in days', '30')
    .option('--platform <platform>', 'filter to a single platform (x, tiktok, instagram, youtube)')
    .option('--json', 'emit the report as JSON', false)
    .option('--ingest <file>', 'JSONL engagement file {postId, platform, engagement, recordedAt}; merges avg views/likes/comments per variant')
    .option('-t, --tenant <slug>', 'tenant slug (rolls up that tenant\'s decisions log)', 'default')
    .addHelpText('after', `
Complements 'stats' by zooming into CTA variant performance. Each variant shows
uses in the window (success + failed), success rate, and the first 3 post URLs
so you can open the winners and losers in a browser. Always exits 0.

With --ingest <file.jsonl>, each line {postId, platform, engagement, recordedAt}
is joined against the decision log (via result.postId) and averaged into the
matching CTA variant as avgEngagement {avgViews, avgLikes, avgComments,
avgShares, sampleSize}. Records whose postId is not in the log are skipped with
a warning; malformed JSONL lines are skipped, remaining lines still process.
`)
    .action(async (opts: { tenant: string; days?: string; platform?: string; json?: boolean; ingest?: string }) => {
      const days = opts.days ? Number.parseInt(opts.days, 10) : 30;
      if (!Number.isFinite(days) || days <= 0) {
        console.error(`invalid --days value: ${opts.days}`);
        process.exit(1);
      }
      const platform = opts.platform ? PlatformSchema.parse(opts.platform) : undefined;
      const ctx = buildTenantBundle(opts.tenant);
      const report = await runCtaAb({ days, platform, ingestFile: opts.ingest, decisions: ctx.decisions.list() });
      if (opts.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      else console.log(formatCtaAbReport(report));
      process.exit(0);
    });
}
