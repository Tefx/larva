// purpose: public SDK controls and observations in an actual native Pi session
// usage: explicit -e alongside normally discovered Larva, NATIVE_AUDIT_ROOT=scratch
// effects: scratch observations and requested native session/theme operations
// requires: Pi 0.85.1; no replacement Larva handlers or tool implementations
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  const record = (event: string, value: unknown) => appendFileSync(join(process.env.NATIVE_AUDIT_ROOT!, "observations.jsonl"), JSON.stringify({ event, pid: process.pid, value }) + "\n");
  const snapshot = (ctx: ExtensionContext) => ({ mode: ctx.mode, hasUI: ctx.hasUI, model: ctx.model, thinking: pi.getThinkingLevel(), activeTools: pi.getActiveTools(), session: ctx.sessionManager.getSessionFile(), entries: ctx.sessionManager.getEntries(), theme: ctx.ui.theme.name, editor: ctx.ui.getEditorText(), env: { virtualEnv: process.env.VIRTUAL_ENV ?? null, path: process.env.PATH, agent: process.env.PI_CODING_AGENT_DIR, base: process.env.LARVA_PI_BASE_AGENT_DIR ?? null, capsule: process.env.LARVA_PI_CAPSULE_ROOT ?? null } });
  pi.on("session_start", (event, ctx) => record("session_start", { reason: event.reason, ...snapshot(ctx) }));
  pi.on("session_shutdown", (event) => record("session_shutdown", event));
  pi.on("ui_prompt_start", (event) => record("ui_prompt_start", event));
  pi.on("ui_prompt_end", (event) => record("ui_prompt_end", event));
  pi.on("session_compact", (event) => record("session_compact", event));
  pi.on("session_compact_failed", (event) => record("session_compact_failed", event));
  pi.on("agent_settled", (_event, ctx) => record("settled", snapshot(ctx)));
  pi.on("tool_execution_end", (event) => record("tool_end", event));
  pi.on("before_agent_start", (event) => ({ systemPrompt: event.systemPrompt + "\nCOLOADED_NON_LARVA_CONTENT" }));
  if (process.env.NATIVE_TEST_TOOLS === "1") {
    for (const name of ["native_allowed", "native_denied"]) pi.registerTool({ name, label: name, description: "Scoped acceptance side effect", parameters: { type: "object", properties: {}, additionalProperties: false }, execute: async () => {
      record("fixture_tool_effect", { name });
      return { content: [{ type: "text", text: "Scoped tool ran." }], details: { name } };
    } });
  }
  pi.registerCommand("audit-snapshot", { handler: (_args, ctx) => record("snapshot", snapshot(ctx)) });
  pi.registerCommand("audit-stop", { handler: (_args, ctx) => ctx.shutdown() });
  pi.registerCommand("audit-theme", { handler: (args, ctx) => record("theme", ctx.ui.setTheme(args)) });
  pi.registerCommand("audit-model", { handler: async (args, ctx) => {
    const [id, thinking] = args.split(" ");
    const model = ctx.modelRegistry.find("native-loopback", id);
    if (!model || !await pi.setModel(model)) throw new Error("Native fixture model unavailable");
    pi.setThinkingLevel(thinking as any);
    record("model", snapshot(ctx));
  } });
  pi.registerCommand("audit-reload", { handler: async (_args, ctx) => { await ctx.reload(); } });
  pi.registerCommand("audit-new", { handler: async (_args, ctx) => { await ctx.newSession(); } });
  pi.registerCommand("audit-fork", { handler: async (_args, ctx) => {
    const leaf = ctx.sessionManager.getLeafId();
    if (!leaf) throw new Error("No native history to fork");
    await ctx.fork(leaf, { position: "at" });
  } });
  pi.events.on("larva:persona-invocation:result", (result) => record("invocation", result));
  pi.registerCommand("audit-invoke", { handler: (args) => pi.events.emit("larva:persona-invocation:request", JSON.parse(args)) });
  pi.registerCommand("audit-invoke-cancel", { handler: (args) => pi.events.emit("larva:persona-invocation:cancel", JSON.parse(args)) });
}
