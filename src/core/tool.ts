import type { z } from 'zod';
import type { ContentBundle } from './content-bundle.js';

/**
 * A Tool is an atomic, composable unit of work over a ContentBundle. Every piece
 * of PostizAgent — transcription, moderation, render, publish — ultimately lives
 * as a Tool so that external agents and declarative pipelines can compose them
 * without knowing the implementation.
 *
 * Key properties:
 *  - `inputSchema` / `outputSchema` are Zod schemas; inputs come from pipeline
 *    args + accumulated state + the bundle; outputs are merged back into state.
 *  - `preflight()` is an optional cheap check that can skip the tool without
 *    throwing (useful for "content is too short", "dependency missing", etc.).
 *  - `run()` executes the tool. Throw on real errors; return the typed output.
 */

export interface PreflightOk { ok: true }
export interface PreflightSkip { ok: false; reason: string; retryable?: boolean }
export type PreflightResult = PreflightOk | PreflightSkip;

export interface ToolLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface ToolContext {
  bundle: ContentBundle;
  workDir: string;
  /** Mutable scratch shared between pipeline steps. Tools merge their outputs here. */
  state: Record<string, unknown>;
  dryRun?: boolean;
  logger: ToolLogger;
}

export interface Tool<In = unknown, Out = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<In>;
  readonly outputSchema: z.ZodType<Out>;
  preflight?(input: In, ctx: ToolContext): Promise<PreflightResult>;
  run(input: In, ctx: ToolContext): Promise<Out>;
}

export const consoleLogger: ToolLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
};

export const silentLogger: ToolLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
