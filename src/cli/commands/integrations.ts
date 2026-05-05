import type { Command } from 'commander';
import { buildTenantBundle } from '../tenant-context.js';
import { printJsonPretty } from '../io.js';
import { CliError } from '../errors.js';

/**
 * `integrations`: list connected Postiz accounts (X, TikTok, IG, YouTube).
 * Filled in/disabled flags surface on the prefix dot (●/○). Useful as a
 * sanity check before publish: a missing or disabled platform here will
 * fail the corresponding publisher with a needs-config error.
 */
export function register(program: Command): void {
  program
    .command('integrations')
    .description('List connected Postiz integrations (X, TikTok, Instagram, YouTube accounts)')
    .option('-t, --tenant <slug>', 'tenant slug (selects which Postiz instance to query)', 'default')
    .option('--json', 'emit machine-readable JSON', false)
    .action(async (opts) => {
      const ctx = buildTenantBundle(opts.tenant);
      try {
        const integrations = await ctx.postiz().listIntegrations();
        if (opts.json) {
          printJsonPretty(integrations);
        } else {
          for (const i of integrations) {
            console.log(`${i.disabled ? '○' : '●'} ${i.providerIdentifier.padEnd(12)} ${i.name} (${i.id})`);
          }
        }
      } catch (err) {
        throw new CliError(`Could not reach Postiz at ${ctx.tenant.postiz.apiUrl}: ${err instanceof Error ? err.message : err}`);
      }
    });
}
