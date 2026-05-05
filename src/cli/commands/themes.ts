import type { Command } from 'commander';
import {
  listThemes,
  describeTheme,
  formatThemesList,
  formatThemeDescription,
  checkDecisions,
  formatCheckDecisions,
} from '../themes.js';
import { printJson, printJsonPretty } from '../io.js';
import { CliError } from '../errors.js';

/**
 * `themes`: inspect the treatment catalog used by the theme engine.
 *   - list: print every treatment with its family + palette/font counts
 *   - describe <id>: show palettes, font pairing, layout hints for one
 *   - check-decisions: surface stale decisions whose treatmentId or
 *     catalogVersion no longer matches; --fix clears them so the next
 *     publish re-resolves
 */
export function register(program: Command): void {
  const themes = program
    .command('themes')
    .description('Inspect the treatment catalog used by the theme engine (12 editorial looks)');

  themes
    .command('list')
    .description('List every treatment with its family, palette count, and font pairing')
    .option('--json', 'emit a plain JSON array of treatments (length matches catalog count)', false)
    .action((opts: { json?: boolean }) => {
      const report = listThemes();
      // JSON shape is a bare array — matches doctor/stats/tools precedent of "| jq length" working directly.
      if (opts.json) printJsonPretty(report.treatments);
      else console.log(formatThemesList(report));
    });

  themes
    .command('describe')
    .description('Print palettes, font pairing, and layout hints for a single treatment')
    .argument('<id>', 'treatment id (e.g. hero-display, midnight, terminal-crt)')
    .option('--json', 'emit the descriptor as JSON', false)
    .action((id: string, opts: { json?: boolean }) => {
      const desc = describeTheme(id);
      if (!desc.ok) {
        throw new CliError(`unknown treatment: ${id}. Available: ${desc.knownIds.join(', ')}`);
      }
      if (opts.json) printJsonPretty(desc);
      else console.log(formatThemeDescription(desc));
    });

  themes
    .command('check-decisions')
    .description('List theme-decision entries whose treatmentId or catalogVersion no longer matches the current catalog')
    .option('--json', 'emit the stale list as a JSON array (possibly empty)', false)
    .option('--fix', 'delete stale entries so the next publish re-resolves the theme', false)
    .addHelpText('after', `
Stale reasons:
  unknown-treatment-id  (the saved treatmentId no longer exists in the catalog)
  version-mismatch      (the catalogVersion recorded at save-time differs from now)
  legacy-no-version     (saved before catalogVersion stamping was introduced)

--fix clears stale entries only. Re-resolving is deferred to the next publish,
which runs the full resolver for the bundle (explicit -> keywords -> mood -> fallback).

Examples:
  postiz-agent themes check-decisions --json
  postiz-agent themes check-decisions --fix
`)
    .action((opts: { json?: boolean; fix?: boolean }) => {
      const result = checkDecisions({ fix: opts.fix });
      if (opts.json) printJsonPretty(result.stale);
      else console.log(formatCheckDecisions(result, { fix: opts.fix }));
      process.exit(0);
    });
}
