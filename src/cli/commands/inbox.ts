import type { Command } from 'commander';
import { createInboxRegistry } from '../../inbox/registry.js';
import type { Platform } from '../../types.js';

/**
 * `inbox`: read incoming replies/comments/mentions and post responses. The
 * provider returns notify-only data; the LLM-agent decides what to send back.
 * Today only the mock provider ships; X/IG/YT/TikTok real APIs land here as
 * they are wired.
 */
export function register(program: Command): void {
  const inbox = program
    .command('inbox')
    .description('Read incoming replies/comments/mentions and post responses (notify-only; the LLM-agent decides what to send back)');

  inbox
    .command('list')
    .description('Fetch the inbox for a platform. Today: mock provider. Future: X/IG/YT/TikTok real APIs.')
    .option('-t, --tenant <slug>', 'tenant slug', 'default')
    .option('-p, --platform <platform>', 'which platform to query (default: x)', 'x')
    .option('--limit <n>', 'max items to return', '10')
    .option('--since <cursor>', 'opaque cursor returned by the previous call (paginate)')
    .option('--json', 'emit machine-readable JSON', false)
    .action(async (opts: { tenant?: string; platform: string; limit: string; since?: string; json?: boolean }) => {
      const registry = createInboxRegistry();
      const platform = opts.platform as Platform;
      const provider = registry.get(platform);
      if (!provider) {
        console.error(`no inbox provider for platform "${platform}". Supported: ${registry.platforms().join(', ')}`);
        process.exit(1);
      }
      const result = await provider.listPending({
        ...(opts.since ? { since: opts.since } : {}),
        limit: Number.parseInt(opts.limit, 10),
      });
      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        return;
      }
      if (result.items.length === 0) {
        console.log(`inbox empty for ${platform}`);
        return;
      }
      console.log(`── ${platform} inbox (${result.items.length} items) ──`);
      for (const item of result.items) {
        console.log(`  [${item.id}] ${item.kind} from @${item.author}${item.authorDisplayName ? ` (${item.authorDisplayName})` : ''}`);
        console.log(`    ${item.text}`);
        if (item.url) console.log(`    ${item.url}`);
        console.log('');
      }
      if (result.cursor) console.log(`next cursor: ${result.cursor}`);
    });

  inbox
    .command('reply')
    .description('Post a reply to an inbox item by id')
    .option('-t, --tenant <slug>', 'tenant slug', 'default')
    .option('-p, --platform <platform>', 'platform of the target item', 'x')
    .requiredOption('--to <id>', 'inbox item id to reply to (from `inbox list`)')
    .requiredOption('--text <text>', 'text of the reply')
    .option('--json', 'emit machine-readable JSON', false)
    .action(async (opts: { tenant?: string; platform: string; to: string; text: string; json?: boolean }) => {
      const registry = createInboxRegistry();
      const platform = opts.platform as Platform;
      const provider = registry.get(platform);
      if (!provider) {
        console.error(`no inbox provider for platform "${platform}".`);
        process.exit(1);
      }
      try {
        const result = await provider.postReply(opts.to, opts.text);
        if (opts.json) process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\n');
        else console.log(`replied: ${result.id}${result.url ? ` ${result.url}` : ''}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (opts.json) process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n');
        else console.error(`reply failed: ${msg}`);
        process.exit(1);
      }
    });
}
