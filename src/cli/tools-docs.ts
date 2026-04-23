import type { ToolDescriptor } from '../core/tool-registry.js';

function jsonBlock(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function schemaSummary(schema: unknown): string {
  const s = schema as { properties?: Record<string, unknown>; required?: string[] };
  if (!s || typeof s !== 'object' || !s.properties) return jsonBlock(schema);
  const required = new Set(s.required ?? []);
  const lines: string[] = [];
  for (const [key, def] of Object.entries(s.properties)) {
    const typed = def as { type?: string; enum?: unknown[]; description?: string };
    const tag = typed.type ?? (typed.enum ? `enum(${typed.enum.join('|')})` : 'any');
    const req = required.has(key) ? ' (required)' : '';
    lines.push(`  - ${key}: ${tag}${req}`);
  }
  return lines.join('\n');
}

export function formatToolDescribeHuman(d: ToolDescriptor): string {
  const out: string[] = [];
  out.push(`Tool: ${d.name}`);
  out.push('');
  out.push(d.description);
  out.push('');
  out.push('Input schema:');
  out.push(schemaSummary(d.inputSchema));
  out.push('');
  out.push('Output schema:');
  out.push(schemaSummary(d.outputSchema));
  out.push('');

  if (d.examples.length > 0) {
    out.push('Examples:');
    for (const ex of d.examples) {
      out.push(`  * ${ex.description}`);
      out.push('      postiz-agent tools call ' + d.name + ' --id <slug> --input <file.json>');
      out.push('    where <file.json> contains:');
      for (const line of jsonBlock(ex.input).split('\n')) {
        out.push(`      ${line}`);
      }
    }
    out.push('');
  }

  if (d.composes.length > 0) {
    out.push('Typical next steps:');
    for (const next of d.composes) {
      out.push(`  -> ${next}`);
    }
    out.push('');
  }

  return out.join('\n');
}

export function formatToolsDocsIndex(descriptors: ToolDescriptor[]): string {
  const out: string[] = [];
  out.push(`${descriptors.length} tools registered. Use "postiz-agent tools docs <name>" for the full guide.`);
  out.push('');
  const nameWidth = Math.max(...descriptors.map(d => d.name.length));
  for (const d of descriptors) {
    out.push(`  ${d.name.padEnd(nameWidth)}  ${d.description}`);
  }
  out.push('');
  return out.join('\n');
}

export function formatToolDocs(d: ToolDescriptor): string {
  const out: string[] = [];
  out.push(`# ${d.name}`);
  out.push('');
  out.push('## Description');
  out.push('');
  out.push(d.description);
  out.push('');
  out.push('## Input');
  out.push('');
  out.push('```json');
  out.push(jsonBlock(d.inputSchema));
  out.push('```');
  out.push('');
  out.push('## Output');
  out.push('');
  out.push('```json');
  out.push(jsonBlock(d.outputSchema));
  out.push('```');
  out.push('');
  out.push('## Examples');
  out.push('');
  if (d.examples.length === 0) {
    out.push('(no examples declared for this tool)');
  } else {
    for (const ex of d.examples) {
      out.push(`### ${ex.description}`);
      out.push('');
      out.push('```bash');
      out.push(`postiz-agent tools call ${d.name} --id <slug> --input ./input.json`);
      out.push('```');
      out.push('');
      out.push('input.json:');
      out.push('');
      out.push('```json');
      out.push(jsonBlock(ex.input));
      out.push('```');
      out.push('');
    }
  }

  if (d.composes.length > 0) {
    out.push('## Typical next steps');
    out.push('');
    for (const next of d.composes) {
      out.push(`- \`${next}\``);
    }
    out.push('');
  }

  return out.join('\n');
}
