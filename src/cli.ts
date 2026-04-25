#!/usr/bin/env node
import { Command, Option } from 'commander';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Orchestrator } from './orchestrator.js';
import { SpotifyRssBuilder } from './platforms/spotify-rss.js';
import { DecisionLog } from './decisions/log.js';
import { PostizClient } from './platforms/postiz.js';
import { config } from './config.js';
import { validateSlug } from './lib/slug.js';
import { assertSafeBundlePath } from './lib/safe-path.js';
import { selectNextStory, findStuckSlugs, type StuckSlugInfo } from './dispatch.js';
import { AudioKidsAdapter } from './adapters/audiokids.js';
import { createDefaultRegistry as createDefaultAdapterRegistry } from './adapters/registry.js';
import { PipelineRunner, PipelineSpecSchema, type PipelineSpec } from './core/pipeline.js';
import { createDefaultRegistry } from './tools/index.js';
import { consoleLogger, silentLogger } from './core/tool.js';
import { ContentBundleSchema } from './core/content-bundle.js';
import { PlatformSchema, type Platform } from './types.js';
import { runDoctor, formatDoctorReport } from './cli/doctor.js';
import { runStats, formatStatsReport } from './cli/stats.js';
import { runStatus, formatStatusReport } from './cli/status.js';
import { runCtaAb, formatCtaAbReport } from './cli/cta-ab.js';
import {
  listThemes,
  describeTheme,
  formatThemesList,
  formatThemeDescription,
  checkDecisions,
  formatCheckDecisions,
} from './cli/themes.js';
import { generateGallery, formatGalleryResult, type GalleryAspect } from './cli/gallery.js';
import { formatToolDescribeHuman, formatToolsDocsIndex, formatToolDocs } from './cli/tools-docs.js';
import { pruneRenderLogs, pruneUploadCache } from './cli/housekeeping.js';
import { buildCaptionRich } from './copy/caption-builder.js';

const program = new Command();

program
  .name('postiz-agent')
  .description(
    'Autonomous publishing agent for AudioKids audio stories.\n\n' +
    'Given a story slug, the agent builds slide-based videos with synced captions\n' +
    'and pushes them to X, TikTok, Instagram, YouTube, and Spotify (RSS).\n\n' +
    'Config is read from .env at the project root. See .env.example for required vars.'
  )
  .version('0.1.0')
  .addHelpText('after', `
Examples:
  $ postiz-agent status
      Show environment health (Postiz reachable, whisper available, story dir).

  $ postiz-agent publish --slug dragon-marcos --platforms x,tiktok --dry-run
      Build videos for X and TikTok without uploading. Useful for previewing.

  $ postiz-agent publish --slug dragon-marcos --platforms x,tiktok,instagram,youtube
      Full publish. Exits 0 if every platform succeeded, 1 otherwise.

  $ postiz-agent render --slug dragon-marcos --platforms tiktok --output ./out
      Just generate MP4 files. Skip all platform uploads.

  $ postiz-agent decisions --slug dragon-marcos
      Show every publish attempt for that story, as JSON.

  $ postiz-agent rss --output ./feed.xml
      Rebuild the Spotify-compatible podcast feed from AudioKids output.

See SKILL.md for agent-oriented workflows and decision heuristics.
`);

// ─────────────────────────── publish ───────────────────────────
program
  .command('publish')
  .description('Build per-platform videos and publish a bundle to each selected target')
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
`);

program.commands[0].action(async (opts) => {
  const platforms = parsePlatforms(opts.platforms);
  const orch = new Orchestrator();
  const report = await orch.publish({
    ...resolvePublishSource(opts),
    platforms,
    dryRun: opts.dryRun,
    skipTranscription: opts.skipTranscription,
    allowNoCaptions: opts.allowNoCaptions,
    force: opts.force,
    disableModeration: opts.moderation === false,
    reason: opts.reason,
  });
  if (opts.json) process.stdout.write(JSON.stringify(report) + '\n');
  else console.log('\n' + JSON.stringify(report, null, 2));
  if (report.fatalCaptionFailure) process.exit(1);
  const failed = report.results.filter(r => !r.success);
  process.exit(failed.length > 0 ? 1 : 0);
});

// ─────────────────────────── render ───────────────────────────
program
  .command('render')
  .description('Generate MP4 videos for the given platforms without uploading anywhere')
  .option('-s, --slug <slug>', 'bundle id (alias of --id)')
  .option('-i, --id <id>', 'bundle id within the chosen adapter')
  .option('-a, --adapter <name>', 'which BundleAdapter to load the id from (default: audiokids)', 'audiokids')
  .option('--bundle-file <path>', 'path to a JSON file with a complete ContentBundle (bypasses any adapter)')
  .option('-p, --platforms <list>', 'comma-separated platforms', 'tiktok,instagram,youtube,x')
  .option('--skip-transcription', 'skip whisper (no captions)', false)
  .option('--allow-no-captions', 'continue (with empty captions) even if whisper crashes; default is to abort', false)
  .option('--json', 'emit only the JSON report on stdout', false)
  .addHelpText('after', `
Produces tmp/<id>/<id>-<platform>.mp4 files. Useful for previewing before
running the full publish pipeline. Internally equivalent to 'publish --dry-run'.
`)
  .action(async (opts) => {
    const platforms = parsePlatforms(opts.platforms);
    const orch = new Orchestrator();
    const report = await orch.publish({
      ...resolvePublishSource(opts),
      platforms,
      dryRun: true,
      skipTranscription: opts.skipTranscription,
      allowNoCaptions: opts.allowNoCaptions,
      reason: 'preview render (no upload)',
    });
    if (opts.json) process.stdout.write(JSON.stringify(report) + '\n');
    else console.log('\n' + JSON.stringify(report, null, 2));
    if (report.fatalCaptionFailure) process.exit(1);
    process.exit(report.results.every(r => r.success) ? 0 : 1);
  });

/**
 * Resolve the "where does the bundle come from" decision for publish/render.
 * Either an inline file via --bundle-file or an id resolved through an adapter.
 * Mutually exclusive; throws if both or neither are present.
 */
function resolvePublishSource(opts: { slug?: string; id?: string; adapter?: string; bundleFile?: string }):
  { id?: string; storySlug?: string; adapter?: string; bundle?: import('./core/content-bundle.js').ContentBundle } {
  const id = opts.id ?? opts.slug;
  if (opts.bundleFile && id) {
    throw new Error('pass either --slug/--id or --bundle-file, not both');
  }
  if (opts.bundleFile) {
    if (!existsSync(opts.bundleFile)) throw new Error(`bundle file not found: ${opts.bundleFile}`);
    return { bundle: ContentBundleSchema.parse(JSON.parse(readFileSync(opts.bundleFile, 'utf-8'))) };
  }
  if (!id) {
    throw new Error('one of --slug/--id or --bundle-file is required');
  }
  return { id: validateSlug(id), adapter: opts.adapter ?? 'audiokids' };
}

// ─────────────────────────── rss ───────────────────────────
program
  .command('rss')
  .description('Build an iTunes/Spotify-compatible podcast RSS feed from AudioKids output')
  .option('-o, --output <path>', 'output XML path', './tmp/feed.xml')
  .option('--title <t>', 'podcast title', 'AudioKids')
  .option('--description <d>', 'podcast description', 'Audiocuentos para niños, creados con IA')
  .option('--link <l>', 'podcast website URL', 'https://audiokids.app')
  .option('--author <a>', 'podcast author', 'AudioKids')
  .option('--email <e>', 'owner email (required by iTunes)', 'hello@audiokids.app')
  .option('--image <i>', 'cover image URL (1400x1400 PNG recommended)', 'https://audiokids.app/podcast-cover.png')
  .addHelpText('after', `
Walks AUDIOKIDS_OUTPUT_DIR and emits one <item> per story that has both a
.json metadata file and a .mp3 audio file. Sort: newest first.

Host the resulting feed.xml + all MP3 files on a public URL, then submit the
feed URL once at podcasters.spotify.com/dash/submit. Spotify polls it hourly.
`)
  .action(async (opts) => {
    const builder = new SpotifyRssBuilder({
      title: opts.title,
      description: opts.description,
      link: opts.link,
      author: opts.author,
      email: opts.email,
      imageUrl: opts.image,
    });
    const xml = await builder.build();
    writeFileSync(opts.output, xml, 'utf-8');
    console.log(`wrote ${opts.output} (${xml.length} bytes)`);
  });

// ─────────────────────────── decisions ───────────────────────────
program
  .command('decisions')
  .description('Query the JSONL decision log (every publish attempt, with reason and outcome)')
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
    const log = new DecisionLog();

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
          result: {
            platform,
            success: true,
            skipped: true,
            reason: 'reset-attempts',
            timestamp: ts,
          },
        });
      }
      console.log(JSON.stringify({ ok: true, resetSlug: slug, platforms: [...platforms] }));
      return;
    }

    if (opts.stuck) {
      const all = log.list({});
      const platforms = (Object.values(PlatformSchema.enum)) as Platform[];
      const stuck = findStuckSlugs(all, platforms);
      if (opts.json) {
        process.stdout.write(JSON.stringify(stuck) + '\n');
      } else if (opts.pretty) {
        console.log(JSON.stringify(stuck, null, 2));
      } else {
        console.log(formatStuckTable(stuck));
      }
      return;
    }

    const slug = opts.slug ? validateSlug(opts.slug) : undefined;
    const entries = log.list({ storySlug: slug, platform: opts.platform, runId: opts.runId });
    if (opts.pretty) console.log(JSON.stringify(entries, null, 2));
    else for (const e of entries) console.log(JSON.stringify(e));
  });

program.commands.find(c => c.name() === 'decisions')!
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

program.commands.find(c => c.name() === 'decisions')!
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

// ─────────────────────────── status ───────────────────────────
program
  .command('status')
  .description('Check environment health: tools installed, services reachable, dirs exist')
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
    const report = await runStatus();
    if (opts.json) process.stdout.write(formatStatusReport(report, 'json') + '\n');
    else console.log(formatStatusReport(report, 'human'));

    const failedRequired = report.deps.filter(c => c.required && !c.ok);
    const warnings = report.deps.filter(c => !c.ok && c.warning);
    if (failedRequired.length > 0) process.exit(1);
    if (opts.strict && warnings.length > 0) process.exit(1);
    process.exit(0);
  });

// ─────────────────────────── integrations ───────────────────────────
program
  .command('integrations')
  .description('List connected Postiz integrations (X, TikTok, Instagram, YouTube accounts)')
  .option('--json', 'emit machine-readable JSON', false)
  .action(async (opts) => {
    try {
      const integrations = await new PostizClient().listIntegrations();
      if (opts.json) {
        process.stdout.write(JSON.stringify(integrations, null, 2) + '\n');
      } else {
        for (const i of integrations) {
          console.log(`${i.disabled ? '○' : '●'} ${i.providerIdentifier.padEnd(12)} ${i.name} (${i.id})`);
        }
      }
    } catch (err) {
      console.error(`Could not reach Postiz at ${config.postiz.apiUrl}: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

// ─────────────────────────── doctor ───────────────────────────
program
  .command('doctor')
  .description('Deep diagnostic: integrations, stuck slugs, recent failures, caches. Prints remediation hints.')
  .option('--json', 'emit the full report as JSON (one object on stdout)', false)
  .addHelpText('after', `
Groups every signal an autonomous agent needs to self-triage into one command:
environment, postiz, audiokids, stuck-slugs, recent-failures, upload-cache,
theme-decisions. Exit 1 when any section reports a blocking issue (permanent,
needs-config, needs-human) or when >0 stuck slugs are detected.
`)
  .action(async (opts: { json?: boolean }) => {
    const report = await runDoctor();
    if (opts.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    else console.log(formatDoctorReport(report));
    process.exit(report.ok ? 0 : 1);
  });

// ─────────────────────────── stats ───────────────────────────
program
  .command('stats')
  .description('Roll up the decision log: success rate, top remediations, stuck slugs, CTA variants.')
  .option('--days <n>', 'window in days', '30')
  .option('--platform <platform>', 'filter to a single platform (x, tiktok, instagram, youtube, spotify)')
  .option('--json', 'emit the report as JSON', false)
  .addHelpText('after', `
Read-only digest for a quick operational pulse. Always exits 0.
`)
  .action(async (opts: { days?: string; platform?: string; json?: boolean }) => {
    const days = opts.days ? Number.parseInt(opts.days, 10) : 30;
    if (!Number.isFinite(days) || days <= 0) {
      console.error(`invalid --days value: ${opts.days}`);
      process.exit(1);
    }
    const platform = opts.platform ? PlatformSchema.parse(opts.platform) : undefined;
    const report = await runStats({ days, platform });
    if (opts.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    else console.log(formatStatsReport(report));
    process.exit(0);
  });

// ─────────────────────────── cta-ab ───────────────────────────
program
  .command('cta-ab')
  .description('Per-CTA-variant mini report: uses, success rate, sample urls. Read-only.')
  .option('--days <n>', 'window in days', '30')
  .option('--platform <platform>', 'filter to a single platform (x, tiktok, instagram, youtube)')
  .option('--json', 'emit the report as JSON', false)
  .option('--ingest <file>', 'JSONL engagement file {postId, platform, engagement, recordedAt}; merges avg views/likes/comments per variant')
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
  .action(async (opts: { days?: string; platform?: string; json?: boolean; ingest?: string }) => {
    const days = opts.days ? Number.parseInt(opts.days, 10) : 30;
    if (!Number.isFinite(days) || days <= 0) {
      console.error(`invalid --days value: ${opts.days}`);
      process.exit(1);
    }
    const platform = opts.platform ? PlatformSchema.parse(opts.platform) : undefined;
    const report = await runCtaAb({ days, platform, ingestFile: opts.ingest });
    if (opts.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    else console.log(formatCtaAbReport(report));
    process.exit(0);
  });

// ─────────────────────────── dispatch ───────────────────────────
program
  .command('dispatch')
  .description('Autonomously pick the next bundle to publish and run it. Cron-safe.')
  .addOption(
    new Option('-p, --platforms <list>', 'comma-separated target platforms')
      .default('x,tiktok,instagram,youtube'),
  )
  .option('-a, --adapter <name>', 'BundleAdapter to walk for candidates (default: audiokids)', 'audiokids')
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
    const log = new DecisionLog().list();
    const registry = createDefaultAdapterRegistry();
    if (!registry.has(opts.adapter)) {
      console.error(`unknown adapter "${opts.adapter}". Known: ${registry.names().join(', ')}`);
      process.exit(1);
    }
    const adapter = registry.get(opts.adapter);
    const candidates = adapter.listCandidates().map(c => ({ slug: c.id, generatedAtMs: c.generatedAtMs }));
    const slug = selectNextStory(candidates, log, platforms);
    if (!slug) {
      const payload = { dispatched: false, reason: 'nothing pending' };
      if (opts.json) process.stdout.write(JSON.stringify(payload) + '\n');
      else console.log('nothing pending');
      process.exit(0);
    }
    if (opts.json) process.stdout.write(JSON.stringify({ dispatched: true, slug, adapter: opts.adapter, platforms }) + '\n');
    else console.log(`dispatching ${slug} (adapter=${opts.adapter}) → ${platforms.join(',')}`);

    const orch = new Orchestrator({ adapters: registry });
    const report = await orch.publish({
      id: slug,
      adapter: opts.adapter,
      platforms,
      dryRun: opts.dryRun,
      reason: opts.reason,
    });
    if (!opts.json) console.log('\n' + JSON.stringify(report, null, 2));
    if (report.fatalCaptionFailure) process.exit(1);
    process.exit(report.results.every(r => r.success) ? 0 : 1);
  });

// ─────────────────────────── adapters ───────────────────────────
const adapters = program
  .command('adapters')
  .description('Introspect registered BundleAdapters (audiokids and any future ones)');

adapters
  .command('list')
  .description('List every registered adapter with its candidate count')
  .option('--json', 'emit machine-readable JSON', false)
  .action((opts: { json?: boolean }) => {
    const registry = createDefaultAdapterRegistry();
    const list = registry.list();
    if (opts.json) {
      process.stdout.write(JSON.stringify(list, null, 2) + '\n');
      return;
    }
    if (list.length === 0) {
      console.log('no adapters registered');
      return;
    }
    for (const a of list) {
      console.log(`  ${a.name.padEnd(14)} ${a.candidateCount.toString().padStart(4)} candidates  ${a.description}`);
    }
  });

// ─────────────────────────── helpers ───────────────────────────
function parsePlatforms(csv: string): Platform[] {
  return csv
    .split(',')
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => PlatformSchema.parse(p));
}

function formatStuckTable(rows: StuckSlugInfo[]): string {
  if (rows.length === 0) return 'no stuck slugs';
  const headers = ['slug', 'platform', 'reason', 'remediation', 'next-eligible-at'];
  const body = rows.map(r => [
    truncate(r.slug, 24),
    truncate(r.platform, 10),
    truncate(r.reason, 28),
    truncate(r.lastRemediation?.action ?? '', 20),
    truncate(r.nextEligibleAt ?? '', 25),
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...body.map(row => row[i].length)));
  const pad = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  const sep = widths.map(w => '─'.repeat(w)).join('  ');
  const out = [pad(headers), sep, ...body.map(pad)];
  return out.join('\n');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

// ─────────────────────────── copy preview ───────────────────────────
program
  .command('copy')
  .description('Copy utilities: preview the caption a publisher would produce for a bundle')
  .addHelpText('after', `
Examples:
  postiz-agent copy preview --id dragon-marcos
  postiz-agent copy preview --id dragon-marcos --platform instagram --json
`);

program.commands.find(c => c.name() === 'copy')!
  .command('preview')
  .description('Print the caption that would be posted for a given bundle + platform')
  .option('--id <id>', 'ContentBundle id (AudioKids slug)')
  .option('--bundle-file <path>', 'path to a bundle JSON')
  .option('-p, --platform <platform>', 'which platform to preview (default: all)')
  .option('--json', 'emit machine-readable JSON', false)
  .action(async (opts: { id?: string; bundleFile?: string; platform?: string; json?: boolean }) => {
    if (!opts.id && !opts.bundleFile) {
      console.log([
        'usage: postiz-agent copy preview --id <slug>',
        '   or: postiz-agent copy preview --bundle-file <path>',
        '',
        'Options:',
        '  --id <slug>            AudioKids story slug (loaded via adapter)',
        '  --bundle-file <path>   path to a JSON ContentBundle',
        '  -p, --platform <p>     preview only one platform (default: x,tiktok,instagram,youtube)',
        '  --json                 emit machine-readable JSON',
        '',
        'Examples:',
        '  postiz-agent copy preview --id dragon-marcos',
        '  postiz-agent copy preview --id dragon-marcos --platform instagram --json',
      ].join('\n'));
      process.exit(0);
    }
    const bundle = resolveBundle(opts);
    const platforms: Platform[] = opts.platform
      ? [opts.platform as Platform]
      : ['x', 'tiktok', 'instagram', 'youtube'];
    const out: Record<string, unknown> = {};
    for (const p of platforms) {
      const rich = buildCaptionRich({ bundle, platform: p });
      out[p] = {
        caption: rich.caption,
        length: rich.caption.length,
        ctaVariantId: rich.ctaVariantId,
        hashtags: rich.hashtags,
      };
    }
    if (opts.json) {
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    } else {
      for (const [p, data] of Object.entries(out)) {
        const rich = data as { caption: string; length: number; ctaVariantId: string | null };
        console.log(`\n── ${p} (${rich.length} chars, cta=${rich.ctaVariantId ?? 'none'}) ──\n${rich.caption}\n`);
      }
    }
  });

// ─────────────────────────── logs ───────────────────────────
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
    for (const f of files) {
      console.log(`${join(logDir, f)}`);
    }
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
      console.error(`invalid --older-than-days value: ${opts.olderThanDays}`);
      process.exit(1);
    }
    const result = await pruneRenderLogs({ olderThanDays: days, dryRun: opts.dryRun });
    if (opts.json) {
      process.stdout.write(JSON.stringify(result) + '\n');
    } else {
      const verb = result.dryRun ? 'would remove' : 'removed';
      console.log(`${verb} ${result.removed} log(s), kept ${result.kept}, freed ${result.bytesFreed} bytes from ${result.dir}`);
    }
    process.exit(0);
  });

// ─────────────────────────── cache ───────────────────────────
const cacheCmd = program
  .command('cache')
  .description('Inspect and maintain the Postiz upload dedup cache (data/upload-cache.json)');

cacheCmd
  .command('prune')
  .description('Drop upload-cache entries older than the TTL (default 7 days)')
  .option('--dry-run', 'report what would be removed without writing', false)
  .option('--json', 'emit machine-readable JSON', false)
  .addHelpText('after', `
Examples:
  postiz-agent cache prune --dry-run --json
  postiz-agent cache prune
`)
  .action(async (opts: { dryRun?: boolean; json?: boolean }) => {
    const result = pruneUploadCache({ dryRun: opts.dryRun });
    if (opts.json) {
      process.stdout.write(JSON.stringify(result) + '\n');
    } else {
      const verb = result.dryRun ? 'would remove' : 'removed';
      console.log(`${verb} ${result.removed} entry(ies), kept ${result.kept}`);
    }
    process.exit(0);
  });

// ─────────────────────────── tools ───────────────────────────
const tools = program
  .command('tools')
  .description('Introspect and invoke individual tools (for agent consumption)');

tools
  .command('list')
  .description('List every registered tool with its JSON schema and description')
  .option('--json', 'emit machine-readable JSON only (no decoration)', false)
  .action((opts: { json?: boolean }) => {
    const registry = createDefaultRegistry();
    const descriptors = registry.list();
    if (opts.json) {
      process.stdout.write(JSON.stringify(descriptors, null, 2) + '\n');
      return;
    }
    console.log(`\n${descriptors.length} tools registered:\n`);
    for (const d of descriptors) {
      console.log(`  • ${d.name}`);
      console.log(`      ${d.description}`);
    }
    console.log('\nCall one with:');
    console.log('  postiz-agent tools call <name> --input <file.json>');
    console.log('  postiz-agent tools describe <name>  (full JSON schemas)\n');
  });

tools
  .command('describe')
  .description('Print the full descriptor for a single tool (schemas, examples, composes)')
  .argument('<name>', 'tool name')
  .option('--json', 'emit the descriptor as JSON (default is a human-readable summary)', false)
  .action((name: string, opts: { json?: boolean }) => {
    const registry = createDefaultRegistry();
    if (!registry.has(name)) {
      console.error(`unknown tool: ${name}. Available: ${registry.names().join(', ')}`);
      process.exit(1);
    }
    const [descriptor] = registry.list().filter(d => d.name === name);
    if (opts.json) {
      process.stdout.write(JSON.stringify(descriptor, null, 2) + '\n');
      return;
    }
    process.stdout.write(formatToolDescribeHuman(descriptor) + '\n');
  });

tools
  .command('docs')
  .description('Print a markdown-ish guide for all tools, or for a single tool when a name is passed')
  .argument('[name]', 'tool name (omit to list every tool)')
  .action((name: string | undefined) => {
    const registry = createDefaultRegistry();
    const descriptors = registry.list();
    if (!name) {
      process.stdout.write(formatToolsDocsIndex(descriptors) + '\n');
      return;
    }
    if (!registry.has(name)) {
      console.error(`unknown tool: ${name}. Available: ${registry.names().join(', ')}`);
      process.exit(1);
    }
    const descriptor = descriptors.find(d => d.name === name)!;
    process.stdout.write(formatToolDocs(descriptor) + '\n');
  });

tools
  .command('call')
  .description('Execute a single tool against a bundle. Bundle is loaded from the AudioKids adapter by --id, or fully passed via --bundle-file.')
  .argument('<name>', 'tool name')
  .option('--id <id>', 'ContentBundle id (e.g. an AudioKids story slug) to load via adapter')
  .option('--bundle-file <path>', 'path to a JSON file with a complete ContentBundle (alternative to --id)')
  .option('--input <path>', 'path to a JSON file with the tool arguments merged into the input', '')
  .option('--work-dir <path>', 'writable workspace for the tool', '')
  .option('--dry-run', 'hint to the tool not to perform side effects', false)
  .option('--quiet', 'silence the tool logger', false)
  .option('--json', 'emit machine-readable JSON only (stdout stays clean)', false)
  .action(async (name: string, opts: {
    id?: string; bundleFile?: string; input?: string; workDir?: string; dryRun?: boolean; quiet?: boolean; json?: boolean;
  }) => {
    const registry = createDefaultRegistry();
    if (!registry.has(name)) {
      console.error(`unknown tool: ${name}. Available: ${registry.names().join(', ')}`);
      process.exit(1);
    }
    const bundle = resolveBundle(opts);
    const workDir = opts.workDir?.trim() || join(config.paths.tmpDir, bundle.id);
    const args = opts.input ? JSON.parse(readFileSync(opts.input, 'utf-8')) : {};

    const tool = registry.get(name);
    const rawInput = { ...args, bundle, workDir, dryRun: opts.dryRun };
    const parsed = tool.inputSchema.safeParse(rawInput);
    if (!parsed.success) {
      console.error(`input validation failed for "${name}": ${parsed.error.message}`);
      process.exit(1);
    }
    const ctx = {
      bundle,
      workDir,
      state: {} as Record<string, unknown>,
      dryRun: opts.dryRun,
      logger: opts.quiet || opts.json ? silentLogger : consoleLogger,
    };
    if (tool.preflight) {
      const pre = await tool.preflight(parsed.data, ctx);
      if (!pre.ok) {
        const skipped = { ok: false, skipped: true, reason: pre.reason };
        process.stdout.write(JSON.stringify(skipped, null, 2) + '\n');
        process.exit(0);
      }
    }
    try {
      const out = await tool.run(parsed.data, ctx);
      tool.outputSchema.parse(out);
      process.stdout.write(JSON.stringify({ ok: true, output: out }, null, 2) + '\n');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(JSON.stringify({ ok: false, error: msg }, null, 2) + '\n');
      process.exit(1);
    }
  });

// ─────────────────────────── pipeline ───────────────────────────
program
  .command('run-pipeline')
  .description('Run a declarative pipeline (JSON spec) against a bundle')
  .argument('<spec>', 'path to the pipeline JSON spec')
  .option('--id <id>', 'ContentBundle id (AudioKids slug) to load via adapter')
  .option('--bundle-file <path>', 'path to a JSON file with a complete ContentBundle')
  .option('--work-dir <path>', 'writable workspace for the pipeline', '')
  .option('--dry-run', 'hint to every step not to perform side effects', false)
  .option('--json', 'emit the run result as JSON on stdout (logger silenced)', false)
  .option('--stream', 'emit NDJSON (one JSON object per step as it completes, plus a final summary)', false)
  .action(async (specPath: string, opts: {
    id?: string; bundleFile?: string; workDir?: string; dryRun?: boolean; json?: boolean; stream?: boolean;
  }) => {
    if (!existsSync(specPath)) {
      console.error(`pipeline spec not found: ${specPath}`);
      process.exit(1);
    }
    const raw = JSON.parse(readFileSync(specPath, 'utf-8'));
    const spec: PipelineSpec = PipelineSpecSchema.parse(raw);
    const bundle = resolveBundle(opts);
    const workDir = opts.workDir?.trim() || join(config.paths.tmpDir, bundle.id);
    const runner = new PipelineRunner(createDefaultRegistry());
    const silent = Boolean(opts.json || opts.stream);
    const result = await runner.run(spec, bundle, {
      workDir,
      dryRun: opts.dryRun,
      logger: silent ? silentLogger : consoleLogger,
      onStepComplete: opts.stream
        ? (step) => process.stdout.write(JSON.stringify({ type: 'step', ...step }) + '\n')
        : undefined,
    });
    if (opts.stream) {
      process.stdout.write(JSON.stringify({
        type: 'summary',
        pipeline: result.pipeline,
        bundleId: result.bundleId,
        ok: result.ok,
        stepCount: result.results.length,
      }) + '\n');
    } else if (opts.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
      console.log(`\npipeline ${spec.name} → ${result.ok ? 'OK' : 'FAILED'}`);
      for (const step of result.results) {
        const tag = step.skipped ? `skipped (${step.skipped.reason})` : step.ok ? 'ok' : `failed: ${step.error}`;
        console.log(`  ${step.tool}: ${tag} [${step.durationMs}ms]`);
      }
    }
    if (!result.ok) process.exit(1);
  });

function resolveBundle(opts: { id?: string; bundleFile?: string }) {
  if (opts.bundleFile) {
    const safe = assertSafeBundlePath(opts.bundleFile);
    if (!existsSync(safe)) throw new Error(`bundle file not found: ${opts.bundleFile}`);
    return ContentBundleSchema.parse(JSON.parse(readFileSync(safe, 'utf-8')));
  }
  if (!opts.id) throw new Error('pass --id <slug> or --bundle-file <path> to resolve a ContentBundle');
  return new AudioKidsAdapter().loadBundle(opts.id);
}

// ─────────────────────────── themes ───────────────────────────
const themes = program
  .command('themes')
  .description('Inspect the treatment catalog used by the theme engine (12 editorial looks)');

themes
  .command('list')
  .description('List every treatment with its family, palette count, and font pairing')
  .option('--json', 'emit a plain JSON array of treatments (length matches catalog count)', false)
  .action((opts: { json?: boolean }) => {
    const report = listThemes();
    // JSON shape is a bare array — matches doctor/stats/tools precedent of "| jq length" working directly.
    if (opts.json) process.stdout.write(JSON.stringify(report.treatments, null, 2) + '\n');
    else console.log(formatThemesList(report));
  });

themes
  .command('describe')
  .description('Print palettes, font pairing, and layout hints for a single treatment')
  .argument('<id>', 'treatment id (e.g. hero-display, midnight, terminal-crt)')
  .option('--json', 'emit the descriptor as JSON', false)
  .action((id: string, opts: { json?: boolean }) => {
    const desc = describeTheme(id);
    if (!desc.ok) {
      console.error(`unknown treatment: ${id}. Available: ${desc.knownIds.join(', ')}`);
      process.exit(1);
    }
    if (opts.json) process.stdout.write(JSON.stringify(desc, null, 2) + '\n');
    else console.log(formatThemeDescription(desc));
  });

themes
  .command('check-decisions')
  .description('List theme-decision entries whose treatmentId or catalogVersion no longer matches the current catalog')
  .option('--json', 'emit the stale list as a JSON array (possibly empty)', false)
  .option('--fix', 'delete stale entries so the next publish re-resolves the theme', false)
  .addHelpText('after', `
Stale reasons:
  unknown-treatment-id  (the saved treatmentId no longer exists in the catalog)
  version-mismatch      (the catalogVersion recorded at save-time differs from now)
  legacy-no-version     (saved before catalogVersion stamping was introduced)

--fix clears stale entries only. Re-resolving is deferred to the next publish,
which runs the full resolver for the bundle (explicit -> keywords -> mood -> fallback).

Examples:
  postiz-agent themes check-decisions --json
  postiz-agent themes check-decisions --fix
`)
  .action((opts: { json?: boolean; fix?: boolean }) => {
    const result = checkDecisions({ fix: opts.fix });
    if (opts.json) process.stdout.write(JSON.stringify(result.stale, null, 2) + '\n');
    else console.log(formatCheckDecisions(result, { fix: opts.fix }));
    process.exit(0);
  });

// ─────────────────────────── gallery ───────────────────────────
program
  .command('gallery')
  .description('Render every treatment for a bundle into a single QA HTML file (visual regression surface)')
  .option('--id <id>', 'ContentBundle id (AudioKids slug) to load via adapter')
  .option('--bundle-file <path>', 'path to a JSON file with a complete ContentBundle')
  .option('-o, --output <path>', 'output HTML path (default: data/galleries/<id>-<timestamp>.html)')
  .option('--include-treatments <list>', 'comma-separated subset of treatment ids (default: every treatment)')
  .option('--aspect <aspect>', 'square | portrait | landscape', 'square')
  .option('--json', 'emit machine-readable JSON on stdout', false)
  .addHelpText('after', `
Synthesises word-level timings from bundle.text.body so the template renders
without whisper. Not a deliverable — QA only. Each treatment lives in an
isolated iframe so their CSS roots do not collide.

Examples:
  postiz-agent gallery --id dragon-marcos
  postiz-agent gallery --id dragon-marcos --aspect portrait --output ./tmp/gallery.html
  postiz-agent gallery --id dragon-marcos --include-treatments hero-display,midnight
`)
  .action((opts: {
    id?: string; bundleFile?: string; output?: string;
    includeTreatments?: string; aspect?: string; json?: boolean;
  }) => {
    const aspect = parseAspect(opts.aspect);
    const bundle = resolveBundle(opts);
    const includeTreatments = opts.includeTreatments
      ? opts.includeTreatments.split(',').map(s => s.trim()).filter(Boolean)
      : undefined;
    const result = generateGallery({
      bundle,
      aspect,
      outputPath: opts.output,
      includeTreatments,
    });
    if (opts.json) process.stdout.write(formatGalleryResult(result, { json: true }) + '\n');
    else console.log(formatGalleryResult(result));
  });

function parseAspect(raw: string | undefined): GalleryAspect {
  const v = (raw ?? 'square').toLowerCase();
  if (v === 'square' || v === 'portrait' || v === 'landscape') return v;
  throw new Error(`invalid --aspect ${raw}: must be square | portrait | landscape`);
}

program.parseAsync(process.argv).catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
