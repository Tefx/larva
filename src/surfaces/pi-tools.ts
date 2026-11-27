import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { piActivityResult, inspectSubagentActivity } from "../activity/inspector.ts";
import { toErrorEnvelope } from "../core/errors.ts";
import { isRecord } from "../core/predicates.ts";
import type { ActivityQuery, PersonasToolInput, SubagentCancelToolInput, SubagentStatusToolInput, SubagentToolInput, SubagentWaitToolInput } from "../core/types.ts";
import type { PersonaSwitchContext } from "../runtime/persona-lease.ts";
import type { SessionContext } from "../runtime/session-context.ts";
import type { SubagentSupervisor } from "../runtime/supervisor.ts";
import type { PersonaStore } from "../store/persona-store.ts";
import { confirmPersonaSwitch } from "../ui/pi-selector-tui.ts";
import { piToolRenderers } from "../ui/pi-message-views.ts";
import { admitToolInput, commonToolSchemas, personaSwitchSchema, type Schema } from "./tool-schemas.ts";

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
    acceptedGuidance?: string) {
    const admit = (input: unknown) => admitToolInput<Input>(name, schema, input);
    pi.registerTool({ name, label: name, description, parameters: schema as ToolDefinition["parameters"],
      // Pi otherwise coerces wrong-type model inputs before calling execute().
      prepareArguments: admit,
      ...piToolRenderers(name, description),
      async execute(toolCallId, params, signal, _update, ctx) {
        try {
          await bindings.authorize(name);
          const data = await run(admit(params), bindings.current(), ctx, toolCallId, signal);
          if (name === "larva_subagent_activity") return piActivityResult(data as Awaited<ReturnType<typeof inspectSubagentActivity>>);
          const flags = data as { terminate?: boolean; isError?: boolean; ok?: boolean; status?: string };
          const guidance = flags.status === "accepted" ? acceptedGuidance : undefined;
          // Keep the model-facing receipt parseable as one JSON object and
          // leave structured details unchanged for RPC and other consumers.
          const serialized = JSON.stringify(guidance && isRecord(data) ? { ...data, guidance } : data);
          return { content: [{ type: "text", text: serialized }], details: data,
            isError: flags.isError || flags.ok === false || flags.status === "failed", ...(flags.terminate && { terminate: flags.terminate }) };
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
    personaSwitchSchema,
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
        confirm: ctx.mode === "tui" && ctx.hasUI ? confirmPersonaSwitch(ctx, session.activePersona?.id ?? null) : undefined,
      };
      const outcome = await session.larva_persona_switch(input, request);
      if (outcome.ok) return outcome;
      const envelope = toErrorEnvelope(outcome.error);
      const confirmation = /^Persona switch confirmation: (deny|dismissed|timeout)\.$/.exec(envelope.error.message)?.[1];
      if (confirmation && ctx.mode === "tui") {
        const message = confirmation === "deny" ? "Persona switch denied" : confirmation === "timeout" ? "Persona switch timed out" : "Persona switch dismissed";
        ctx.ui.notify(`${message}. The persona is unchanged. Do not retry without a new user request.`, "warning");
        envelope.error.message += " Do not retry without a new user request.";
      }
      return envelope;
    });
  register<SubagentToolInput>("larva_subagent", "Start or resume an isolated Pi subagent. An accepted receipt is not a result.",
    commonToolSchemas.larva_subagent, (input, { supervisor, session, key }, ctx) => supervisor.spawn(input, {
      surface: "pi", cwd: ctx.cwd, sessionKey: key, activePersona: session.activePersona, selfTaskId: ctx.sessionManager.getSessionFile(),
    }), "Accepted, not finished. Continue independent work; Pi will push a larva-subagent-result callback. Do not sleep-poll. Reuse the exact task_id with larva_subagent_wait for bounded readiness checks, larva_subagent_status for state, or larva_subagent_activity for recorded tool activity.");
  register<SubagentWaitToolInput>("larva_subagent_wait", "Observe readiness of exact task IDs without changing their watchdogs.",
    commonToolSchemas.larva_subagent_wait, (input, { supervisor }, _ctx, _id, signal) => supervisor.wait(input, "pi", signal));
  register<SubagentStatusToolInput>("larva_subagent_status", "Inspect local runs or recorded disk sessions by exact task ID or scope.",
    commonToolSchemas.larva_subagent_status, (input, { supervisor }) => supervisor.status(input));
  register<ActivityQuery>("larva_subagent_activity", "Inspect bounded recorded tool activity for an exact child task ID.",
    commonToolSchemas.larva_subagent_activity, (input, { supervisor }) => inspectSubagentActivity(supervisor.home, input));
  register<SubagentCancelToolInput>("larva_subagent_cancel", "Cancel active local runs by exact task_id (omit expected_run_epochs unless guarding against a concurrent resume).",
    commonToolSchemas.larva_subagent_cancel, (input, { supervisor }) => supervisor.cancel(input));
}
