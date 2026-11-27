import { inspectSubagentActivity } from "../activity/inspector.ts";
import { LarvaError, toErrorEnvelope } from "../core/errors.ts";
import type {
  ActivityQuery, McpSubagentToolInput, PersonasToolInput, SearchMentionsToolInput,
  SubagentCancelToolInput, SubagentPanelToolInput, SubagentPanelOutput, SubagentStatusToolInput, SubagentWaitToolInput,
} from "../core/types.ts";
import { isTerminal, terminalOutput } from "../runtime/outbox.ts";
import type { SubagentSupervisor } from "../runtime/supervisor.ts";
import type { PersonaStore } from "../store/persona-store.ts";
import { buildSearchMentionsOutput } from "../ui/codex-mentions.ts";
import { CODEX_PANEL_DISPLAY_MODES, CODEX_PANEL_URI } from "../ui/codex-panel-html.ts";
import { CODEX_WIDGET_DISPLAY_MODES, CODEX_WIDGET_URI } from "../ui/codex-widget-html.ts";
import { admitToolInput, boolean, commonToolSchemas, epochs, object, string, text, type Schema } from "./tool-schemas.ts";

export const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
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
  handler: (input: T, listRoots?: ListRoots) => unknown,
) {
  return {
    definition: { name, description, inputSchema, _meta },
    invoke(input: unknown, listRoots?: ListRoots) {
      return handler(admitToolInput<T>(name, inputSchema, input), listRoots);
    },
  };
}

function result(data: object, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, isError };
}

export function createMcpTools(supervisor: SubagentSupervisor, personas: PersonaStore) {
  const registry = [
    tool<PersonasToolInput>("larva_personas", "Search installed Larva personas without returning prompts.",
      commonToolSchemas.larva_personas, modelUi,
      async args => result({ personas: await personas.list({ ...args, limit: args.limit ?? 20 }) })),
    tool<McpSubagentToolInput>("larva_subagent", "Start or resume an isolated Pi subagent.", {
      ...spawnSchema, properties: { ...spawnSchema.properties, wait_for_completion: boolean, parent_persona_id: text },
    }, widgetUi, async (args, listRoots) => result(await supervisor.spawn(args, { surface: "mcp", listRoots }))),
    tool<SubagentWaitToolInput>("larva_subagent_wait", "Observe exact run instances without consuming their outputs.",
      commonToolSchemas.larva_subagent_wait, widgetUi, async args => result(await supervisor.wait(args))),
    tool<SubagentStatusToolInput>("larva_subagent_status", "Inspect an exact task or list active, recent, or recorded sessions.",
      statusSchema, widgetUi, async args => result(await supervisor.status(args))),
    tool<ActivityQuery>("larva_subagent_activity", "Read recorded tool activity from an exact task transcript.",
      commonToolSchemas.larva_subagent_activity, modelUi, async args => {
      const data = await inspectSubagentActivity(supervisor.home, args);
      return result(data, data.status === "failed" || data.status === "not_found");
    }),
    tool<SubagentCancelToolInput>("larva_subagent_cancel", "Cancel active local runs by exact task_id (omit expected_run_epochs unless guarding against a concurrent resume).",
      commonToolSchemas.larva_subagent_cancel, modelUi, async args => {
        const data = await supervisor.cancel(args);
        return result(data, data.isError);
      }),
    tool<SearchMentionsToolInput>("search_mentions", "Find Persona mention resources.",
      object({ query: string, preload: boolean, path: { type: "array", items: string } }, "query"),
      { ui: { visibility: ["app"] }, "openai/extensions": { "mentions/search": { preload: true } } },
      async args => {
        const data = buildSearchMentionsOutput(await personas.list(), args);
        return { content: data.items, structuredContent: data, isError: false };
      }),
    tool<SubagentPanelToolInput>("larva_subagent_panel", "View sessions or recover exact run epochs for an inline card.",
      { ...statusSchema, properties: { ...statusSchema.properties, run_epochs: { ...epochs, minItems: 1 } } }, {
        ui: { visibility: ["app"], resourceUri: CODEX_PANEL_URI },
        "openai/ui": { entrypoints: [{ type: "thread" }], availableDisplayModes: CODEX_PANEL_DISPLAY_MODES },
      }, async ({ run_epochs, ...query }) => {
        if (!run_epochs) return result(await supervisor.status(query));
        if (new Set(run_epochs.map(({ task_id }) => task_id)).size !== run_epochs.length) {
          return bad("Pinned epochs must have unique task_ids.");
        }
        if (query.task_id !== undefined && (run_epochs.length !== 1 || run_epochs[0].task_id !== query.task_id)) {
          return bad("Pinned epochs must match the requested task_id.");
        }
        // An absent pinned pair tells the app to recover its captured output
        // or show the expired notice. Never substitute a newer run's metadata.
        const runs = (await Promise.all(run_epochs.map(({ task_id, run_epoch }) => supervisor.pinned(task_id, run_epoch))))
          .flatMap(run => run.output_state !== "evicted" ? [run] : []);
        const terminal_outputs = Object.fromEntries(runs.flatMap(run => isTerminal(run.status)
          ? [[run.task_id, terminalOutput(run)]] : []));
        return result({ runs, startup_failures: [], terminal_outputs } satisfies SubagentPanelOutput);
      }),
  ];

  return {
    definitions: registry.map(entry => entry.definition),
    async call(name: string, args: unknown, listRoots?: ListRoots) {
      try {
        const entry = registry.find(item => item.definition.name === name);
        if (!entry) return bad("Unknown tool name.");
        return await entry.invoke(args, listRoots);
      } catch (error) {
        return result(toErrorEnvelope(error), true);
      }
    },
  };
}
