#!/usr/bin/env node
import { Command } from 'commander';

import { register as registerPublish } from './cli/commands/publish.js';
import { register as registerRender } from './cli/commands/render.js';
import { register as registerRss } from './cli/commands/rss.js';
import { register as registerDecisions } from './cli/commands/decisions.js';
import { register as registerStatus } from './cli/commands/status.js';
import { register as registerIntegrations } from './cli/commands/integrations.js';
import { register as registerDoctor } from './cli/commands/doctor.js';
import { register as registerStats } from './cli/commands/stats.js';
import { register as registerCtaAb } from './cli/commands/cta-ab.js';
import { register as registerDispatch } from './cli/commands/dispatch.js';
import { register as registerInit } from './cli/commands/init.js';
import { register as registerDaemon } from './cli/commands/daemon.js';
import { register as registerInbox } from './cli/commands/inbox.js';
import { register as registerTenants } from './cli/commands/tenants.js';
import { register as registerAdapters } from './cli/commands/adapters.js';
import { register as registerCopy } from './cli/commands/copy.js';
import { register as registerLogs } from './cli/commands/logs.js';
import { register as registerCache } from './cli/commands/cache.js';
import { register as registerTools } from './cli/commands/tools.js';
import { register as registerRunPipeline } from './cli/commands/run-pipeline.js';
import { register as registerThemes } from './cli/commands/themes.js';
import { register as registerGallery } from './cli/commands/gallery.js';

/**
 * postiz-agent — CLI entry point. Each subcommand lives in its own file under
 * src/cli/commands/<name>.ts and exposes a `register(program)` function so
 * this entry stays a thin orchestrator: build the program, register every
 * subcommand, parse argv. Pure CLI wiring; the implementation lives in
 * src/orchestrator.ts, src/cli/<name>.ts (formatters), and the platform /
 * tool / theme modules.
 */
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

// Order is mostly cosmetic (commander prints them in registration order in --help),
// but kept roughly: pipeline → ops/observability → tenants/discovery → tools.
registerPublish(program);
registerRender(program);
registerRss(program);
registerDecisions(program);
registerStatus(program);
registerIntegrations(program);
registerDoctor(program);
registerStats(program);
registerCtaAb(program);
registerDispatch(program);
registerInit(program);
registerDaemon(program);
registerInbox(program);
registerTenants(program);
registerAdapters(program);
registerCopy(program);
registerLogs(program);
registerCache(program);
registerTools(program);
registerRunPipeline(program);
registerThemes(program);
registerGallery(program);

program.parseAsync(process.argv).catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
