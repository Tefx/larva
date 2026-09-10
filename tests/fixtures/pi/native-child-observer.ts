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
  pi.on("session_start", (_event: any, ctx: any) => observe("start", ctx));
  pi.on("before_agent_start", (_event: any, ctx: any) => {
    observe("before_prompt", ctx);
    // The harness signals only after it observes the real accepted receipt.
    if (process.env.NATIVE_CHILD_FAULT === "malformed") process.once("SIGUSR2", () => writeSync(1, "{native-fixture-malformed\n"));
  });
  pi.on("session_shutdown", (_event: any, ctx: any) => observe("shutdown", ctx));
}
