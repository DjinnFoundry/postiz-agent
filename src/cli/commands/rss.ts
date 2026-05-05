import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Command } from 'commander';
import { SpotifyRssBuilder } from '../../platforms/spotify-rss.js';

/**
 * `rss`: build an iTunes/Spotify-compatible podcast feed from the AudioKids
 * output directory. Runs the SpotifyRssBuilder and writes the resulting XML
 * to disk; the parent directory is created if missing so a fresh clone works.
 */
export function register(program: Command): void {
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
      mkdirSync(dirname(opts.output), { recursive: true });
      writeFileSync(opts.output, xml, 'utf-8');
      console.log(`wrote ${opts.output} (${xml.length} bytes)`);
    });
}
