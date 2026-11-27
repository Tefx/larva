import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { LarvaError, toErrorEnvelope } from "../core/errors.ts";
import { resolveModelRoute, isValidProfileName } from "../core/model-map.ts";
import { modelMapProfilePath } from "../core/paths.ts";
import type { ModelMapOutcome, SessionContext } from "../runtime/session-context.ts";
import type { SubagentSupervisor } from "../runtime/supervisor.ts";
import { loadDiskModelMap } from "../store/model-map.ts";
import type { PersonaStore } from "../store/persona-store.ts";
import { selectOption, selectPersona } from "../ui/pi-selector-tui.ts";
import { terminalText } from "../ui/pi-tui-chrome.ts";
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
  const d = data as { persona_id?: string | null; mode?: string; profile?: string; generation?: number; status?: string;
    children?: Record<string, number>; child_notification_error?: { message: string };
    results?: { outcome: string }[]; runs?: unknown[]; disk_sessions?: unknown[] };
  const status = d.status?.replaceAll("_", " ");
  const headline = info.error?.message ?? info.warning?.message ?? (d.profile !== undefined
    ? `Profile ${d.profile} (generation ${d.generation})${status === "inspect" ? "" : ` — ${status}`}${d.children ? `; ${Object.entries(d.children).map(([name, count]) => `${count} ${name.replaceAll("_", " ")}`).join(", ")}` : ""}${d.child_notification_error ? `; ${d.child_notification_error.message}` : ""}`
    : d.persona_id !== undefined ? `Active persona: ${d.persona_id ?? "None"}`
    : d.mode ? `Switch mode: ${d.mode}` : d.results ? d.results.map(row => row.outcome.replaceAll("_", " ")).join(", ")
    : d.runs ? `${d.disk_sessions?.length ?? d.runs.length} sessions` : status ?? "Updated");
  if (ctx.mode === "tui") ctx.ui.notify(`${action}: ${terminalText(headline)}`, level);
  else if (level !== "info") process.stderr.write(`${action}: ${terminalText(headline)}\n`);
}

export function registerPiCommands(pi: ExtensionAPI, current: () => {
  session: SessionContext; supervisor: SubagentSupervisor; personas: PersonaStore; treeRevision: number;
}, modelMap: (profile?: string) => Promise<ModelMapOutcome>) {
  const handle = (action: string, run: (args: string, ctx: ExtensionContext) => Promise<void>) =>
    async (args: string, ctx: ExtensionContext) => {
      try { await run(args.trim(), ctx); }
      catch (error) { reportPiOutcome(ctx, action, toErrorEnvelope(error)); }
    };
  const completions = (names: readonly string[], query: string) => names.filter(name => name.startsWith(query.trim().toLowerCase()))
    .map(value => ({ value, label: value }));
  const inspect = (args: string, ctx: ExtensionContext) => args === "--status" || (!args && ctx.mode !== "tui");
  const guard = (state: ReturnType<typeof current>, ctx: ExtensionContext) => {
    const revision = state.treeRevision;
    return () => {
      if (state !== current() || state.treeRevision !== revision || !ctx.isIdle()) {
        throw new LarvaError("LARVA_SESSION_BUSY", "Wait for the active turn to finish before changing this session.");
      }
      return true;
    };
  };
  const choosePersona = handle("larva-persona", async (id, ctx) => {
    const state = current(), { session, personas } = state;
    const active = session.activePersona?.id ?? null;
    if (inspect(id, ctx)) return reportPiOutcome(ctx, "larva-persona", { persona_id: active });
    const check = guard(state, ctx);
    check();
    const selected = id || await selectPersona(ctx, await personas.list(), active);
    if (selected === undefined) reportPiOutcome(ctx, "larva-persona", { status: "dismissed" });
    else await session.selectPersona(selected, check).catch(() => { /* SessionContext already reported the failure. */ });
  });
  pi.registerCommand("larva-persona", {
    description: "Select or inspect the active Larva persona",
    getArgumentCompletions: query => query.startsWith("-") ? completions(["--status"], query) : current().session.personaCandidates(query, "command"),
    handler: choosePersona,
  });
  pi.registerShortcut("ctrl+alt+p", { description: "Open the Larva persona selector", handler: ctx => choosePersona("", ctx) });
  const modeDescriptions = {
    manual: "Only you can switch personas.",
    confirm: "Ask before a persona switch.",
    auto: "Allow a temporary borrow for the current turn.",
    free: "Allow persistent persona switches.",
  };
  const modes = Object.keys(modeDescriptions) as (keyof typeof modeDescriptions)[];
  pi.registerCommand("larva-mode", {
    description: "Inspect or set the Larva switch mode (manual, confirm, auto, free)",
    getArgumentCompletions: query => completions(query.startsWith("-") ? ["--status"] : modes, query),
    handler: handle("larva-mode", async (args, ctx) => {
      const state = current(), { session } = state;
      if (inspect(args, ctx)) { await session.setMode(); return; }
      if (!args) {
        const check = guard(state, ctx);
        check();
        const choice = await selectOption(ctx, "Larva switch mode", modes.map(value => ({ value, label: value,
          current: value === session.switchMode, preview: modeDescriptions[value],
          details: [["Mode", value], ["Status", value === session.switchMode ? "Current" : "Available"], ["Description", modeDescriptions[value]]],
        })));
        if (choice === undefined) return reportPiOutcome(ctx, "larva-mode", { status: "dismissed" });
        check();
        args = choice;
      }
      await session.setMode(args).catch(() => { /* Already reported. */ });
    }),
  });
  const profiles = async (home: string) => {
    const names = (await readdir(home).catch(() => [])).flatMap(file => {
      const name = /^model-map\.(.+)\.json$/.exec(file)?.[1];
      return isValidProfileName(name) ? [name] : [];
    }).sort();
    const load = (name: string) => loadDiskModelMap(home, modelMapProfilePath(home, name)).catch(() => undefined);
    return [{ name: "default", map: await load("default") }, ...(await Promise.all(names.map(async name => ({ name, map: await load(name) })))).filter(item => item.map)];
  };
  pi.registerCommand("larva-model-map", {
    description: "Inspect or switch the Larva model-map profile",
    async getArgumentCompletions(query) {
      if (query.startsWith("-")) return completions(["--status"], query);
      return completions((await profiles(current().supervisor.home)).map(row => row.name), query);
    },
    handler: handle("larva-model-map", async (profile, ctx) => {
      const report = (data: ModelMapOutcome) => reportPiOutcome(ctx, "larva-model-map", data);
      if (inspect(profile, ctx)) return report(await modelMap());
      if (!profile) {
        const state = current(), check = guard(state, ctx);
        check();
        const active = (await modelMap()).profile;
        const persona = state.session.activePersona;
        const rows = (await profiles(state.supervisor.home)).map(({ name, map }) => {
          const row = { label: name, current: active === name };
          try {
            const route = persona && resolveModelRoute(persona.model, map);
            const preview = route ? `${route.provider}/${route.model_id}` : ctx.model ? `${ctx.model.provider}/${ctx.model.id} (unchanged)` : "None";
            return { ...row, value: { name }, preview, details: [["Profile", name], ["Parent route", preview],
              ["Status", row.current ? "Current" : "Available"], ["Thinking", persona?.thinking ?? "Unchanged"]] as const };
          } catch (error) {
            const failure = toErrorEnvelope(error);
            return { ...row, label: `${name} (invalid route)`, value: { name, failure }, preview: failure.error.message,
              details: [["Profile", name], ["Error", failure.error.message]] as const };
          }
        });
        check();
        const choice = await selectOption<(typeof rows)[number]["value"]>(ctx, "Larva model-map profile", rows);
        if (choice === undefined) return reportPiOutcome(ctx, "larva-model-map", { status: "dismissed" });
        check();
        if (choice.failure) return reportPiOutcome(ctx, "larva-model-map", choice.failure);
        profile = choice.name;
      }
      report(await modelMap(profile));
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
