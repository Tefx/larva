import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { LarvaError, toErrorEnvelope } from "../core/errors.ts";
import { isValidProfileName } from "../core/model-map.ts";
import { modelMapProfilePath } from "../core/paths.ts";
import type { ModelMapOutcome, SessionContext } from "../runtime/session-context.ts";
import type { SubagentSupervisor } from "../runtime/supervisor.ts";
import { loadDiskModelMap } from "../store/model-map.ts";
import type { PersonaStore } from "../store/persona-store.ts";
import { selectPersona, terminalText } from "../ui/pi-selector-tui.ts";
import { openSubagentConsole } from "../ui/pi-subagent-console-tui.ts";

export function reportPiOutcome(ctx: ExtensionContext, action: string, data: unknown): void {
  const outcome = { action, data };
  if (ctx.mode === "rpc") {
    // Pi's native RPC setStatus event carries a string. Encode the entire
    // envelope inside that field; do not inject UI-only data into model context.
    ctx.ui.setStatus("larva-outcome", JSON.stringify(outcome));
    return;
  }
  const info = data as { warning?: { message: string }; error?: { message: string }; isError?: boolean };
  const level = info.error || info.isError || action === "restore_failed" || action === "route_uncertain" ? "error" : info.warning ? "warning" : "info";
  const headline = info.error?.message ?? info.warning?.message ?? JSON.stringify(data);
  if (ctx.mode === "tui") ctx.ui.notify(`${action}: ${terminalText(headline)}`, level);
  else if (level !== "info") process.stderr.write(`${action}: ${terminalText(headline)}\n`);
}

export function registerPiCommands(pi: ExtensionAPI, current: () => {
  session: SessionContext; supervisor: SubagentSupervisor; personas: PersonaStore;
}, modelMap: (profile?: string) => Promise<ModelMapOutcome>) {
  const handle = (action: string, run: (args: string, ctx: ExtensionContext) => Promise<void>) =>
    async (args: string, ctx: ExtensionContext) => {
      try { await run(args.trim(), ctx); }
      catch (error) { reportPiOutcome(ctx, action, toErrorEnvelope(error)); }
    };
  const choosePersona = handle("larva-persona", async (id, ctx) => {
    const { session, personas } = current();
    if (!id && ctx.mode !== "tui") {
      reportPiOutcome(ctx, "larva-persona", { persona_id: session.activePersona?.id ?? null });
      return;
    }
    const selected = id || await selectPersona(ctx, await personas.list());
    if (selected === undefined) reportPiOutcome(ctx, "larva-persona", { status: "dismissed" });
    else await session.selectPersona(selected).catch(() => { /* SessionContext already reported the domain failure. */ });
  });
  pi.registerCommand("larva-persona", {
    description: "Select or inspect the active Larva persona",
    getArgumentCompletions: async query => current().session.personaCandidates(query, "command"),
    handler: choosePersona,
  });
  pi.registerShortcut("ctrl+alt+p", {
    description: "Open the Larva persona selector",
    handler(ctx) {
      if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
        ctx.ui.notify("Wait for the active turn to finish before changing personas.", "warning");
        return;
      }
      return choosePersona("", ctx);
    },
  });
  const completions = (names: string[], query: string) => names.filter(name => name.startsWith(query.trim().toLowerCase()))
    .map(value => ({ value, label: value }));
  pi.registerCommand("larva-mode", {
    description: "Inspect or set the Larva switch mode (manual, confirm, auto, free)",
    getArgumentCompletions: query => completions(["manual", "confirm", "auto", "free"], query),
    handler: handle("larva-mode", async args => {
      await current().session.setMode(args || undefined).catch(() => { /* Already reported. */ });
    }),
  });
  pi.registerCommand("larva-model-map", {
    description: "Inspect or switch the Larva model-map profile",
    async getArgumentCompletions(query) {
      const { home } = current().supervisor;
      const names = (await readdir(home).catch(() => [])).flatMap(file => {
        const name = /^model-map\.(.+)\.json$/.exec(file)?.[1];
        return isValidProfileName(name) ? [name] : [];
      }).sort();
      const matches = [];
      for (const item of completions(["default", ...names], query)) {
        if (item.value === "default" || await loadDiskModelMap(home, modelMapProfilePath(home, item.value)).catch(() => undefined)) {
          matches.push(item);
        }
      }
      return matches;
    },
    handler: handle("larva-model-map", async (profile, ctx) => {
      reportPiOutcome(ctx, "larva-model-map", await modelMap(profile || undefined));
    }),
  });
  pi.registerCommand("larva-subagent", {
    description: "Open the subagent workbench, inspect a task, or cancel a task",
    handler: handle("larva-subagent", async (args, ctx) => {
      const { supervisor } = current();
      const cancel = /^--cancel(?:\s|$)/.test(args);
      const taskId = (cancel ? args.slice("--cancel".length).trimStart() : args) || undefined;
      if ((cancel || taskId !== undefined) && (!taskId || !isAbsolute(taskId) || taskId !== resolve(taskId)
          || !taskId.endsWith(".jsonl") || taskId.includes("\0"))) {
        throw new LarvaError("LARVA_BAD_INPUT", "Expected an exact absolute .jsonl task ID.");
      }
      let data: unknown;
      if (cancel && taskId) {
        // Capture synchronously, before a confirmation or any other awaited work.
        const pinned = supervisor.captureFleet().find(run => run.task_id === taskId);
        if (!pinned) {
          const status = await supervisor.status({ task_id: taskId }).catch(error => {
            if (error instanceof LarvaError && error.code === "LARVA_SESSION_NOT_FOUND") return undefined;
            throw error;
          });
          data = { results: [{ task_id: taskId, outcome: status?.runs.length ? "already_terminal" : "not_found" }], isError: false };
        } else if (ctx.mode !== "tui" || await ctx.ui.confirm("Cancel subagent?", terminalText(taskId))) {
          data = await supervisor.cancel({ task_ids: [taskId], reason: "Cancelled by user command.",
            expected_run_epochs: [{ task_id: taskId, run_epoch: pinned.run_epoch }] });
        } else data = { status: "dismissed", task_id: taskId };
      } else if (ctx.mode === "tui") {
        await openSubagentConsole(ctx, supervisor, taskId);
        data = { status: "closed" };
      } else data = await supervisor.status(taskId ? { task_id: taskId } : {});
      reportPiOutcome(ctx, "larva-subagent", data);
    }),
  });
}
