#!/usr/bin/env node
import { Command, Option } from 'commander';
import { existsSync, writeFileSync } from 'node:fs';
import { Orchestrator } from './orchestrator.js';
import { SpotifyRssBuilder } from './platforms/spotify-rss.js';
import { DecisionLog } from './decisions/log.js';
import { PostizClient } from './platforms/postiz.js';
import { config } from './config.js';
import { run } from './lib/process.js';
import { validateSlug } from './lib/slug.js';
import { PlatformSchema, type Platform } from './types.js';

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
  .description('Build per-platform videos and publish a story to each selected target')
  .requiredOption('-s, --slug <slug>', 'AudioKids story slug (file basename without extension)')
  .addOption(
    new Option('-p, --platforms <list>', 'comma-separated platforms')
      .default('x,tiktok,instagram,youtube'),
  )
  .option('--dry-run', 'render videos locally but do not upload', false)
  .option('--skip-transcription', 'skip whisper word-level transcription (videos will have no captions)', false)
  .option('--reason <text>', 'reason to record in the decision log', 'scheduled daily publication')
  .option('--json', 'emit only the JSON report on stdout (for agent parsing)', false)
  .addHelpText('after', `
Platforms:
  x, tiktok, instagram, youtube   → video published via Postiz (or YouTubeCLI)
  spotify                         → no-op; use 'postiz-agent rss' instead

Exit codes:
  0 → every selected platform succeeded
  1 → at least one platform failed (check the printed report or 'decisions')

The decision log at data/decisions.jsonl records every attempt with reason+result.
`);

program.commands[0].action(async (opts) => {
  const platforms = parsePlatforms(opts.platforms);
  const orch = new Orchestrator();
  const report = await orch.publish({
    storySlug: validateSlug(opts.slug),
    platforms,
    dryRun: opts.dryRun,
    skipTranscription: opts.skipTranscription,
    reason: opts.reason,
  });
  if (opts.json) process.stdout.write(JSON.stringify(report) + '\n');
  else console.log('\n' + JSON.stringify(report, null, 2));
  const failed = report.results.filter(r => !r.success);
  process.exit(failed.length > 0 ? 1 : 0);
});

// ─────────────────────────── render ───────────────────────────
program
  .command('render')
  .description('Generate MP4 videos for the given platforms without uploading anywhere')
  .requiredOption('-s, --slug <slug>', 'AudioKids story slug')
  .option('-p, --platforms <list>', 'comma-separated platforms', 'tiktok,instagram,youtube,x')
  .option('--skip-transcription', 'skip whisper (no captions)', false)
  .option('--json', 'emit only the JSON report on stdout', false)
  .addHelpText('after', `
Produces tmp/<slug>/<slug>-<platform>.mp4 files. Useful for previewing before
running the full publish pipeline. Internally equivalent to 'publish --dry-run'
but makes intent explicit in the decision log.
`)
  .action(async (opts) => {
    const platforms = parsePlatforms(opts.platforms);
    const orch = new Orchestrator();
    const report = await orch.publish({
      storySlug: validateSlug(opts.slug),
      platforms,
      dryRun: true,
      skipTranscription: opts.skipTranscription,
      reason: 'preview render (no upload)',
    });
    if (opts.json) process.stdout.write(JSON.stringify(report) + '\n');
    else console.log('\n' + JSON.stringify(report, null, 2));
    process.exit(report.results.every(r => r.success) ? 0 : 1);
  });

// ─────────────────────────── rss ───────────────────────────
program
  .command('rss')
  .description('Build an iTunes/Spotify-compatible podcast RSS feed from AudioKids output')
  .option('-o, --output <path>', 'output XML path', './tmp/feed.xml')
  .option('--title <t>', 'podcast title', 'AudioKids')
  .option('--description <d>', 'podcast description', 'Audiocuentos para niños, creados con IA')
  .option('--link <l>', 'podcast website URL', 'https://audiokids.org')
  .option('--author <a>', 'podcast author', 'AudioKids')
  .option('--email <e>', 'owner email (required by iTunes)', 'hello@audiokids.org')
  .option('--image <i>', 'cover image URL (1400x1400 PNG recommended)', 'https://audiokids.org/podcast-cover.png')
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
  .option('--pretty', 'pretty-print with 2-space indent', false)
  .addHelpText('after', `
Decisions are appended to data/decisions.jsonl on every publish or render. Each
entry records: action, reason, storySlug, platform, result (post id / url / error),
and createdAt. Useful for agent memory across runs — "did yesterday's tiktok
post succeed?" is a single grep, not a re-check of a platform API.

Examples:
  postiz-agent decisions                              # everything
  postiz-agent decisions --slug dragon-marcos         # one story, every platform
  postiz-agent decisions --platform x                 # all X history
`)
  .action((opts) => {
    const log = new DecisionLog();
    const slug = opts.slug ? validateSlug(opts.slug) : undefined;
    const entries = log.list({ storySlug: slug, platform: opts.platform });
    if (opts.pretty) console.log(JSON.stringify(entries, null, 2));
    else for (const e of entries) console.log(JSON.stringify(e));
  });

// ─────────────────────────── status ───────────────────────────
program
  .command('status')
  .description('Check environment health: tools installed, services reachable, dirs exist')
  .option('--json', 'emit machine-readable JSON', false)
  .addHelpText('after', `
Run this first before a publish to catch config errors early.
Checks: ffmpeg, whisper, hyperframes CLI, Postiz API, AudioKids output dir.
`)
  .action(async (opts) => {
    const checks = await runStatusChecks();
    if (opts.json) {
      process.stdout.write(JSON.stringify(checks, null, 2) + '\n');
    } else {
      for (const c of checks) {
        const mark = c.ok ? '✓' : '✗';
        const hint = c.detail ? `  ${c.detail}` : '';
        console.log(`${mark} ${c.label}${hint}`);
      }
    }
    const failed = checks.filter(c => c.required && !c.ok);
    process.exit(failed.length > 0 ? 1 : 0);
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

// ─────────────────────────── helpers ───────────────────────────
function parsePlatforms(csv: string): Platform[] {
  return csv
    .split(',')
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => PlatformSchema.parse(p));
}

interface Check { label: string; ok: boolean; detail?: string; required: boolean; }

async function runStatusChecks(): Promise<Check[]> {
  const checks: Check[] = [];

  checks.push(await binCheck('ffmpeg', '-version', true));
  checks.push(await binCheck('ffprobe', '-version', true));
  checks.push(await binCheck('whisper', '--help', false));
  checks.push(await binCheck('npx', '--version', true));

  const akDir = config.audiokids.outputDir;
  checks.push({
    label: `AudioKids output dir`,
    ok: existsSync(akDir),
    detail: akDir,
    required: true,
  });

  try {
    const { accessSync, constants } = await import('node:fs');
    accessSync(config.audiokids.outputDir, constants.R_OK);
    checks.push({ label: 'AudioKids output dir readable', ok: true, required: true });
  } catch (err) {
    checks.push({ label: 'AudioKids output dir readable', ok: false, detail: String(err), required: true });
  }

  try {
    const res = await fetch(`${config.postiz.apiUrl.replace(/\/public\/v1$/, '')}/`, {
      method: 'GET',
      signal: AbortSignal.timeout(15000),
    });
    checks.push({
      label: `Postiz API reachable`,
      ok: true,
      detail: `${config.postiz.apiUrl} (HTTP ${res.status})`,
      required: false,
    });
  } catch (err) {
    checks.push({
      label: `Postiz API reachable`,
      ok: false,
      detail: `${config.postiz.apiUrl} · ${err instanceof Error ? err.message : err}`,
      required: false,
    });
  }

  checks.push({
    label: 'POSTIZ_API_KEY set',
    ok: Boolean(config.postiz.apiKey),
    detail: config.postiz.apiKey ? 'present' : 'missing in .env',
    required: false,
  });

  checks.push({
    label: 'YouTubeCLI project path',
    ok: existsSync(config.youtubecli.path),
    detail: config.youtubecli.path,
    required: false,
  });

  return checks;
}

async function binCheck(cmd: string, testArg: string, required: boolean): Promise<Check> {
  try {
    await run(cmd, [testArg]);
    return { label: `${cmd} installed`, ok: true, required };
  } catch (err) {
    return {
      label: `${cmd} installed`,
      ok: false,
      detail: err instanceof Error ? err.message.split('\n')[0] : String(err),
      required,
    };
  }
}

program.parseAsync(process.argv).catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
