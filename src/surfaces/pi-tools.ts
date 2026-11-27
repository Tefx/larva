import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { inspectSubagentActivity } from "../activity/inspector.ts";
import { toErrorEnvelope } from "../core/errors.ts";
import type { ActivityQuery, PersonasToolInput, SubagentCancelToolInput, SubagentStatusToolInput, SubagentToolInput, SubagentWaitToolInput } from "../core/types.ts";
import type { PersonaSwitchContext } from "../runtime/persona-lease.ts";
import type { SessionContext } from "../runtime/session-context.ts";
import type { SubagentSupervisor } from "../runtime/supervisor.ts";
import type { PersonaStore } from "../store/persona-store.ts";
import { metadataObject } from "../store/capsule.ts";
import { confirmPersonaSwitch, terminalText } from "../ui/pi-selector-tui.ts";
import { admitToolInput, boolean, commonToolSchemas, object, text, type Schema } from "./tool-schemas.ts";

export function registerPiTools(pi: ExtensionAPI, bindings: {
  current(): { session: SessionContext; supervisor: SubagentSupervisor; personas: PersonaStore; key: string };
  authorize(name: string): Promise<void>;
}) {
  const active = new Set<string>();
  const observed = new Set<string>();
  pi.on("turn_start", () => observed.clear());
  pi.on("tool_execution_start", ({ toolCallId }) => { active.add(toolCallId); observed.add(toolCallId); });
  pi.on("tool_execution_end", ({ toolCallId }) => { active.delete(toolCallId); observed.add(toolCallId); });
  pi.on("tool_call", async ({ toolName }) => {
    try { await bindings.authorize(toolName); }
    catch (error) { return { block: true, reason: JSON.stringify(toErrorEnvelope(error)) }; }
  });

  type Invocation = ReturnType<typeof bindings.current>;
  function register<Input>(name: string, description: string, schema: Schema, run: (input: Input, state: Invocation,
    ctx: ExtensionContext, toolCallId: string, signal?: AbortSignal) => unknown,
    presentation?: Pick<ToolDefinition, "renderCall" | "renderResult"> & { acceptedGuidance?: string }) {
    const admit = (input: unknown) => admitToolInput<Input>(name, schema, input);
    pi.registerTool({ name, label: name, description, parameters: schema as ToolDefinition["parameters"],
      // Pi otherwise coerces wrong-type model inputs before calling execute().
      prepareArguments: admit,
      ...(presentation && { renderCall: presentation.renderCall, renderResult: presentation.renderResult }),
      async execute(toolCallId, params, signal, _update, ctx) {
        try {
          await bindings.authorize(name);
          const data = await run(admit(params), bindings.current(), ctx, toolCallId, signal);
          const flags = data as { terminate?: boolean; isError?: boolean; ok?: boolean; status?: string };
          const guidance = flags.status === "accepted" ? presentation?.acceptedGuidance : undefined;
          // Keep the model-facing receipt parseable as one JSON object and
          // leave structured details unchanged for RPC and other consumers.
          const serialized = JSON.stringify(guidance && metadataObject(data) ? { ...data, guidance } : data);
          return { content: [{ type: "text", text: serialized }], details: data,
            isError: flags.isError || flags.ok === false || flags.status === "failed", terminate: flags.terminate };
        } catch (error) {
          const data = toErrorEnvelope(error);
          return { content: [{ type: "text", text: JSON.stringify(data) }], details: data, isError: true };
        }
      },
    });
  }

  register<PersonasToolInput>("larva_personas", "Search local Larva personas without exposing their prompts.",
    commonToolSchemas.larva_personas,
    ({ query, limit = 20 }, { personas }) => personas.list({ query, limit }));
  register<unknown>("larva_persona_switch", "Request a persona switch. A continuation requires this to be the only tool call in the assistant message.",
    object({ persona_id: text, reason: text, continue_task: boolean }, "persona_id", "reason"),
    async (input, { session }, ctx, toolCallId, signal) => {
      const request: PersonaSwitchContext = {
        mode: ctx.mode === "json" ? "print" : ctx.mode, toolCallId, signal,
        toolBatch() {
          const assistant = ctx.sessionManager.getBranch().findLast(e => e.type === "message" && e.message.role === "assistant");
          return {
            assistantCallIds: assistant?.type === "message" && assistant.message.role === "assistant"
              ? assistant.message.content.flatMap(part => part.type === "toolCall" ? [part.id] : []) : [],
            activeCallIds: [...active], observedCallIds: [...observed],
          };
        },
        confirm: ctx.hasUI ? confirmPersonaSwitch(ctx) : undefined,
      };
      const outcome = await session.larva_persona_switch(input, request);
      return outcome.ok ? outcome : toErrorEnvelope(outcome.error);
    });
  register<SubagentToolInput>("larva_subagent", "Start or resume an isolated Pi subagent. An accepted receipt is not a result.",
    commonToolSchemas.larva_subagent, (input, { supervisor, session, key }, ctx) => supervisor.spawn(input, {
      surface: "pi", cwd: ctx.cwd, sessionKey: key, activePersona: session.activePersona, selfTaskId: ctx.sessionManager.getSessionFile(),
    }), {
      acceptedGuidance: "Accepted, not finished. Continue independent work; Pi will push a larva-subagent-result callback. Do not sleep-poll. Reuse the exact task_id with larva_subagent_wait for bounded readiness checks, larva_subagent_status for state, or larva_subagent_activity for recorded tool activity.",
      renderCall(args, theme) {
        const input = metadataObject(args) ? args : {};
        const persona = typeof input.persona_id === "string" ? `: ${terminalText(input.persona_id)}` : "";
        return new Text(theme.fg("accent", `${input.task_id ? "Resume" : "Start"} Larva subagent${persona}`), 0, 0);
      },
      renderResult({ details }, options, theme) {
        if (metadataObject(details) && details.status === "accepted" && typeof details.task_id === "string") {
          return new Text(theme.fg("accent", `Accepted — result will arrive by callback${options.expanded ? `\n${terminalText(details.task_id)}` : ""}`), 0, 0);
        }
        const error = metadataObject(details) && metadataObject(details.error) ? details.error.message : undefined;
        return new Text(theme.fg("warning", typeof error === "string" ? terminalText(error) : "Subagent did not start."), 0, 0);
      },
    });
  register<SubagentWaitToolInput>("larva_subagent_wait", "Observe readiness of exact task IDs without changing their watchdogs.",
    commonToolSchemas.larva_subagent_wait, (input, { supervisor }) => supervisor.wait(input, "pi"));
  register<SubagentStatusToolInput>("larva_subagent_status", "Inspect local runs or recorded disk sessions by exact task ID or scope.",
    commonToolSchemas.larva_subagent_status, (input, { supervisor }) => supervisor.status(input));
  register<ActivityQuery>("larva_subagent_activity", "Inspect bounded recorded tool activity for an exact child task ID.",
    commonToolSchemas.larva_subagent_activity, (input, { supervisor }) => inspectSubagentActivity(supervisor.home, input));
  register<SubagentCancelToolInput>("larva_subagent_cancel", "Cancel local runs. Supply the observed run epoch to avoid cancelling a replacement.",
    commonToolSchemas.larva_subagent_cancel, (input, { supervisor }) => supervisor.cancel(input));
}
