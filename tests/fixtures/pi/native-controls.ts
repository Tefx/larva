// purpose: public SDK controls and observations in an actual native Pi session
// usage: explicit -e alongside normally discovered Larva, NATIVE_AUDIT_ROOT=scratch
// effects: scratch observations and requested native session/theme operations
// requires: native Pi public SDK; no replacement Larva handlers or tool implementations
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { appendFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
export default async function (pi: ExtensionAPI) {
  const record = (event: string, value: unknown) => appendFileSync(join(process.env.NATIVE_AUDIT_ROOT!, "observations.jsonl"), JSON.stringify({ event, pid: process.pid, value }) + "\n");
  const snapshot = (ctx: ExtensionContext) => ({ mode: ctx.mode, hasUI: ctx.hasUI, model: ctx.model, thinking: pi.getThinkingLevel(), activeTools: pi.getActiveTools(), session: ctx.sessionManager.getSessionFile(), entries: ctx.sessionManager.getEntries(), branch: ctx.sessionManager.getBranch(), allTools: pi.getAllTools(), theme: ctx.ui.theme.name, editor: ctx.ui.getEditorText(), env: { virtualEnv: process.env.VIRTUAL_ENV ?? null, path: process.env.PATH, agent: process.env.PI_CODING_AGENT_DIR, base: process.env.LARVA_PI_BASE_AGENT_DIR ?? null, capsule: process.env.LARVA_PI_CAPSULE_ROOT ?? null } });
  pi.on("session_start", (event, ctx) => record("session_start", { reason: event.reason, ...snapshot(ctx) }));
  pi.on("session_shutdown", (event) => record("session_shutdown", event));
  pi.on("ui_prompt_start", (event) => record("ui_prompt_start", event));
  pi.on("ui_prompt_end", (event) => record("ui_prompt_end", event));
  pi.on("session_compact", (event) => record("session_compact", event));
  pi.on("session_compact_failed", (event) => record("session_compact_failed", event));
  pi.on("agent_settled", (_event, ctx) => record("settled", snapshot(ctx)));
  pi.on("tool_execution_end", (event, ctx) => {
    record("tool_end", event);
    if (event.toolName === "larva_persona_switch" && !event.isError) record("switch_loadout", snapshot(ctx));
  });
  let forceTool: string | null = null;
  pi.on("before_agent_start", (event) => {
    if (forceTool !== null) { pi.setActiveTools([...pi.getActiveTools(), forceTool]); forceTool = null; }
    return { systemPrompt: event.systemPrompt + "\nCOLOADED_NON_LARVA_CONTENT" };
  });
  if (process.env.NATIVE_TEST_TOOLS === "1") {
    for (const name of ["native_allowed", "native_denied"]) pi.registerTool({ name, label: name, description: "Scoped acceptance side effect", parameters: { type: "object", properties: {}, additionalProperties: false }, execute: async () => {
      record("fixture_tool_effect", { name });
      return { content: [{ type: "text", text: "Scoped tool ran." }], details: { name } };
    } });
  }
  if (process.env.NATIVE_PANEL_NAVIGATION === "1") {
    // Reuse the diagnostic's native custom UI observation seam. Synthetic fresh
    // tasks exercise the actual component and Worker; no provider/model is called.
    const mod = await import(pathToFileURL(process.env.NATIVE_PANEL_EXTENSION!).href);
    const root = process.env.NATIVE_AUDIT_ROOT!;
    process.stdin.on("data", chunk => record("panel_raw", { data: chunk.toString() }));
    pi.on("session_shutdown", async () => {
      mod.resetSubagentPresentationStateForTests();
      await mod.awaitSessionTimelineDisposalForTests();
      record("panel_cleanup", mod.sessionTimelineReaderMetricsForTests());
    });
    let interaction = 0;
    pi.registerCommand("audit-panel", { handler: async (args, ctx) => {
      const task = join(root, `panel-${++interaction}.jsonl`);
      await writeFile(task, JSON.stringify({ type: "session", version: 3, id: `fresh-${interaction}` }) + "\n");
      const stream = args === "stream";
      mod.recordSubagentPresentationEntryForTests(task, "synthetic", "running", {
        call_id: `panel-${interaction}`, task_prompt: "synthetic fresh task", result_text: "",
        ...(stream ? {} : {
          presentation_scan_ready: false,
          timeline_events: Array.from({ length: args === "short" ? 18 : 80 }, (_, i) => ({ kind: "assistant", text: `MSG_${String(i).padStart(3, "0")}`, session_id: `m${i}` })),
        }),
      });
      if (args === "output") mod.applySubagentStreamEventForTests(task, { kind: "assistant_delta", text: Array.from({ length: 180 }, (_, i) => `OUTPUT_${String(i).padStart(3, "0")} ${"x".repeat(18)}`).join("\n") });
      const entry = () => mod.subagentPresentationLogForTests().find((e: any) => e.task_id === task);
      await ctx.ui.custom((tui, theme, kb, done) => {
        const component: any = new mod.SubagentPresentationLogOverlay({ entry: entry(), generation: interaction, tui, theme, keybindings: kb, done });
        const state = () => ({ rows: tui.terminal.rows, viewport: component.lastRenderedViewportLines, offsets: { ...component.scrollOffsets }, max: { ...component.lastMaxOffsets }, following: component.timelineFollowing, newActivity: component.timelineNewActivity });
        let batch = 0;
        const advance = async () => {
          const tool = `tool_${batch}`;
          mod.applySubagentStreamEventForTests(task, { kind: "tool", toolCallId: tool, name: tool, status: "running" });
          const messages = Array.from({ length: 20 }, (_, i) => {
            const n = batch * 20 + i;
            return JSON.stringify({ type: "message", id: `m${n}`, message: { role: "assistant", content: [{ type: "text", text: `MSG_${String(n).padStart(3, "0")}` }] } }) + "\n";
          }).join("");
          await appendFile(task, messages);
          mod.applySubagentStreamEventForTests(task, { kind: "message_boundary" });
          const latest = `m${batch * 20 + 19}`;
          const end = Date.now() + 10000;
          while (!entry()?.timeline_events?.some((e: any) => e.session_id === latest) || mod.sessionTimelineReaderMetricsForTests().inFlight !== 0) {
            if (Date.now() > end) throw new Error("Native panel Worker catch-up timeout");
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          batch++;
          component.refreshFromPresentationLog();
          record("panel_batch", { task, batch, latest, tool, retained: entry().timeline_events.length, tools: entry().timeline_events.filter((e: any) => e.kind === "tool").map((e: any) => e.toolCallId), messages: entry().timeline_events.filter((e: any) => e.kind === "assistant").map((e: any) => e.session_id), worker: mod.sessionTimelineReaderMetricsForTests() });
        };
        const input = component.handleInput.bind(component);
        component.handleInput = (data: string) => {
          const before = state();
          if (data === "v" && stream) void advance().catch(error => record("panel_error", { message: String(error) }));
          else if (data === "f" && args === "output") {
            mod.applySubagentStreamEventForTests(task, { kind: "assistant_delta", text: "\nOUTPUT_LATEST" });
            component.refreshFromPresentationLog();
          } else input(data);
          record("panel_input", { task, data, before, after: state() });
        };
        if (typeof component.handleMouse === "function") {
          const mouse = component.handleMouse.bind(component);
          component.handleMouse = (event: any) => {
            const before = state(); const result = mouse(event);
            record("panel_mouse", { task, event, result, before, after: state() });
            return result;
          };
        }
        const render = component.render.bind(component);
        component.render = (width: number) => {
          const lines = render(width);
          record("panel_render", { task, width, ...state(), lineCount: lines.length, markers: lines.flatMap((line: string) => line.match(/MSG_\d+|tool_\d+|OUTPUT_\d+|OUTPUT_LATEST/g) ?? []), outputTailRetained: entry().live_assistant_preview?.endsWith("OUTPUT_LATEST") ?? false });
          return lines;
        };
        record("panel_created", { task, kind: args, ...state() });
        return component;
      }, { overlay: true, overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center", margin: 1 }, onHandle: handle => handle.focus?.() });
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
  pi.registerCommand("audit-tools", { handler: (args, ctx) => { pi.setActiveTools(JSON.parse(args)); record("tools", snapshot(ctx)); } });
  pi.registerCommand("audit-tree", { handler: async (args, ctx) => { await ctx.navigateTree(args, { summarize: false }); } });
  if (process.env.NATIVE_MCP_TEST === "1") {
    for (const exposure of ["codemode", "deferred", "hidden", "model-only"]) {
      const name = `native_${exposure.replace("-", "_")}`;
      pi.registerTool({ name, label: name, description: `Local ${exposure} constraint`, exposure: exposure as any, defaultActive: false,
        parameters: { type: "object", properties: {}, additionalProperties: false }, execute: async () => {
          record("fixture_tool_effect", { name });
          return { content: [{ type: "text", text: name }], details: undefined };
        } });
    }
    pi.registerTool({ name: "native_force_nested", label: "Force nested", description: "Activate a target inside native dispatch to exercise permission gating", defaultActive: false,
      parameters: { type: "object", properties: { target: { type: "string" } }, required: ["target"], additionalProperties: false },
      execute: async (_id, args, _signal, _update, ctx) => {
        pi.setActiveTools([...pi.getActiveTools(), args.target]);
        return await ctx.executeTool(args.target, {});
      } });
    pi.on("tool_call", (event) => record("gate_call", event));
    pi.on("before_provider_request", (_event, ctx) => record("provider_loadout", { active: pi.getActiveTools(), registered: pi.getAllTools().map((tool) => tool.name), session: ctx.sessionManager.getSessionFile() }));
    pi.registerCommand("audit-force-tool", { handler: (args) => { forceTool = args; } });
    pi.registerCommand("audit-wait-tool", { handler: async (args) => {
      const [name, exposure] = args.split(" ");
      const end = Date.now() + 10000;
      while (Date.now() < end) {
        if (pi.getAllTools().some((tool) => tool.name === name && (!exposure || tool.exposure === exposure))) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`Native registry did not reach ${args}`);
    } });
  }
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
