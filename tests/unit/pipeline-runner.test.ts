import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../../src/core/tool-registry.js';
import { PipelineRunner, type PipelineSpec } from '../../src/core/pipeline.js';
import { silentLogger, type Tool } from '../../src/core/tool.js';
import type { ContentBundle } from '../../src/core/content-bundle.js';

const bundle: ContentBundle = {
  id: 'test-bundle',
  kind: 'text',
  text: { title: 'Test', body: 'hello world' },
  locale: 'es',
};

function makeEcho(name: string, extra: (input: Record<string, unknown>) => Record<string, unknown> = () => ({})): Tool<{ bundle: unknown }, Record<string, unknown>> {
  return {
    name,
    description: `echo tool ${name}`,
    inputSchema: z.object({ bundle: z.any() }).passthrough(),
    outputSchema: z.record(z.unknown()),
    async run(input) {
      return { [`${name}_ran`]: true, ...extra(input as Record<string, unknown>) };
    },
  };
}

function makeFailing(name: string, reason = 'boom'): Tool<{ bundle: unknown }, Record<string, unknown>> {
  return {
    name,
    description: `failing tool ${name}`,
    inputSchema: z.object({ bundle: z.any() }).passthrough(),
    outputSchema: z.record(z.unknown()),
    async run() { throw new Error(reason); },
  };
}

function makeSkippable(name: string): Tool<{ bundle: unknown; shouldSkip?: boolean }, Record<string, unknown>> {
  return {
    name,
    description: `skippable tool ${name}`,
    inputSchema: z.object({ bundle: z.any(), shouldSkip: z.boolean().optional() }).passthrough(),
    outputSchema: z.record(z.unknown()),
    async preflight(input) {
      return input.shouldSkip ? { ok: false, reason: 'told to skip' } : { ok: true };
    },
    async run() { return { [`${name}_ran`]: true }; },
  };
}

describe('PipelineRunner', () => {
  const baseOpts = { workDir: '/tmp/test', logger: silentLogger };

  it('runs steps in order, merging outputs into state', async () => {
    const registry = new ToolRegistry()
      .register(makeEcho('first', () => ({ shared: 42 })))
      .register(makeEcho('second', (input) => ({ saw_shared: input.shared })));
    const runner = new PipelineRunner(registry);
    const spec: PipelineSpec = {
      name: 'chain', version: '1.0.0',
      steps: [{ tool: 'first' }, { tool: 'second' }],
    };
    const result = await runner.run(spec, bundle, baseOpts);
    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(result.results[1].output).toEqual({ second_ran: true, saw_shared: 42 });
  });

  it('aborts on first error when step is not optional', async () => {
    const registry = new ToolRegistry()
      .register(makeEcho('ok'))
      .register(makeFailing('fail'))
      .register(makeEcho('never'));
    const runner = new PipelineRunner(registry);
    const result = await runner.run({
      name: 'p', version: '1.0.0',
      steps: [{ tool: 'ok' }, { tool: 'fail' }, { tool: 'never' }],
    }, bundle, baseOpts);
    expect(result.ok).toBe(false);
    expect(result.results).toHaveLength(2);
    expect(result.results[1].ok).toBe(false);
    expect(result.results[1].error).toContain('boom');
  });

  it('continues past failures when step is optional', async () => {
    const registry = new ToolRegistry()
      .register(makeFailing('optional-fail'))
      .register(makeEcho('after'));
    const runner = new PipelineRunner(registry);
    const result = await runner.run({
      name: 'p', version: '1.0.0',
      steps: [{ tool: 'optional-fail', optional: true }, { tool: 'after' }],
    }, bundle, baseOpts);
    expect(result.results).toHaveLength(2);
    expect(result.results[0].ok).toBe(false);
    expect(result.results[1].ok).toBe(true);
    expect(result.ok).toBe(false);
  });

  it('preflight skip is not an error, pipeline continues', async () => {
    const registry = new ToolRegistry()
      .register(makeSkippable('maybe'))
      .register(makeEcho('after'));
    const runner = new PipelineRunner(registry);
    const result = await runner.run({
      name: 'p', version: '1.0.0',
      steps: [
        { tool: 'maybe', args: { shouldSkip: true } },
        { tool: 'after' },
      ],
    }, bundle, baseOpts);
    expect(result.results[0].skipped?.reason).toBe('told to skip');
    expect(result.results[1].ok).toBe(true);
    expect(result.ok).toBe(true);
  });

  it('input validation failure aborts when not optional', async () => {
    const strictTool: Tool<{ bundle: unknown; required: string }, Record<string, unknown>> = {
      name: 'strict',
      description: 'requires a string field',
      inputSchema: z.object({ bundle: z.any(), required: z.string() }).passthrough(),
      outputSchema: z.record(z.unknown()),
      async run() { return {}; },
    };
    const registry = new ToolRegistry().register(strictTool);
    const runner = new PipelineRunner(registry);
    const result = await runner.run({
      name: 'p', version: '1.0.0',
      steps: [{ tool: 'strict' }],
    }, bundle, baseOpts);
    expect(result.ok).toBe(false);
    expect(result.results[0].error).toMatch(/input validation/);
  });

  it('step args override state values', async () => {
    const registry = new ToolRegistry()
      .register(makeEcho('set', () => ({ color: 'red' })))
      .register(makeEcho('observe', (input) => ({ observed_color: input.color })));
    const runner = new PipelineRunner(registry);
    const result = await runner.run({
      name: 'p', version: '1.0.0',
      steps: [
        { tool: 'set' },
        { tool: 'observe', args: { color: 'blue' } },
      ],
    }, bundle, baseOpts);
    expect(result.results[1].output).toMatchObject({ observed_color: 'blue' });
  });
});

describe('ToolRegistry', () => {
  it('rejects duplicate registrations', () => {
    const reg = new ToolRegistry().register(makeEcho('a'));
    expect(() => reg.register(makeEcho('a'))).toThrowError(/already registered/);
  });

  it('reports unknown tools with known names in the error', () => {
    const reg = new ToolRegistry().register(makeEcho('foo')).register(makeEcho('bar'));
    expect(() => reg.get('missing')).toThrowError(/Known: bar, foo/);
  });

  it('list() returns descriptors with JSON schemas', () => {
    const reg = new ToolRegistry().register(makeEcho('alpha'));
    const [desc] = reg.list();
    expect(desc.name).toBe('alpha');
    expect((desc.inputSchema as { type: string }).type).toBe('object');
    expect((desc.outputSchema as { type: string }).type).toBe('object');
  });
});
