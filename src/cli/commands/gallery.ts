import type { Command } from 'commander';
import { generateGallery, formatGalleryResult } from '../gallery.js';
import { parseAspect, resolveBundle } from '../runner.js';

/**
 * `gallery`: render every treatment for a bundle into a single QA HTML page.
 * Synthesises word-level timings from bundle.text.body so the template
 * renders without whisper. Each treatment lives in an isolated iframe so
 * their CSS roots do not collide. Visual regression surface only.
 */
export function register(program: Command): void {
  program
    .command('gallery')
    .description('Render every treatment for a bundle into a single QA HTML file (visual regression surface)')
    .option('--id <id>', 'ContentBundle id (AudioKids slug) to load via adapter')
    .option('--bundle-file <path>', 'path to a JSON file with a complete ContentBundle')
    .option('-o, --output <path>', 'output HTML path (default: data/galleries/<id>-<timestamp>.html)')
    .option('--include-treatments <list>', 'comma-separated subset of treatment ids (default: every treatment)')
    .option('--aspect <aspect>', 'square | portrait | landscape', 'square')
    .option('--json', 'emit machine-readable JSON on stdout', false)
    .addHelpText('after', `
Synthesises word-level timings from bundle.text.body so the template renders
without whisper. Not a deliverable — QA only. Each treatment lives in an
isolated iframe so their CSS roots do not collide.

Examples:
  postiz-agent gallery --id dragon-marcos
  postiz-agent gallery --id dragon-marcos --aspect portrait --output ./tmp/gallery.html
  postiz-agent gallery --id dragon-marcos --include-treatments hero-display,midnight
`)
    .action((opts: {
      id?: string; bundleFile?: string; output?: string;
      includeTreatments?: string; aspect?: string; json?: boolean;
    }) => {
      const aspect = parseAspect(opts.aspect);
      const bundle = resolveBundle(opts);
      const includeTreatments = opts.includeTreatments
        ? opts.includeTreatments.split(',').map(s => s.trim()).filter(Boolean)
        : undefined;
      const result = generateGallery({
        bundle,
        aspect,
        outputPath: opts.output,
        includeTreatments,
      });
      if (opts.json) process.stdout.write(formatGalleryResult(result, { json: true }) + '\n');
      else console.log(formatGalleryResult(result));
    });
}
