import { LarvaError } from "../core/errors.ts";
import { isRecord } from "../core/predicates.ts";

type Required = { required: readonly string[] };
type ObjectSchema = {
  type: "object"; properties: Record<string, Schema>; required?: readonly string[];
  additionalProperties: false; not?: Schema;
};
export type Schema = (
  | { type: "string"; minLength?: 1; maxLength?: number; enum?: readonly string[] }
  | { type: "integer"; minimum: number; maximum: number }
  | { type: "boolean" }
  | { type: "array"; items: Schema; minItems?: number; maxItems?: number; uniqueItems?: boolean }
  | ObjectSchema
  | Required
  | { anyOf: readonly Schema[] }
) & { description?: string };

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!isRecord(value)) return false;
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
      return Object.entries(value).every(([key, field]) => Object.hasOwn(schema.properties, key) && matches(schema.properties[key], field));
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
export const object = <T extends Record<string, Schema>>(properties: T, ...required: string[]) =>
  ({ type: "object", properties, required, additionalProperties: false } as const);
const described = <T extends Schema>(schema: T, description: string) => ({ ...schema, description });
const personaId = described(text, "Lowercase kebab-case Persona ID.");
const taskId = described(text, "Exact canonical child session task_id.");
const runEpoch = described(text, "Opaque run_epoch from the accepted receipt or status snapshot.");
const taskIds = described({ type: "array", items: taskId, minItems: 1, maxItems: 25, uniqueItems: true },
  "One to 25 distinct child session handles.");
export const epochGuard = object({ task_id: taskId, run_epoch: runEpoch }, "task_id", "run_epoch");
export const epochs = { type: "array", items: epochGuard, maxItems: 25 } as const;
const maxMs = 86_400_000;
const maxSliceLength = 4000;

export const commonToolSchemas = {
  larva_personas: object({
    query: described(string, "Search Persona IDs, descriptions, and model routes."),
    limit: described(integer(1, 50), "Maximum matches (default 20)."),
  }),
  larva_subagent: object({
    persona_id: personaId,
    task: described(text, "Instructions for the fresh or resumed child run."),
    task_id: described(taskId, "Exact child session handle to resume; omit to start a new session."),
    cwd: described(text, "Absolute workspace directory; omit on resume to use the recorded workspace."),
    no_progress_timeout_ms: described(integer(120_000, maxMs), "Consecutive silence in milliseconds before cancellation."),
    stall_alert_ms: described({ anyOf: [integer(0, 0), integer(60_000, maxMs)] },
      "Consecutive silence in milliseconds before a stall alert, or 0 to disable it."),
  }, "persona_id", "task"),
  larva_subagent_wait: object({
    task_ids: taskIds,
    return_when: described(choice("all", "any", "first_error"), "Readiness condition (default all)."),
    timeout_ms: described(integer(0, maxMs), "Total wait budget in milliseconds; 0 returns an immediate snapshot."),
  }, "task_ids"),
  larva_subagent_status: {
    ...object({
      task_id: taskId,
      scope: described(choice("active", "recent", "disk"), "List active, recent, or recorded runs (default recent)."),
      limit: described(integer(1, 25), "Maximum list entries (default 10)."),
    }),
    not: { anyOf: [{ required: ["task_id", "scope"] }, { required: ["task_id", "limit"] }] },
  },
  larva_subagent_activity: object({
    task_id: taskId,
    limit: described(integer(1, 20), "Maximum recent calls (default 5)."),
    cursor: described(text, "Opaque cursor for the next incremental page."),
    tool_name: described(text, "Exact recorded tool name."),
    since_timestamp: described(text, "Inclusive timezone-qualified ISO timestamp lower bound."),
    until_timestamp: described(text, "Inclusive timezone-qualified ISO timestamp upper bound."),
    tool_call_id: described(text, "Exact recorded tool-call ID for detail or segment lookup."),
    disambiguation_index: described(integer(0), "Zero-based candidate index for a duplicated tool-call ID."),
    entry_id: described(text, "Recorded entry ID to disambiguate a duplicated tool-call ID."),
    result_index: described(integer(0), "Zero-based recorded result index in file order."),
    segment_part: described(choice("args", "result"), "Read saved arguments or a recorded result (default result)."),
    offset: described(integer(0), "UTF-16 code-unit offset in the saved JSON."),
    length: described(integer(1, maxSliceLength), "Maximum UTF-16 code units to return."),
    source_version: described(text, "Source version token required for nonzero offsets."),
  }, "task_id"),
  larva_subagent_cancel: object({
    task_ids: taskIds,
    reason: described({ ...text, maxLength: 500 }, "Cancellation reason, up to 500 code points."),
    expected_run_epochs: described(epochs, "Optional epoch guards to avoid cancelling newer runs after a resume."),
  }, "task_ids", "reason"),
} satisfies Record<string, Schema>;

export const personaSwitchSchema = object({
  persona_id: personaId,
  reason: described({ ...text, maxLength: 1000 }, "Why the switch is needed. The switch handler caps the reason at 1,000 UTF-16 code units."),
  continue_task: described(boolean, "Run an immediate continuation. This must be the only tool call in the message."),
}, "persona_id", "reason");

export const searchMentionsSchema = object({
  query: described(string, "Text entered for Persona mention search."),
  preload: described(boolean, "Request preload results."),
  path: described({ type: "array", items: text }, "Non-empty components of the mention path."),
}, "query");

const statusSchema = commonToolSchemas.larva_subagent_status;
export const subagentPanelSchema = {
  ...statusSchema,
  properties: {
    ...statusSchema.properties,
    run_epochs: described({ ...epochs, minItems: 1 }, "Pin refreshes to the exact run instances."),
    slice: described(object({
      task_id: taskId,
      run_epoch: runEpoch,
      source: described(choice("prompt", "output"), "Read the initial prompt or completion output."),
      offset: described(integer(0), "Zero-based code-point offset."),
      length: described(integer(1, maxSliceLength), "Maximum code points to return."),
    }, "task_id", "source"), "Read a bounded page from a run's prompt or output."),
  },
} satisfies Schema;
