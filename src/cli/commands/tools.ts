import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { config } from '../../config.js';
import { createDefaultRegistry } from '../../tools/index.js';
import { consoleLogger, silentLogger } from '../../core/tool.js';
import { formatToolDescribeHuman, formatToolsDocsIndex, formatToolDocs } from '../tools-docs.js';
import { resolveBundle } from '../runner.js';
import { printJsonPretty } from '../io.js';

/**
 * `tools`: introspect and invoke individual tools the way an external agent
 * would. `list` enumerates the registry, `describe` prints the full descriptor
 * (input/output schema + examples + composes), `docs` prints the markdown
 * guide, `call` runs one tool against a bundle.
 */
export function register(program: Command): void {
  const tools = program
    .command('tools')
    .description('Introspect and invoke individual tools (for agent consumption)');

  tools
    .command('list')
    .description('List every registered tool with its JSON schema and description')
    .option('--json', 'emit machine-readable JSON only (no decoration)', false)
    .action((opts: { json?: boolean }) => {
      const registry = createDefaultRegistry();
      const descriptors = registry.list();
      if (opts.json) {
        printJsonPretty(descriptors);
        return;
      }
      console.log(`\n${descriptors.length} tools registered:\n`);
      for (const d of descriptors) {
        console.log(`  • ${d.name}`);
        console.log(`      ${d.description}`);
      }
      console.log('\nCall one with:');
      console.log('  postiz-agent tools call <name> --input <file.json>');
      console.log('  postiz-agent tools describe <name>  (full JSON schemas)\n');
    });

  tools
    .command('describe')
    .description('Print the full descriptor for a single tool (schemas, examples, composes)')
    .argument('<name>', 'tool name')
    .option('--json', 'emit the descriptor as JSON (default is a human-readable summary)', false)
    .action((name: string, opts: { json?: boolean }) => {
      const registry = createDefaultRegistry();
      if (!registry.has(name)) {
        console.error(`unknown tool: ${name}. Available: ${registry.names().join(', ')}`);
        process.exit(1);
      }
      const [descriptor] = registry.list().filter(d => d.name === name);
      if (opts.json) {
        printJsonPretty(descriptor);
        return;
      }
      process.stdout.write(formatToolDescribeHuman(descriptor) + '\n');
    });

  tools
    .command('docs')
    .description('Print a markdown-ish guide for all tools, or for a single tool when a name is passed')
    .argument('[name]', 'tool name (omit to list every tool)')
    .action((name: string | undefined) => {
      const registry = createDefaultRegistry();
      const descriptors = registry.list();
      if (!name) {
        process.stdout.write(formatToolsDocsIndex(descriptors) + '\n');
        return;
      }
      if (!registry.has(name)) {
        console.error(`unknown tool: ${name}. Available: ${registry.names().join(', ')}`);
        process.exit(1);
      }
      const descriptor = descriptors.find(d => d.name === name)!;
      process.stdout.write(formatToolDocs(descriptor) + '\n');
    });

  tools
    .command('call')
    .description('Execute a single tool against a bundle. Bundle is loaded from the AudioKids adapter by --id, or fully passed via --bundle-file.')
    .argument('<name>', 'tool name')
    .option('--id <id>', 'ContentBundle id (e.g. an AudioKids story slug) to load via adapter')
    .option('--bundle-file <path>', 'path to a JSON file with a complete ContentBundle (alternative to --id)')
    .option('--input <path>', 'path to a JSON file with the tool arguments merged into the input', '')
    .option('--work-dir <path>', 'writable workspace for the tool', '')
    .option('--dry-run', 'hint to the tool not to perform side effects', false)
    .option('--quiet', 'silence the tool logger', false)
    .option('--json', 'emit machine-readable JSON only (stdout stays clean)', false)
    .action(async (name: string, opts: {
      id?: string; bundleFile?: string; input?: string; workDir?: string; dryRun?: boolean; quiet?: boolean; json?: boolean;
    }) => {
      const registry = createDefaultRegistry();
      if (!registry.has(name)) {
        console.error(`unknown tool: ${name}. Available: ${registry.names().join(', ')}`);
        process.exit(1);
      }
      const bundle = resolveBundle(opts);
      const workDir = opts.workDir?.trim() || join(config.paths.tmpDir, bundle.id);
      const args = opts.input ? JSON.parse(readFileSync(opts.input, 'utf-8')) : {};

      const tool = registry.get(name);
      const rawInput = { ...args, bundle, workDir, dryRun: opts.dryRun };
      const parsed = tool.inputSchema.safeParse(rawInput);
      if (!parsed.success) {
        console.error(`input validation failed for "${name}": ${parsed.error.message}`);
        process.exit(1);
      }
      const ctx = {
        bundle,
        workDir,
        state: {} as Record<string, unknown>,
        dryRun: opts.dryRun,
        logger: opts.quiet || opts.json ? silentLogger : consoleLogger,
      };
      if (tool.preflight) {
        const pre = await tool.preflight(parsed.data, ctx);
        if (!pre.ok) {
          printJsonPretty({ ok: false, skipped: true, reason: pre.reason });
          process.exit(0);
        }
      }
      try {
        const out = await tool.run(parsed.data, ctx);
        tool.outputSchema.parse(out);
        printJsonPretty({ ok: true, output: out });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        printJsonPretty({ ok: false, error: msg });
        process.exit(1);
      }
    });
}
