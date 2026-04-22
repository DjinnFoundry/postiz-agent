import { zodToJsonSchema } from './zod-json-schema.js';
import type { Tool } from './tool.js';

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: unknown;
  outputSchema: unknown;
}

/**
 * Central tool registry. Used by the pipeline runner to resolve steps by name
 * and by the `tools list`/`tools call` CLI (A.3) to expose tools to external
 * agents.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register<In, Out>(tool: Tool<In, Out>): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool as Tool);
    return this;
  }

  get(name: string): Tool {
    const t = this.tools.get(name);
    if (!t) throw new Error(`Tool not registered: ${name}. Known: ${this.names().join(', ') || '(none)'}`);
    return t;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  names(): string[] {
    return [...this.tools.keys()].sort();
  }

  list(): ToolDescriptor[] {
    return this.names().map(name => {
      const t = this.tools.get(name)!;
      return {
        name: t.name,
        description: t.description,
        inputSchema: zodToJsonSchema(t.inputSchema),
        outputSchema: zodToJsonSchema(t.outputSchema),
      };
    });
  }
}
