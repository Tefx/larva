import { LarvaError } from "../core/errors.ts";

type Required = { required: readonly string[] };
type ObjectSchema = {
  type: "object"; properties?: Record<string, Schema>; required?: readonly string[];
  additionalProperties: false | Schema; minProperties?: number; maxProperties?: number; not?: Schema;
};
export type Schema =
  | { type: "string"; minLength?: 1; maxLength?: number; enum?: readonly string[] }
  | { type: "integer"; minimum: number; maximum: number }
  | { type: "boolean" }
  | { type: "array"; items: Schema; minItems?: number; maxItems?: number; uniqueItems?: boolean }
  | ObjectSchema
  | Required
  | { anyOf: readonly Schema[] };

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
};
const hasRequired = (value: object, keys: readonly string[]) => keys.every(key => Object.hasOwn(value, key));

function matches(schema: Schema, value: unknown): boolean {
  if ("anyOf" in schema) return schema.anyOf.some(option => matches(option, value));
  if (!("type" in schema)) return isPlainObject(value) && hasRequired(value, schema.required);
  switch (schema.type) {
    case "string": {
      if (typeof value !== "string" || (schema.minLength && !value.length) || (schema.enum && !schema.enum.includes(value))) return false;
      if (schema.maxLength === undefined) return true;
      // Count code points without making an unbounded copy of an external string.
      let length = 0;
      for (const _ of value) if (++length > schema.maxLength) return false;
      return true;
    }
    case "boolean": return typeof value === "boolean";
    case "integer": return typeof value === "number" && Number.isSafeInteger(value) && value >= schema.minimum && value <= schema.maximum;
    case "array": return Array.isArray(value) && value.length >= (schema.minItems ?? 0) && value.length <= (schema.maxItems ?? Infinity)
      && (!schema.uniqueItems || new Set(value).size === value.length) && value.every(item => matches(schema.items, item));
    case "object": {
      if (!isPlainObject(value) || !hasRequired(value, schema.required ?? []) || (schema.not && matches(schema.not, value))) return false;
      const entries = Object.entries(value);
      return entries.length >= (schema.minProperties ?? 0) && entries.length <= (schema.maxProperties ?? Infinity)
        && entries.every(([key, field]) => {
          const rule = schema.properties && Object.hasOwn(schema.properties, key) ? schema.properties[key] : schema.additionalProperties;
          return rule !== false && matches(rule, field);
        });
    }
  }
}

// Validate the advertised JSON Schema before transport-specific coercion or domain checks.
export function admitToolInput<Input>(name: string, schema: Schema, input: unknown): Input {
  if (!matches(schema, input)) throw new LarvaError("LARVA_BAD_INPUT", `Invalid arguments for ${name}.`);
  return input as Input;
}

export const string = { type: "string" } as const;
export const text = { ...string, minLength: 1 } as const;
export const boolean = { type: "boolean" } as const;
const integer = (minimum: number, maximum = Number.MAX_SAFE_INTEGER) => ({ type: "integer", minimum, maximum } as const);
const choice = (...values: string[]) => ({ ...string, enum: values });
export const object = (properties: Record<string, Schema>, ...required: string[]) => ({ type: "object", properties, required, additionalProperties: false } as const);
const taskIds = { type: "array", items: text, minItems: 1, maxItems: 25, uniqueItems: true } as const;
export const epochs = { type: "object", additionalProperties: text, maxProperties: 25 } as const;
const maxMs = 86_400_000;

export const commonToolSchemas = {
  larva_personas: object({ query: string, limit: integer(1, 50) }),
  larva_subagent: object({
    persona_id: text, task: text, task_id: text, cwd: text, no_progress_timeout_ms: integer(120_000, maxMs),
    stall_alert_ms: { anyOf: [integer(0, 0), integer(60_000, maxMs)] },
  }, "persona_id", "task"),
  larva_subagent_wait: object({ task_ids: taskIds, return_when: choice("all", "any", "first_error"), timeout_ms: integer(0, maxMs) }, "task_ids"),
  larva_subagent_status: {
    ...object({ task_id: text, scope: choice("active", "recent", "disk"), limit: integer(1, 25) }),
    not: { anyOf: [{ required: ["task_id", "scope"] }, { required: ["task_id", "limit"] }] },
  },
  larva_subagent_activity: object({
    task_id: text, limit: integer(1, 20), cursor: text, tool_name: text, since_timestamp: text, until_timestamp: text,
    tool_call_id: text, disambiguation_index: integer(0), entry_id: text, result_index: integer(0),
    segment_part: choice("args", "result"), offset: integer(0), length: integer(1, 4000), source_version: text,
  }, "task_id"),
  larva_subagent_cancel: object({ task_ids: taskIds, reason: { ...text, maxLength: 500 }, expected_run_epochs: epochs }, "task_ids", "reason"),
} satisfies Record<string, Schema>;
