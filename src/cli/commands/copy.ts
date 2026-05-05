import type { Command } from 'commander';
import { loadTenant } from '../../core/tenant.js';
import { brandFromTenant } from '../../copy/brand.js';
import { buildCaptionRich } from '../../copy/caption-builder.js';
import type { Platform } from '../../types.js';
import { resolveBundle } from '../runner.js';
import { printJsonPretty } from '../io.js';

/**
 * `copy preview`: print the caption a publisher would produce for a given
 * (bundle, platform) pair. Read-only — useful before a real publish to spot
 * length issues, ugly CTA placements, or accidentally leaked PII.
 */
export function register(program: Command): void {
  const copy = program
    .command('copy')
    .description('Copy utilities: preview the caption a publisher would produce for a bundle')
    .addHelpText('after', `
Examples:
  postiz-agent copy preview --id dragon-marcos
  postiz-agent copy preview --id dragon-marcos --platform instagram --json
`);

  copy
    .command('preview')
    .description('Print the caption that would be posted for a given bundle + platform')
    .option('-t, --tenant <slug>', 'tenant slug (brand identity is read from tenants/<slug>/config.json)', 'default')
    .option('--id <id>', 'ContentBundle id (AudioKids slug)')
    .option('--bundle-file <path>', 'path to a bundle JSON')
    .option('-p, --platform <platform>', 'which platform to preview (default: all)')
    .option('--json', 'emit machine-readable JSON', false)
    .action(async (opts: { tenant?: string; id?: string; bundleFile?: string; platform?: string; json?: boolean }) => {
      if (!opts.id && !opts.bundleFile) {
        console.log([
          'usage: postiz-agent copy preview --id <slug>',
          '   or: postiz-agent copy preview --bundle-file <path>',
          '',
          'Options:',
          '  --id <slug>            AudioKids story slug (loaded via adapter)',
          '  --bundle-file <path>   path to a JSON ContentBundle',
          '  -p, --platform <p>     preview only one platform (default: x,tiktok,instagram,youtube)',
          '  --json                 emit machine-readable JSON',
          '',
          'Examples:',
          '  postiz-agent copy preview --id dragon-marcos',
          '  postiz-agent copy preview --id dragon-marcos --platform instagram --json',
        ].join('\n'));
        process.exit(0);
      }
      const bundle = resolveBundle(opts);
      const tenantContext = loadTenant(opts.tenant ?? 'default');
      const brand = brandFromTenant(tenantContext);
      const platforms: Platform[] = opts.platform
        ? [opts.platform as Platform]
        : ['x', 'tiktok', 'instagram', 'youtube'];
      const out: Record<string, unknown> = {};
      for (const p of platforms) {
        const rich = buildCaptionRich({ bundle, platform: p, brand });
        out[p] = {
          caption: rich.caption,
          length: rich.caption.length,
          ctaVariantId: rich.ctaVariantId,
          hashtags: rich.hashtags,
        };
      }
      if (opts.json) {
        printJsonPretty(out);
        return;
      }
      for (const [p, data] of Object.entries(out)) {
        const rich = data as { caption: string; length: number; ctaVariantId: string | null };
        console.log(`\n── ${p} (${rich.length} chars, cta=${rich.ctaVariantId ?? 'none'}) ──\n${rich.caption}\n`);
      }
    });
}
