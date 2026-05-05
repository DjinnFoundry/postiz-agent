import type { Command } from 'commander';
import { createDefaultRegistry } from '../../adapters/registry.js';
import { printJsonPretty } from '../io.js';

/**
 * `adapters list`: introspect every BundleAdapter the registry knows about,
 * with the count of currently-available candidates. External agents pick the
 * adapter via `dispatch --adapter <name>` or `publish --adapter <name>`.
 */
export function register(program: Command): void {
  const adapters = program
    .command('adapters')
    .description('Introspect registered BundleAdapters (audiokids and any future ones)');

  adapters
    .command('list')
    .description('List every registered adapter with its candidate count')
    .option('--json', 'emit machine-readable JSON', false)
    .action((opts: { json?: boolean }) => {
      const registry = createDefaultRegistry();
      const list = registry.list();
      if (opts.json) {
        printJsonPretty(list);
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
}
