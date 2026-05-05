import type { Command } from 'commander';
import { listTenants, loadTenant } from '../../core/tenant.js';

/**
 * `tenants list`: enumerate every tenant on disk. The default tenant is
 * always present; named tenants come from tenants/<slug>/config.json.
 * Useful when an operator forgets which tenants exist or needs a JSON
 * digest for an external dashboard.
 */
export function register(program: Command): void {
  const tenants = program
    .command('tenants')
    .description('Inspect tenants (per-product config + isolated data)');

  tenants
    .command('list')
    .description('List configured tenants. The default tenant is always present.')
    .option('--json', 'emit machine-readable JSON', false)
    .action((opts: { json?: boolean }) => {
      const slugs = listTenants();
      const items = slugs.map(slug => {
        const t = loadTenant(slug);
        return {
          slug: t.slug,
          dataDir: t.paths.dataDir,
          postizApiUrl: t.postiz.apiUrl,
          audiokidsDir: t.audiokids.outputDir,
          brandName: t.brand?.name,
        };
      });
      if (opts.json) {
        process.stdout.write(JSON.stringify(items, null, 2) + '\n');
        return;
      }
      if (items.length === 0) {
        console.log('no tenants configured');
        return;
      }
      for (const i of items) {
        const brand = i.brandName ? ` [${i.brandName}]` : '';
        console.log(`  ${i.slug.padEnd(14)}${brand}  data=${i.dataDir}`);
      }
    });
}
