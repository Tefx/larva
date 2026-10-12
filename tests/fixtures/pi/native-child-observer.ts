// purpose: record actual child admission, preload, route and capsule properties
// usage: allowlist this file in disposable subagent-runtime.json
// effects: append observations only under NATIVE_AUDIT_ROOT
// requires: launched native Pi and Larva, no fake RPC frames
import { appendFileSync, readFileSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
export default function (pi: any) {
  const observe = (event: string, ctx: any) => {
    const agent = process.env.PI_CODING_AGENT_DIR!;
    const bridge = (globalThis as any)[Symbol.for("larva.pi.child-rpc-frame-preload.v1")];
    appendFileSync(join(process.env.NATIVE_AUDIT_ROOT!, "children.jsonl"), JSON.stringify({ event, pid: process.pid, ppid: process.ppid, argv: process.argv, execPath: process.execPath, mode: ctx.mode, model: ctx.model, thinking: pi.getThinkingLevel(), activeTools: pi.getActiveTools(), session: ctx.sessionManager.getSessionFile(), capsule: process.env.LARVA_PI_CAPSULE_ROOT, agent, base: process.env.LARVA_PI_BASE_AGENT_DIR, virtualEnv: process.env.VIRTUAL_ENV ?? null, path: process.env.PATH, frame: bridge ? { capability: bridge.capability, configured: bridge.isConfigured() } : null, modeDirectory: statSync(agent).mode & 0o777, modeSettings: statSync(join(agent, "settings.json")).mode & 0o777, settings: JSON.parse(readFileSync(join(agent, "settings.json"), "utf8")) }) + "\n");
  };
  if (process.env.NATIVE_PANEL_TEST === "1") {
    for (const type of ["tool_execution_start", "tool_execution_update", "tool_execution_end"]) {
      pi.on(type, (event: any, ctx: any) => {
        if (event.toolName === "native_panel") appendFileSync(join(process.env.NATIVE_AUDIT_ROOT!, "panel-events.jsonl"), JSON.stringify({ session: ctx.sessionManager.getSessionFile(), frame: event }) + "\n");
      });
    }
    pi.registerTool({ name: "native_panel", label: "Panel fixture", description: "Local streamed native event fixture",
      parameters: { type: "object", properties: { fail: { type: "boolean" } }, required: ["fail"], additionalProperties: false },
      execute: async (_id: string, args: { fail: boolean }, _signal: unknown, onUpdate: any) => {
        const partial = (text: string) => ({ content: [{ type: "text", text }], details: { secret: "PANEL_DETAILS_PRIVATE" } });
        onUpdate(partial("native partial A"));
        await new Promise(resolve => setTimeout(resolve, 150));
        onUpdate(partial("native partial B"));
        await new Promise(resolve => setTimeout(resolve, 300));
        if (args.fail) throw new Error("native panel tool failed");
        return { content: [{ type: "text", text: "native final text" }, { type: "image", data: "PANEL_BASE64_PRIVATE", mimeType: "image/png" }], details: { secret: "PANEL_DETAILS_PRIVATE" } };
      },
    });
  }
  pi.on("session_start", (_event: any, ctx: any) => observe("start", ctx));
  pi.on("before_agent_start", (_event: any, ctx: any) => {
    observe("before_prompt", ctx);
    // The harness signals only after it observes the real accepted receipt.
    if (process.env.NATIVE_CHILD_FAULT === "malformed") process.once("SIGUSR2", () => writeSync(1, "{native-fixture-malformed\n"));
  });
  pi.on("session_shutdown", (_event: any, ctx: any) => observe("shutdown", ctx));
}
