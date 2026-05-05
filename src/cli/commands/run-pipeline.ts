import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { config } from '../../config.js';
import { PipelineRunner, PipelineSpecSchema, type PipelineSpec } from '../../core/pipeline.js';
import { createDefaultRegistry } from '../../tools/index.js';
import { consoleLogger, silentLogger } from '../../core/tool.js';
import { resolveBundle } from '../runner.js';
import { printJson, printJsonPretty } from '../io.js';

/**
 * `run-pipeline`: execute a declarative pipeline (JSON spec) against a bundle.
 * --stream emits NDJSON per step + a final summary so an external agent can
 * consume progress without polling.
 */
export function register(program: Command): void {
  program
    .command('run-pipeline')
    .description('Run a declarative pipeline (JSON spec) against a bundle')
    .argument('<spec>', 'path to the pipeline JSON spec')
    .option('--id <id>', 'ContentBundle id (AudioKids slug) to load via adapter')
    .option('--bundle-file <path>', 'path to a JSON file with a complete ContentBundle')
    .option('--work-dir <path>', 'writable workspace for the pipeline', '')
    .option('--dry-run', 'hint to every step not to perform side effects', false)
    .option('--json', 'emit the run result as JSON on stdout (logger silenced)', false)
    .option('--stream', 'emit NDJSON (one JSON object per step as it completes, plus a final summary)', false)
    .action(async (specPath: string, opts: {
      id?: string; bundleFile?: string; workDir?: string; dryRun?: boolean; json?: boolean; stream?: boolean;
    }) => {
      if (!existsSync(specPath)) {
        console.error(`pipeline spec not found: ${specPath}`);
        process.exit(1);
      }
      const raw = JSON.parse(readFileSync(specPath, 'utf-8'));
      const spec: PipelineSpec = PipelineSpecSchema.parse(raw);
      const bundle = resolveBundle(opts);
      const workDir = opts.workDir?.trim() || join(config.paths.tmpDir, bundle.id);
      const runner = new PipelineRunner(createDefaultRegistry());
      const silent = Boolean(opts.json || opts.stream);
      const result = await runner.run(spec, bundle, {
        workDir,
        dryRun: opts.dryRun,
        logger: silent ? silentLogger : consoleLogger,
        onStepComplete: opts.stream
          ? (step) => printJson({ type: 'step', ...step })
          : undefined,
      });
      if (opts.stream) {
        printJson({
          type: 'summary',
          pipeline: result.pipeline,
          bundleId: result.bundleId,
          ok: result.ok,
          stepCount: result.results.length,
        });
      } else if (opts.json) {
        printJsonPretty(result);
      } else {
        console.log(`\npipeline ${spec.name} → ${result.ok ? 'OK' : 'FAILED'}`);
        for (const step of result.results) {
          const tag = step.skipped ? `skipped (${step.skipped.reason})` : step.ok ? 'ok' : `failed: ${step.error}`;
          console.log(`  ${step.tool}: ${tag} [${step.durationMs}ms]`);
        }
      }
      if (!result.ok) process.exit(1);
    });
}
