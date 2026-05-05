import type { Command } from 'commander';
import { Option } from 'commander';
import { Orchestrator } from '../../orchestrator.js';
import { buildTenantBundle } from '../tenant-context.js';
import { brandFromTenant } from '../../copy/brand.js';
import { parsePlatforms, resolvePublishSource } from '../runner.js';
import { printJson } from '../io.js';

/**
 * `publish`: full pipeline — preflight → transcribe → moderate → render → upload.
 * The bundle source is either a registered adapter id (--slug/--id) or an inline
 * ContentBundle JSON file (--bundle-file). The orchestrator emits a JSON report;
 * exit code is 1 if any platform failed or whisper crashed without --allow-no-captions.
 */
export function register(program: Command): void {
  program
    .command('publish')
    .description('Build per-platform videos and publish a bundle to each selected target')
    .option('-t, --tenant <slug>', 'tenant slug (data isolation + per-tenant Postiz/audiokids config)', 'default')
    .option('-s, --slug <slug>', 'bundle id (alias of --id; loaded via --adapter, default audiokids)')
    .option('-i, --id <id>', 'bundle id within the chosen adapter (alias of --slug)')
    .option('-a, --adapter <name>', 'which BundleAdapter to load the id from (default: audiokids)', 'audiokids')
    .option('--bundle-file <path>', 'path to a JSON file with a complete ContentBundle (bypasses any adapter)')
    .addOption(
      new Option('-p, --platforms <list>', 'comma-separated platforms')
        .default('x,tiktok,instagram,youtube'),
    )
    .option('--dry-run', 'render videos locally but do not upload', false)
    .option('--skip-transcription', 'skip whisper word-level transcription (videos will have no captions)', false)
    .option('--allow-no-captions', 'continue (with empty captions) even if whisper crashes; default is to abort', false)
    .option('--force', 'bypass the 24-hour idempotency guard (republish even if already published today)', false)
    .option('--no-moderation', 'skip the Spanish caption blocklist (debugging only; not recommended)')
    .option('--reason <text>', 'reason to record in the decision log', 'scheduled daily publication')
    .option('--json', 'emit only the JSON report on stdout (for agent parsing)', false)
    .addHelpText('after', `
Bundle source (pick one):
  --slug <id> | --id <id>       resolved by the chosen adapter (default 'audiokids')
  --bundle-file <path>          inline ContentBundle JSON, no adapter involved

Platforms:
  x, tiktok, instagram, youtube   → video published via Postiz (or YouTubeCLI)
  spotify                         → no-op; use 'postiz-agent rss' instead

Exit codes:
  0 → every selected platform succeeded
  1 → at least one platform failed, or whisper crashed without --allow-no-captions

By default, if whisper transcription crashes we abort BEFORE rendering to avoid
publishing videos with no captions. Use --skip-transcription to deliberately opt
out of captions (sets captionStatus=skipped), or --allow-no-captions to survive a
whisper failure (sets captionStatus=failed and records a warning).

The decision log at data/decisions.jsonl records every attempt with reason+result.
`)
    .action(async (opts) => {
      const platforms = parsePlatforms(opts.platforms);
      const ctx = buildTenantBundle(opts.tenant);
      const brand = brandFromTenant(ctx.tenant);
      const orch = new Orchestrator({ adapters: ctx.adapters, decisions: ctx.decisions });
      const report = await orch.publish({
        ...resolvePublishSource(opts),
        platforms,
        dryRun: opts.dryRun,
        skipTranscription: opts.skipTranscription,
        allowNoCaptions: opts.allowNoCaptions,
        force: opts.force,
        disableModeration: opts.moderation === false,
        reason: opts.reason,
        brand,
      });
      if (opts.json) printJson(report);
      else console.log('\n' + JSON.stringify(report, null, 2));
      if (report.fatalCaptionFailure) process.exit(1);
      const failed = report.results.filter(r => !r.success);
      process.exit(failed.length > 0 ? 1 : 0);
    });
}
