// purpose: launched native Pi driver for child hold + parent shutdown observations
// usage: pi --no-extensions -e <loopback> -e this-file with AUDIT_ROOT set
// effects: writes AUDIT_ROOT observations; starts one child; ctx.shutdown on /audit-stop
// requires: isolated agent dir, loopback provider, fake Larva CLI binding
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import initializeLarva from "../../../contrib/pi-extension/larva.ts";

function record(data: Record<string, unknown>): void {
  const root = process.env.AUDIT_ROOT;
  if (!root) return;
  appendFileSync(join(root, "main-observations.jsonl"), `${JSON.stringify({ ts: Date.now(), pid: process.pid, ppid: process.ppid, ...data })}\n`, { mode: 0o600 });
}

export default async function (pi: any) {
  const tools = new Map<string, any>();
  const proxy = new Proxy(pi, {
    get(target, key) {
      if (key === "registerTool") {
        return (tool: { name: string }) => {
          tools.set(tool.name, tool);
          return target.registerTool(tool);
        };
      }
      if (key === "sendMessage") {
        return (message: unknown, options: unknown) => {
          record({ event: "sendMessage", message, options });
          return target.sendMessage(message, options);
        };
      }
      return Reflect.get(target, key);
    },
  });
  await initializeLarva(proxy);
  pi.on("session_start", (_event: unknown, ctx: { mode?: string; hasUI?: boolean }) => {
    record({ event: "ready", mode: ctx.mode, hasUI: ctx.hasUI, execPath: process.execPath, argv: process.argv, extension: fileURLToPath(import.meta.url), larva: join(dirname(fileURLToPath(import.meta.url)), "../../../contrib/pi-extension/larva.ts") });
  });
  pi.on("session_shutdown", () => record({ event: "session_shutdown" }));
  pi.registerCommand("audit-child-hold", {
    handler: async (_args: string | undefined, ctx: unknown) => {
      const tool = tools.get("larva_subagent");
      if (typeof tool?.execute !== "function") {
        record({ event: "missing_tool" });
        return;
      }
      const value = await tool.execute("audit-hold", { persona_id: "child", task: "HOLD_CHILD stay running until parent shutdown" }, undefined, undefined, ctx);
      record({ event: "accepted", value });
    },
  });
  pi.registerCommand("audit-stop", {
    handler: async (_args: string | undefined, ctx: { shutdown?: () => void }) => {
      record({ event: "stop" });
      ctx.shutdown?.();
    },
  });
}
