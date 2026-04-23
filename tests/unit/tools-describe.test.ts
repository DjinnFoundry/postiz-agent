import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '../../src/tools/index.js';
import {
  formatToolDescribeHuman,
  formatToolsDocsIndex,
  formatToolDocs,
} from '../../src/cli/tools-docs.js';
import type { ToolDescriptor } from '../../src/core/tool-registry.js';

describe('tool registry enrichment', () => {
  const registry = createDefaultRegistry();
  const descriptors = registry.list();

  it('every registered tool has an examples array in its descriptor', () => {
    for (const d of descriptors) {
      expect(Array.isArray(d.examples)).toBe(true);
    }
  });

  it('every registered tool has a composes array (possibly empty)', () => {
    for (const d of descriptors) {
      expect(Array.isArray(d.composes)).toBe(true);
    }
  });

  it('transcribe has at least one example with description + input', () => {
    const t = descriptors.find(d => d.name === 'transcribe');
    expect(t).toBeDefined();
    expect(t!.examples.length).toBeGreaterThanOrEqual(1);
    for (const ex of t!.examples) {
      expect(typeof ex.description).toBe('string');
      expect(ex.description.length).toBeGreaterThan(0);
      expect(typeof ex.input).toBe('object');
    }
  });

  it('transcribe composes into moderate-captions and render-slide-video', () => {
    const t = descriptors.find(d => d.name === 'transcribe');
    expect(t!.composes).toEqual(expect.arrayContaining(['moderate-captions', 'render-slide-video']));
  });

  it('resolve-theme composes into render-slide-video', () => {
    const t = descriptors.find(d => d.name === 'resolve-theme');
    expect(t!.composes).toContain('render-slide-video');
  });

  it('every composes entry references a registered tool name', () => {
    const allNames = new Set(descriptors.map(d => d.name));
    for (const d of descriptors) {
      for (const next of d.composes) {
        expect(allNames.has(next)).toBe(true);
      }
    }
  });
});

describe('formatToolDescribeHuman', () => {
  const registry = createDefaultRegistry();
  const descriptors = registry.list();
  const transcribe = descriptors.find(d => d.name === 'transcribe')!;

  it('includes the tool name and description', () => {
    const out = formatToolDescribeHuman(transcribe);
    expect(out).toContain('transcribe');
    expect(out).toContain(transcribe.description);
  });

  it('includes an Examples: section with at least one example', () => {
    const out = formatToolDescribeHuman(transcribe);
    expect(out).toMatch(/Examples:/);
    expect(out).toContain(transcribe.examples[0].description);
  });

  it('includes a Typical next steps section when composes is non-empty', () => {
    const out = formatToolDescribeHuman(transcribe);
    expect(out).toMatch(/Typical next steps/i);
    expect(out).toContain('moderate-captions');
  });

  it('renders JSON input payloads for each example', () => {
    const out = formatToolDescribeHuman(transcribe);
    const example = transcribe.examples[0];
    const keys = Object.keys(example.input);
    if (keys.length > 0) {
      expect(out).toContain(keys[0]);
    }
  });

  it('omits Typical next steps when composes is empty', () => {
    const stub: ToolDescriptor = {
      name: 'standalone',
      description: 'a leaf tool',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      examples: [{ description: 'trivial', input: {} }],
      composes: [],
    };
    const out = formatToolDescribeHuman(stub);
    expect(out).not.toMatch(/Typical next steps/i);
  });
});

describe('formatToolsDocsIndex', () => {
  const registry = createDefaultRegistry();
  const descriptors = registry.list();

  it('lists every tool name with its one-line description', () => {
    const out = formatToolsDocsIndex(descriptors);
    for (const d of descriptors) {
      expect(out).toContain(d.name);
    }
  });

  it('includes a header line referencing tools docs <name>', () => {
    const out = formatToolsDocsIndex(descriptors);
    expect(out).toMatch(/tools docs <name>/);
  });
});

describe('formatToolDocs', () => {
  const registry = createDefaultRegistry();
  const descriptors = registry.list();
  const transcribe = descriptors.find(d => d.name === 'transcribe')!;

  it('renders a markdown-ish guide with headings', () => {
    const out = formatToolDocs(transcribe);
    expect(out).toContain(`# ${transcribe.name}`);
    expect(out).toMatch(/## Description/);
    expect(out).toMatch(/## Input/);
    expect(out).toMatch(/## Output/);
    expect(out).toMatch(/## Examples/);
  });

  it('includes composes section when present', () => {
    const out = formatToolDocs(transcribe);
    expect(out).toMatch(/## Typical next steps|## Composes/);
    expect(out).toContain('moderate-captions');
  });
});
