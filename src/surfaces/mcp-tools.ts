import { mcpActivityResult, inspectSubagentActivity } from "../activity/inspector.ts";
import { LarvaError, toErrorEnvelope } from "../core/errors.ts";
import { isRecord } from "../core/predicates.ts";
import type {
  ActivityQuery, McpSubagentToolInput, PersonasToolInput, RunSnapshot, SearchMentionsToolInput,
  SubagentCancelToolInput, SubagentPanelToolInput, SubagentPanelOutput, SubagentStatusToolInput, SubagentWaitToolInput,
} from "../core/types.ts";
import type { SubagentSupervisor } from "../runtime/supervisor.ts";
import type { PersonaStore } from "../store/persona-store.ts";
import { buildSearchMentionsOutput } from "../ui/codex-mentions.ts";
import { CODEX_PANEL_DISPLAY_MODES, CODEX_PANEL_URI } from "../ui/codex-panel-html.ts";
import { CODEX_WIDGET_DISPLAY_MODES, CODEX_WIDGET_URI } from "../ui/codex-widget-html.ts";
import { admitToolInput, boolean, commonToolSchemas, searchMentionsSchema, subagentPanelSchema, text, type Schema } from "./tool-schemas.ts";

const bad = (message: string): never => { throw new LarvaError("LARVA_BAD_INPUT", message); };

const { larva_subagent: spawnSchema, larva_subagent_status: statusSchema } = commonToolSchemas;
const modelUi = { ui: { visibility: ["model", "app"] } };
const widgetUi = {
  ui: { ...modelUi.ui, resourceUri: CODEX_WIDGET_URI },
  "openai/ui": { preferredModelDisplayMode: "inline", availableDisplayModes: CODEX_WIDGET_DISPLAY_MODES },
};

type SpawnContext = Extract<Parameters<SubagentSupervisor["spawn"]>[1], { surface: "mcp" }>;
type ListRoots = SpawnContext["listRoots"];

function tool<T extends object>(name: string, description: string, inputSchema: Schema, _meta: Record<string, unknown>,
  handler: (input: T, listRoots?: ListRoots, signal?: AbortSignal) => unknown,
) {
  return {
    definition: { name, description, inputSchema, _meta },
    invoke(input: unknown, listRoots?: ListRoots, signal?: AbortSignal) {
      return handler(admitToolInput<T>(name, inputSchema, input), listRoots, signal);
    },
  };
}

function result(data: object, text: string, isError = false) {
  return { content: [{ type: "text", text }], structuredContent: data, isError };
}

const describeRuns = (data: SubagentPanelOutput) =>
  `${data.disk_sessions?.length ?? data.runs.length} ${data.disk_sessions ? "recorded sessions" : "run snapshots"}; ${data.startup_failures.length} startup failures.`;

export function createMcpTools(supervisor: SubagentSupervisor, personas: PersonaStore, maxMessageBytes: number) {
  // Reject catalogs whose rows alone exceed the wire budget before serializing
  // the whole result. The transport accounts for the envelope and framing.
  function checkCatalogSize(rows: readonly object[], copies: number) {
    let bytes = 0;
    for (const row of rows) {
      bytes += copies * Buffer.byteLength(JSON.stringify(row));
      if (bytes > maxMessageBytes) {
        throw new LarvaError("LARVA_INTERNAL_ERROR", "Catalog response exceeds the transport limit. Narrow the query.", { matches: rows.length });
      }
    }
  }
  const registry = [
    tool<PersonasToolInput>("larva_personas", "Search installed Larva personas without returning prompts.",
      commonToolSchemas.larva_personas, modelUi,
      async args => {
        const matches = await personas.list({ ...args, limit: args.limit ?? 20 });
        checkCatalogSize(matches, 1);
        return result({ personas: matches }, `${matches.length} matching personas.`);
      }),
    tool<McpSubagentToolInput>("larva_subagent", "Start or resume an isolated Pi subagent.", {
      ...spawnSchema, properties: { ...spawnSchema.properties, wait_for_completion: boolean, parent_persona_id: text },
    }, widgetUi, async (args, listRoots, signal) => {
      const context = { surface: "mcp" as const, listRoots, signal };
      const data = await supervisor.spawn(args, context);
      return result(data, `${args.persona_id}: ${data.status}.`, data.status === "failed" || data.status === "cancelled");
    }),
    tool<SubagentWaitToolInput>("larva_subagent_wait", "Observe exact run instances without consuming their outputs.",
      commonToolSchemas.larva_subagent_wait, widgetUi, async (args, _, signal) => {
        const data = await supervisor.wait(args, "mcp", signal);
        return result(data, `${data.ready ? "Wait ready" : "Wait not ready"}${data.timed_out ? " (timed out)" : ""}; ${data.runs.length} run snapshots.`);
      }),
    tool<SubagentStatusToolInput>("larva_subagent_status", "Inspect an exact task or list active, recent, or recorded sessions.",
      statusSchema, widgetUi, async args => {
        const data = await supervisor.status(args);
        return result(data, describeRuns(data));
      }),
    tool<ActivityQuery>("larva_subagent_activity", "Read recorded tool activity from an exact task transcript.",
      commonToolSchemas.larva_subagent_activity, modelUi, async args => {
        return mcpActivityResult(await inspectSubagentActivity(supervisor.home, args));
      }),
    tool<SubagentCancelToolInput>("larva_subagent_cancel", "Cancel active local runs by exact task_id (omit expected_run_epochs unless guarding against a concurrent resume).",
      commonToolSchemas.larva_subagent_cancel, modelUi, async args => {
        const data = await supervisor.cancel(args);
        return result(data, data.results.map(({ outcome }) => outcome.replaceAll("_", " ")).join(", ") + ".", data.isError);
      }),
    tool<SearchMentionsToolInput>("search_mentions", "Find Persona mention resources.",
      searchMentionsSchema,
      { ui: { visibility: ["app"] }, "openai/extensions": { "mentions/search": { preload: true } } },
      async args => {
        const data = await buildSearchMentionsOutput(personas, args);
        checkCatalogSize(data.items, 2); // Links appear in both content and structuredContent.
        return { content: [{ type: "text", text: `${data.items.length} matching Persona resources.` }, ...data.items], structuredContent: data, isError: false };
      }),
    tool<SubagentPanelToolInput>("larva_subagent_panel", "View sessions or recover exact run epochs for an inline card.",
      {
        ...subagentPanelSchema,
        not: { anyOf: [
          ...statusSchema.not.anyOf,
          ...["task_id", "scope", "limit", "run_epochs"].map(key => ({ required: ["slice", key] })),
          ...["task_id", "scope", "limit"].map(key => ({ required: ["run_epochs", key] })),
        ] },
      }, {
        ui: { visibility: ["app"], resourceUri: CODEX_PANEL_URI },
        "openai/ui": { entrypoints: [{ type: "thread" }], availableDisplayModes: CODEX_PANEL_DISPLAY_MODES },
      }, async ({ run_epochs, slice, ...query }) => {
        if (slice) {
          const page = await supervisor.readRunTextSlice(slice);
          return result({ runs: [], startup_failures: [], slice: page } satisfies SubagentPanelOutput,
            page.state === "ok" ? `Read ${page.length} code points of ${slice.source}.` : "Text slice unavailable.");
        }
        if (!run_epochs) {
          const data = await supervisor.status(query);
          return result(data, describeRuns(data));
        }
        if (new Set(run_epochs.map(({ task_id }) => task_id)).size !== run_epochs.length) {
          return bad("Pinned epochs must have unique task_ids.");
        }
        const runs: RunSnapshot[] = [];
        const row_errors = [];
        const settled = await Promise.allSettled(run_epochs.map(({ task_id, run_epoch }) => supervisor.pinned(task_id, run_epoch)));
        for (const [index, outcome] of settled.entries()) {
          if (outcome.status === "fulfilled") {
            if ("status" in outcome.value) runs.push(outcome.value);
          } else row_errors.push({ ...run_epochs[index], ...toErrorEnvelope(outcome.reason) });
        }
        return result({ runs, startup_failures: [], row_errors }, `${runs.length} pinned runs; ${row_errors.length} row errors.`);
      }),
  ];

  return {
    definitions: registry.map(entry => entry.definition),
    async call(name: string, args: unknown, listRoots?: ListRoots, signal?: AbortSignal) {
      try {
        signal?.throwIfAborted();
        const entry = registry.find(item => item.definition.name === name);
        if (!entry) return bad("Unknown tool name.");
        if (!isRecord(args)) return bad(`Invalid arguments for ${name}.`);
        return await entry.invoke(args, listRoots, signal);
      } catch (error) {
        const data = toErrorEnvelope(error);
        return result(data, data.error.message, true);
      }
    },
  };
}
