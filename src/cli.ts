#!/usr/bin/env node
import { Command } from 'commander';
import { writeFileSync } from 'node:fs';
import { Orchestrator } from './orchestrator.js';
import { SpotifyRssBuilder } from './platforms/spotify-rss.js';
import { DecisionLog } from './decisions/log.js';
import { PlatformSchema, type Platform } from './types.js';

const program = new Command();
program
  .name('postiz-agent')
  .description('Publish AudioKids stories to social platforms, autonomously')
  .version('0.1.0');

program
  .command('publish')
  .description('Publish a story across selected platforms')
  .requiredOption('-s, --slug <slug>', 'AudioKids story slug')
  .option('-p, --platforms <list>', 'comma-separated platforms (x,tiktok,instagram,youtube,spotify)', 'x,tiktok,instagram,youtube')
  .option('--dry-run', 'build media but do not upload to platforms', false)
  .option('--skip-transcription', 'skip whisper word-level transcription (videos will have no captions)', false)
  .action(async (opts) => {
    const platforms = opts.platforms.split(',').map((p: string) => p.trim())
      .map((p: string) => PlatformSchema.parse(p)) as Platform[];
    const orch = new Orchestrator();
    const report = await orch.publish({
      storySlug: opts.slug,
      platforms,
      dryRun: opts.dryRun,
      skipTranscription: opts.skipTranscription,
    });
    console.log('\n' + JSON.stringify(report, null, 2));
    const failed = report.results.filter(r => !r.success);
    process.exit(failed.length > 0 ? 1 : 0);
  });

program
  .command('rss')
  .description('Generate Spotify-compatible podcast RSS feed from AudioKids output')
  .option('-o, --output <path>', 'output XML path', './tmp/feed.xml')
  .option('--title <t>', 'podcast title', 'AudioKids')
  .option('--description <d>', 'podcast description', 'Audiocuentos para niños, creados con IA')
  .option('--link <l>', 'podcast website', 'https://audiokids.app')
  .option('--author <a>', 'podcast author', 'AudioKids')
  .option('--email <e>', 'owner email', 'hello@audiokids.app')
  .option('--image <i>', 'cover image URL', 'https://audiokids.app/podcast-cover.png')
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

program
  .command('decisions')
  .description('List decision log entries')
  .option('-s, --slug <slug>', 'filter by story slug')
  .option('-p, --platform <platform>', 'filter by platform')
  .action((opts) => {
    const log = new DecisionLog();
    const entries = log.list({ storySlug: opts.slug, platform: opts.platform });
    console.log(JSON.stringify(entries, null, 2));
  });

program.parseAsync(process.argv).catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
