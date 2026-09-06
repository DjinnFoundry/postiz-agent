import type { Command } from 'commander';
import { Orchestrator } from '../../orchestrator.js';
import { buildTenantBundle } from '../tenant-context.js';
import { brandFromTenant } from '../../copy/brand.js';
import { DEFAULT_ADAPTER } from '../../adapters/registry.js';
import { parsePlatforms, resolvePublishSource } from '../runner.js';
import { printJson } from '../io.js';

/**
 * `render`: build MP4 files only, no upload. Internally `publish --dry-run` with
 * a fixed reason. Useful as a preview before committing to a real publish.
 */
export function register(program: Command): void {
  program
    .command('render')
    .description('Generate MP4 videos for the given platforms without uploading anywhere')
    .option('-t, --tenant <slug>', 'tenant slug', 'default')
    .option('-s, --slug <slug>', 'bundle id (alias of --id)')
    .option('-i, --id <id>', 'bundle id within the chosen adapter')
    .option('-a, --adapter <name>', `which BundleAdapter to load the id from (default: ${DEFAULT_ADAPTER})`, DEFAULT_ADAPTER)
    .option('--bundle-file <path>', 'path to a JSON file with a complete ContentBundle (bypasses any adapter)')
    .option('-p, --platforms <list>', 'comma-separated platforms', 'tiktok,instagram,youtube,x')
    .option('--skip-transcription', 'skip Whisper (audio-story slide rendering still requires a transcript)', false)
    .option('--allow-no-captions', 'continue after Whisper fails (audio-story slides still fail without a transcript)', false)
    .option('--json', 'emit only the JSON report on stdout', false)
    .addHelpText('after', `
For audio-story bundles, produces MP4 files under tmp/ (tmp/<tenant>/ for named
tenants). File URLs in the report identify the previews. Useful before
running the full publish pipeline. Internally equivalent to 'publish --dry-run'.

Audio-story slide rendering requires a non-empty word-level transcript.
--skip-transcription and --allow-no-captions do not enable rendering without
subtitles: audio-story slides fail if transcription is skipped or fails.
Prepared video, image-post and text bundles bypass Whisper automatically.
`)
    .action(async (opts) => {
      const platforms = parsePlatforms(opts.platforms);
      const ctx = buildTenantBundle(opts.tenant);
      const brand = brandFromTenant(ctx.tenant);
      const orch = new Orchestrator(ctx.orchestratorDeps);
      const report = await orch.publish({
        ...resolvePublishSource(opts),
        platforms,
        dryRun: true,
        skipTranscription: opts.skipTranscription,
        allowNoCaptions: opts.allowNoCaptions,
        reason: 'preview render (no upload)',
        brand,
      });
      if (opts.json) printJson(report);
      else console.log('\n' + JSON.stringify(report, null, 2));
      process.exitCode = report.fatalCaptionFailure || report.results.some(r => !r.success) ? 1 : 0;
    });
}
