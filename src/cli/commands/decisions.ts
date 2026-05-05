import type { Command } from 'commander';
import { DecisionLog } from '../../decisions/log.js';
import { findStuckSlugs } from '../../dispatch.js';
import { loadTenant } from '../../core/tenant.js';
import { validateSlug } from '../../lib/slug.js';
import { PlatformSchema, type Platform } from '../../types.js';
import { formatStuckTable } from '../runner.js';

/**
 * `decisions`: read-side queries of data/decisions.jsonl. Three modes:
 *   - --reset-attempts <slug>: write a marker so dispatch's stuck-slug guard
 *     forgives historical permanent failures for that (slug, platform) pair.
 *   - --stuck: print slugs currently blocked (too many failures or in backoff).
 *   - default: stream every matching decision entry as JSON.
 *
 * Subcommands `decisions rotate` / `decisions archives` manage the on-disk
 * log files (10 MiB rolling rotation) without going through the CLI options.
 */
export function register(program: Command): void {
  const decisions = program
    .command('decisions')
    .description('Query the JSONL decision log (every publish attempt, with reason and outcome)')
    .option('-t, --tenant <slug>', 'tenant slug', 'default')
    .option('-s, --slug <slug>', 'filter by story slug')
    .option('-p, --platform <platform>', 'filter by platform (x, tiktok, instagram, youtube, spotify)')
    .option('--run-id <uuid>', 'filter by the runId returned by a specific publish() call')
    .option('--pretty', 'pretty-print with 2-space indent', false)
    .option('--json', 'force JSON output (default for non-stuck queries; tabular for --stuck)', false)
    .option('--stuck', 'list slugs currently blocked by repeated failures or active backoff', false)
    .option('--reset-attempts <slug>', 'record a reset marker so <slug> is no longer considered stuck')
    .addHelpText('after', `
Decisions are appended to data/decisions.jsonl on every publish or render. Each
entry records: action, reason, storySlug, platform, result (post id / url / error
+ errorClass + remediation), and createdAt. Useful for agent memory across runs —
"did yesterday's tiktok post succeed?" is a single grep, not a re-check of a
platform API.

Examples:
  postiz-agent decisions                                     # everything
  postiz-agent decisions --slug dragon-marcos                # one story, every platform
  postiz-agent decisions --platform x                        # all X history
  postiz-agent decisions --run-id <uuid>                     # every entry from one publish() run
  postiz-agent decisions --stuck                             # what's blocked right now
  postiz-agent decisions --reset-attempts dragon-marcos      # unstuck a slug after fixing it
`)
    .action(async (opts) => {
      const tenant = loadTenant(opts.tenant);
      const log = new DecisionLog(tenant.paths.decisionsLog);

      if (opts.resetAttempts) {
        const slug = validateSlug(opts.resetAttempts);
        const history = log.list({ storySlug: slug });
        const platforms = new Set<Platform>(history.map(h => h.platform));
        const ts = new Date().toISOString();
        for (const platform of platforms) {
          await log.record({
            action: `reset-attempts.${platform}`,
            storySlug: slug,
            platform,
            reason: 'manual reset via --reset-attempts',
            result: { platform, success: true, skipped: true, reason: 'reset-attempts', timestamp: ts },
          });
        }
        console.log(JSON.stringify({ ok: true, resetSlug: slug, platforms: [...platforms] }));
        return;
      }

      if (opts.stuck) {
        const all = log.list({});
        const platforms = (Object.values(PlatformSchema.enum)) as Platform[];
        const stuck = findStuckSlugs(all, platforms);
        if (opts.json) process.stdout.write(JSON.stringify(stuck) + '\n');
        else if (opts.pretty) console.log(JSON.stringify(stuck, null, 2));
        else console.log(formatStuckTable(stuck));
        return;
      }

      const slug = opts.slug ? validateSlug(opts.slug) : undefined;
      const entries = log.list({ storySlug: slug, platform: opts.platform, runId: opts.runId });
      if (opts.pretty) console.log(JSON.stringify(entries, null, 2));
      else for (const e of entries) console.log(JSON.stringify(e));
    });

  decisions
    .command('rotate')
    .description('Force-rotate the active decision log to a timestamped archive')
    .option('--force', 'rotate even if the active file has not reached the size threshold', false)
    .option('--json', 'emit machine-readable JSON', false)
    .action(function (this: Command, opts: { force?: boolean; json?: boolean }) {
      const json = opts.json || this.optsWithGlobals().json;
      const log = new DecisionLog();
      if (!opts.force && !log.shouldRotate()) {
        const payload = { rotated: false, reason: 'under threshold; pass --force to rotate anyway' };
        if (json) process.stdout.write(JSON.stringify(payload) + '\n');
        else console.log(payload.reason);
        return;
      }
      const info = log.rotate();
      const payload = { rotated: Boolean(info.rotatedTo), rotatedTo: info.rotatedTo, bytes: info.bytes };
      if (json) process.stdout.write(JSON.stringify(payload) + '\n');
      else if (payload.rotated) console.log(`rotated → ${info.rotatedTo} (${info.bytes} bytes)`);
      else console.log('no active log to rotate');
    });

  decisions
    .command('archives')
    .description('List rotated decision-log archives with their sizes and date ranges')
    .option('--json', 'emit machine-readable JSON', false)
    .action(function (this: Command, opts: { json?: boolean }) {
      const json = opts.json || this.optsWithGlobals().json;
      const log = new DecisionLog();
      const archives = log.listArchives();
      if (json) {
        process.stdout.write(JSON.stringify(archives) + '\n');
        return;
      }
      if (!archives.length) {
        console.log('no archived decision logs');
        return;
      }
      for (const a of archives) {
        const range = a.earliestTs && a.latestTs ? ` [${a.earliestTs} .. ${a.latestTs}]` : '';
        console.log(`${a.path} (${a.sizeBytes} bytes)${range}`);
      }
    });
}
