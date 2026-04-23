#!/usr/bin/env node
import { Command, Option } from 'commander';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Orchestrator } from './orchestrator.js';
import { SpotifyRssBuilder } from './platforms/spotify-rss.js';
import { DecisionLog } from './decisions/log.js';
import { PostizClient } from './platforms/postiz.js';
import { config } from './config.js';
import { run } from './lib/process.js';
import { validateSlug } from './lib/slug.js';
import { listCandidates, selectNextStory } from './dispatch.js';
import { AudioKidsAdapter } from './adapters/audiokids.js';
import { PipelineRunner, PipelineSpecSchema, type PipelineSpec } from './core/pipeline.js';
import { createDefaultRegistry } from './tools/index.js';
import { consoleLogger, silentLogger } from './core/tool.js';
import { ContentBundleSchema } from './core/content-bundle.js';
import { PlatformSchema, type Platform } from './types.js';
import { runDoctor, formatDoctorReport } from './cli/doctor.js';
import { runStats, formatStatsReport } from './cli/stats.js';

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
  .option('--allow-no-captions', 'continue (with empty captions) even if whisper crashes; default is to abort', false)
  .option('--force', 'bypass the 24-hour idempotency guard (republish even if already published today)', false)
  .option('--no-moderation', 'skip the Spanish caption blocklist (debugging only; not recommended)')
  .option('--reason <text>', 'reason to record in the decision log', 'scheduled daily publication')
  .option('--json', 'emit only the JSON report on stdout (for agent parsing)', false)
  .addHelpText('after', `
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
    storySlug: validateSlug(opts.slug),
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
  .requiredOption('-s, --slug <slug>', 'AudioKids story slug')
  .option('-p, --platforms <list>', 'comma-separated platforms', 'tiktok,instagram,youtube,x')
  .option('--skip-transcription', 'skip whisper (no captions)', false)
  .option('--allow-no-captions', 'continue (with empty captions) even if whisper crashes; default is to abort', false)
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
      allowNoCaptions: opts.allowNoCaptions,
      reason: 'preview render (no upload)',
    });
    if (opts.json) process.stdout.write(JSON.stringify(report) + '\n');
    else console.log('\n' + JSON.stringify(report, null, 2));
    if (report.fatalCaptionFailure) process.exit(1);
    process.exit(report.results.every(r => r.success) ? 0 : 1);
  });

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
  .option('--pretty', 'pretty-print with 2-space indent', false)
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
      const { findStuckSlugs } = await import('./dispatch.js');
      const stuck = findStuckSlugs(all, platforms);
      if (opts.pretty) console.log(JSON.stringify(stuck, null, 2));
      else process.stdout.write(JSON.stringify(stuck) + '\n');
      return;
    }

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
    const checks = await runStatusChecks();
    if (opts.json) {
      process.stdout.write(JSON.stringify(checks, null, 2) + '\n');
    } else {
      for (const c of checks) {
        const mark = c.ok ? '✓' : (c.warning ? '⚠' : '✗');
        const hint = c.detail ? `  ${c.detail}` : '';
        console.log(`${mark} ${c.label}${hint}`);
      }
    }
    const failedRequired = checks.filter(c => c.required && !c.ok);
    const warnings = checks.filter(c => !c.ok && c.warning);
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

// ─────────────────────────── dispatch ───────────────────────────
program
  .command('dispatch')
  .description('Autonomously pick the next story to publish and run it. Cron-safe.')
  .addOption(
    new Option('-p, --platforms <list>', 'comma-separated target platforms')
      .default('x,tiktok,instagram,youtube'),
  )
  .option('--dry-run', 'resolve the next slug and render videos, but do not upload', false)
  .option('--json', 'emit machine-readable JSON on stdout (nothing else)', false)
  .option('--reason <text>', 'reason recorded in the decision log', 'scheduled autonomous dispatch')
  .addHelpText('after', `
Scans AUDIOKIDS_OUTPUT_DIR for every *.json + *.mp3 pair, consults the decision
log, and picks the OLDEST story (by meta.generatedAt if present else file mtime)
that does NOT yet have a successful publish in the last 30 days on ALL of the
requested platforms. Exits 0 with {"dispatched": false, "reason": "nothing
pending"} when nothing is to be done — safe to run from cron every N hours.

Examples:
  postiz-agent dispatch --json
  postiz-agent dispatch --platforms tiktok,instagram
  postiz-agent dispatch --dry-run
`)
  .action(async (opts) => {
    const platforms = parsePlatforms(opts.platforms);
    const log = new DecisionLog().list();
    const candidates = listCandidates(config.audiokids.outputDir);
    const slug = selectNextStory(candidates, log, platforms);
    if (!slug) {
      const payload = { dispatched: false, reason: 'nothing pending' };
      if (opts.json) process.stdout.write(JSON.stringify(payload) + '\n');
      else console.log('nothing pending');
      process.exit(0);
    }
    if (opts.json) process.stdout.write(JSON.stringify({ dispatched: true, slug, platforms }) + '\n');
    else console.log(`dispatching ${slug} → ${platforms.join(',')}`);

    const orch = new Orchestrator();
    const report = await orch.publish({
      storySlug: slug,
      platforms,
      dryRun: opts.dryRun,
      reason: opts.reason,
    });
    if (!opts.json) console.log('\n' + JSON.stringify(report, null, 2));
    if (report.fatalCaptionFailure) process.exit(1);
    process.exit(report.results.every(r => r.success) ? 0 : 1);
  });

// ─────────────────────────── helpers ───────────────────────────
function parsePlatforms(csv: string): Platform[] {
  return csv
    .split(',')
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => PlatformSchema.parse(p));
}

interface Check { label: string; ok: boolean; detail?: string; required: boolean; warning?: boolean; }

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

  // Postiz integration health — warn on disabled or missing target-platform connections.
  if (config.postiz.apiKey) {
    try {
      const integrations = await new PostizClient().listIntegrations();
      const wanted: Array<'x'|'tiktok'|'instagram'|'youtube'> = ['x', 'tiktok', 'instagram', 'youtube'];
      const reconnectUrl = config.postiz.apiUrl.replace(/\/public\/v1$/, '');
      for (const p of wanted) {
        const match = integrations.find(i => i.providerIdentifier === p);
        if (!match) {
          checks.push({ label: `${p} integration`, ok: false, detail: `not connected — connect at ${reconnectUrl}`, required: false, warning: true });
        } else if (match.disabled) {
          checks.push({ label: `${p} integration`, ok: false, detail: `${match.name} disabled — reconnect at ${reconnectUrl}`, required: false, warning: true });
        } else {
          checks.push({ label: `${p} integration`, ok: true, detail: match.name, required: false });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      checks.push({ label: 'Postiz integrations', ok: false, detail: `could not query: ${msg}`, required: false, warning: true });
    }
  }

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
    const { buildCaptionRich } = await import('./copy/caption-builder.js');
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
program
  .command('logs')
  .description('Inspect captured render stderr from data/render-logs (written when a HyperFrames render/lint fails)')
  .option('-s, --slug <slug>', 'filter by story slug')
  .option('-p, --platform <platform>', 'filter by platform')
  .option('--tail', 'show only the most recent matching log (default prints every match listing)', false)
  .action((opts: { slug?: string; platform?: string; tail?: boolean }) => {
    const logDir = join(config.paths.projectRoot, 'data', 'render-logs');
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
  .description('Print the full JSON schema for a single tool (input + output + description)')
  .argument('<name>', 'tool name')
  .action((name: string) => {
    const registry = createDefaultRegistry();
    if (!registry.has(name)) {
      console.error(`unknown tool: ${name}. Available: ${registry.names().join(', ')}`);
      process.exit(1);
    }
    const [descriptor] = registry.list().filter(d => d.name === name);
    process.stdout.write(JSON.stringify(descriptor, null, 2) + '\n');
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
  .action(async (specPath: string, opts: {
    id?: string; bundleFile?: string; workDir?: string; dryRun?: boolean; json?: boolean;
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
    const result = await runner.run(spec, bundle, {
      workDir,
      dryRun: opts.dryRun,
      logger: opts.json ? silentLogger : consoleLogger,
    });
    if (opts.json) {
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
    if (!existsSync(opts.bundleFile)) throw new Error(`bundle file not found: ${opts.bundleFile}`);
    return ContentBundleSchema.parse(JSON.parse(readFileSync(opts.bundleFile, 'utf-8')));
  }
  if (!opts.id) throw new Error('pass --id <slug> or --bundle-file <path> to resolve a ContentBundle');
  return new AudioKidsAdapter().loadBundle(opts.id);
}

program.parseAsync(process.argv).catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
