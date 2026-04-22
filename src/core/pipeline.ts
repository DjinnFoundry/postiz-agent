import { z } from 'zod';
import type { ContentBundle } from './content-bundle.js';
import type { ToolContext, ToolLogger } from './tool.js';
import { consoleLogger } from './tool.js';
import type { ToolRegistry } from './tool-registry.js';

/**
 * A pipeline is a declarative recipe: "run this list of tools in order over
 * a ContentBundle, share state between them, stop on errors unless a step is
 * marked optional". PipelineSpec lives in JSON (or inline code) and is fully
 * portable — any agent that can produce a valid spec can drive PostizAgent.
 */

export const PipelineStepSchema = z.object({
  tool: z.string().min(1),
  args: z.record(z.unknown()).optional(),
  /** If true, a failure or preflight-skip does NOT abort the pipeline. */
  optional: z.boolean().optional(),
  /** Optional human description for readability. */
  note: z.string().optional(),
}).strict();
export type PipelineStep = z.infer<typeof PipelineStepSchema>;

export const PipelineSpecSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().optional(),
  steps: z.array(PipelineStepSchema).min(1),
}).strict();
export type PipelineSpec = z.infer<typeof PipelineSpecSchema>;

export interface PipelineStepResult {
  tool: string;
  ok: boolean;
  skipped?: { reason: string };
  output?: unknown;
  error?: string;
  durationMs: number;
}

export interface PipelineRunResult {
  pipeline: string;
  bundleId: string;
  ok: boolean;
  results: PipelineStepResult[];
}

export interface RunOptions {
  workDir: string;
  dryRun?: boolean;
  logger?: ToolLogger;
  /** Initial state injected into ctx before first step. */
  initialState?: Record<string, unknown>;
}

export class PipelineRunner {
  constructor(private readonly registry: ToolRegistry) {}

  async run(spec: PipelineSpec, bundle: ContentBundle, opts: RunOptions): Promise<PipelineRunResult> {
    PipelineSpecSchema.parse(spec);

    const ctx: ToolContext = {
      bundle,
      workDir: opts.workDir,
      state: { ...(opts.initialState ?? {}) },
      dryRun: opts.dryRun,
      logger: opts.logger ?? consoleLogger,
    };

    const results: PipelineStepResult[] = [];
    for (const step of spec.steps) {
      const tool = this.registry.get(step.tool);
      const rawInput = {
        ...ctx.state,
        ...(step.args ?? {}),
        bundle,
        workDir: opts.workDir,
        dryRun: opts.dryRun,
      };
      const startedAt = Date.now();

      const parsed = tool.inputSchema.safeParse(rawInput);
      if (!parsed.success) {
        const msg = `input validation failed for "${tool.name}": ${parsed.error.message}`;
        results.push({ tool: step.tool, ok: false, error: msg, durationMs: Date.now() - startedAt });
        ctx.logger.error(msg);
        if (!step.optional) return { pipeline: spec.name, bundleId: bundle.id, ok: false, results };
        continue;
      }

      if (tool.preflight) {
        try {
          const pre = await tool.preflight(parsed.data, ctx);
          if (!pre.ok) {
            results.push({ tool: step.tool, ok: true, skipped: { reason: pre.reason }, durationMs: Date.now() - startedAt });
            ctx.logger.info(`→ ${tool.name} skipped: ${pre.reason}`);
            continue;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          results.push({ tool: step.tool, ok: false, error: `preflight threw: ${msg}`, durationMs: Date.now() - startedAt });
          if (!step.optional) return { pipeline: spec.name, bundleId: bundle.id, ok: false, results };
          continue;
        }
      }

      try {
        ctx.logger.info(`→ ${tool.name} running`);
        const out = await tool.run(parsed.data, ctx);
        tool.outputSchema.parse(out);
        if (out && typeof out === 'object') {
          Object.assign(ctx.state, out);
        }
        results.push({ tool: step.tool, ok: true, output: out, durationMs: Date.now() - startedAt });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.logger.error(`  ${tool.name} failed: ${msg}`);
        results.push({ tool: step.tool, ok: false, error: msg, durationMs: Date.now() - startedAt });
        if (!step.optional) return { pipeline: spec.name, bundleId: bundle.id, ok: false, results };
      }
    }

    return { pipeline: spec.name, bundleId: bundle.id, ok: results.every(r => r.ok), results };
  }
}
