import { z, type ZodTypeAny } from 'zod';

/**
 * Minimal Zod → JSON Schema converter for the tool descriptor API (A.3).
 * Covers the Zod constructs we actually use: string, number, boolean, enum,
 * array, object, record, union, literal, optional, nullable, default,
 * and tolerates unknowns by emitting {} (permissive).
 *
 * Not a drop-in replacement for `zod-to-json-schema`; just enough for agents
 * to understand what each tool expects.
 */
type AnyDef = {
  typeName: string;
  value?: unknown;
  values?: unknown;
  type?: ZodTypeAny;
  shape?: () => Record<string, ZodTypeAny>;
  valueType?: ZodTypeAny;
  options?: ZodTypeAny[];
  innerType?: ZodTypeAny;
  checks?: Array<{ kind: string; value?: number }>;
};

function getDef(schema: ZodTypeAny): AnyDef {
  return (schema as unknown as { _def: AnyDef })._def;
}

export function zodToJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  const def = getDef(schema);
  const tn = def.typeName;

  switch (tn) {
    case 'ZodString': {
      const out: Record<string, unknown> = { type: 'string' };
      for (const c of def.checks ?? []) {
        if (c.kind === 'min') out.minLength = c.value;
        if (c.kind === 'max') out.maxLength = c.value;
      }
      return out;
    }
    case 'ZodNumber': {
      const out: Record<string, unknown> = { type: 'number' };
      for (const c of def.checks ?? []) {
        if (c.kind === 'int') out.type = 'integer';
        if (c.kind === 'min') out.minimum = c.value;
        if (c.kind === 'max') out.maximum = c.value;
      }
      return out;
    }
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodNull':
      return { type: 'null' };
    case 'ZodLiteral':
      return { const: def.value };
    case 'ZodEnum':
      return { type: 'string', enum: [...(def.values as string[])] };
    case 'ZodNativeEnum':
      return { enum: Object.values(def.values as Record<string, unknown>) };
    case 'ZodArray':
      return {
        type: 'array',
        items: def.type ? zodToJsonSchema(def.type) : {},
      };
    case 'ZodObject': {
      const shape = def.shape ? def.shape() : {};
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value);
        if (!isOptional(value)) required.push(key);
      }
      const out: Record<string, unknown> = { type: 'object', properties };
      if (required.length) out.required = required;
      return out;
    }
    case 'ZodRecord':
      return {
        type: 'object',
        additionalProperties: def.valueType ? zodToJsonSchema(def.valueType) : {},
      };
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion':
      return { anyOf: (def.options ?? []).map(zodToJsonSchema) };
    case 'ZodOptional':
    case 'ZodDefault':
    case 'ZodNullable':
      return def.innerType ? zodToJsonSchema(def.innerType) : {};
    case 'ZodAny':
    case 'ZodUnknown':
      return {};
    default:
      return {};
  }
}

function isOptional(schema: ZodTypeAny): boolean {
  const def = getDef(schema);
  if (def.typeName === 'ZodOptional' || def.typeName === 'ZodDefault') return true;
  if (def.typeName === 'ZodNullable' && def.innerType) return isOptional(def.innerType);
  return false;
}

// keep the import live for downstream consumers
void z;
