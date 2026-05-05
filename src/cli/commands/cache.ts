import type { Command } from 'commander';
import { pruneUploadCache } from '../housekeeping.js';

/**
 * `cache prune`: drop entries from the Postiz upload dedup cache
 * (data/upload-cache.json) older than the TTL (default 7 days). Keeps the
 * SHA256-keyed cache from accumulating ghost entries indefinitely.
 */
export function register(program: Command): void {
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
}
