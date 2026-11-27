import { basename } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { inspectSubagentActivity } from "../activity/inspector.ts";
import { toErrorEnvelope } from "../core/errors.ts";
import type { ActivityCallItem, ActivityQuery, ActivitySegment, DiskSessionSummary, RunSnapshot, RunTextSliceResult, SubagentStatusOutput } from "../core/types.ts";
import { isTerminal } from "../runtime/outbox.ts";
import type { SubagentSupervisor } from "../runtime/supervisor.ts";
import * as capsule from "../store/capsule.ts";
import { scanDiskSessions } from "../store/session-index.ts";
import { createSessionLeaseStore } from "../store/session-lease.ts";
import { centeredOverlay, fieldLines, modalFrame, presentSubagentResult, terminalLines, terminalText } from "./pi-tui-chrome.ts";

type Row = RunSnapshot | DiskSessionSummary;
const scopes = ["Active", "Recent", "Disk"] as const;
const tabs = ["Summary", "Prompt", "Output", "Timeline", "Metadata"] as const;
const terminalMarker = { success: "✓", failed: "✗", cancelled: "⚠" } as const;
const key = (row: Row) => JSON.stringify([row.task_id, "run_epoch" in row ? row.run_epoch : null]);
const actionFor = (row: Row | undefined) => row && "run_epoch" in row
  ? row.cleanup_unconfirmed ? "Retry cleanup" : !isTerminal(row.status) && row.status !== "cancelling" ? "Cancel" : undefined : undefined;
const short = (row: Row) => {
  const name = basename(row.task_id, ".jsonl");
  return name.length <= 14 ? name : `${name.slice(0, 5)}…${name.slice(-8)}`;
};
const time = (value: string) => /^\d{4}-\d\d-\d\dT/.test(value) ? `${value.slice(5, 10)} ${value.slice(11, 19)}` : value;
const diskStatus = (row: DiskSessionSummary) => row.lock_state === "unlocked" ? "Recorded session" : `Busy (${row.lock_state})`;

async function listScope(supervisor: SubagentSupervisor, scope: typeof scopes[number]): Promise<SubagentStatusOutput> {
  if (scope === "Disk") return { runs: [], startup_failures: [], disk_sessions: await scanDiskSessions(supervisor.home, createSessionLeaseStore(supervisor.home, capsule)) };
  const fleet = supervisor.captureFleet();
  const snapshot = await supervisor.status({ scope: scope === "Active" ? "active" : "recent", limit: 25 });
  const seen = new Set(snapshot.runs.map(key));
  const extra = fleet.filter(row => !seen.has(JSON.stringify([row.task_id, row.run_epoch])));
  // Keep the public tool's page limit; fill the workbench with exact live epochs.
  for (let i = 0; i < extra.length; i += 25) {
    const page = await Promise.allSettled(extra.slice(i, i + 25).map(row => supervisor.pinned(row.task_id, row.run_epoch)));
    for (const result of page) if (result.status === "fulfilled" && "status" in result.value) snapshot.runs.push(result.value);
  }
  return snapshot;
}

export async function openSubagentConsole(ctx: ExtensionContext, supervisor: SubagentSupervisor, taskId?: string): Promise<void> {
  let cleanup: (() => void) | undefined;
  try {
    await ctx.ui.custom<void>((tui, theme, _keys, done) => {
      let scope = 1, tab = 0, exact = taskId;
      let mode: "selector" | "detail" = taskId ? "detail" : "selector";
      const activeTab = () => tabs[tab];
      const textSource = () => activeTab() === "Prompt" ? "prompt" : activeTab() === "Output" ? "output" : undefined;
      const dim = (text: string) => theme.fg("dim", text);
      const accent = (text: string) => theme.fg("accent", theme.bold(text));
      let snapshot: SubagentStatusOutput | undefined, loadError: string | undefined;
      let closed = false, generation = 0;
      let refresh: () => Promise<void>;
      let selected: string | undefined, scroll = 0, viewport = 1;
      let action: { kind: "confirm" | "pending"; row: RunSnapshot; label: string } | undefined;
      let actionStatus: string | undefined;
      type Hit = { row: Row; start: number; end: number; actionEnd: number };
      let pressed: { row: Row; button: boolean; x: number; y: number } | undefined;
      const hitRows = new Map<number, Hit>();
      let following = true;
      let textPage: { result?: RunTextSliceResult; view?: ReturnType<typeof presentSubagentResult> } | undefined;
      let recorded: { items: ActivityCallItem[]; index: number; cursor: string; more: boolean } | undefined;
      let segment: { part: "args" | "result"; page?: ActivitySegment; message?: string } | undefined;
      let detailRequest = 0, detailLoading = false;
      const repaint = () => { if (!closed) tui.requestRender(); };
      const rows = (): Row[] => snapshot?.disk_sessions ?? snapshot?.runs ?? [];
      const row = () => rows().find(item => key(item) === selected);
      const resetDetail = () => { scroll = 0; textPage = recorded = segment = undefined; detailRequest++; detailLoading = false; };
      const select = (next: Row | undefined) => {
        const id = next && key(next);
        if (selected !== id) { selected = id; following = true; resetDetail(); }
      };
      const readPage = async (offset = 0) => {
        const current = row(), source = textSource();
        if (mode !== "detail" || !current || !source) return;
        const id = ++detailRequest;
        textPage = {}; repaint();
        const result = await supervisor.readRunTextSlice({ task_id: current.task_id,
          run_epoch: "run_epoch" in current ? current.run_epoch : undefined, source, offset }).catch(() => ({ state: "unavailable" as const }));
        if (closed || detailRequest !== id) return;
        textPage = { result, view: result.state === "ok" ? presentSubagentResult(result.text) : undefined };
        scroll = 0; repaint();
      };
      // Coalesce notifications even during the initial load, independently for each scope.
      const loadScope = () => {
        const epoch = ++generation, task = exact, view = scopes[scope];
        snapshot = undefined; loadError = undefined; pressed = undefined;
        select(undefined); resetDetail();
        let refreshing = false, queued = false;
        const current = () => !closed && epoch === generation;
        refresh = async () => {
          queued = true;
          if (refreshing || !current()) return;
          refreshing = true;
          try {
            while (queued && current()) {
              queued = false;
              try {
                const next = await (task ? supervisor.status({ task_id: task }) : listScope(supervisor, view));
                if (!current()) return;
                const before = row();
                snapshot = next; loadError = undefined;
                // A user's selection is a run instance, not whichever run takes its list position.
                if (!selected) select(rows()[0]);
                const after = row();
                if (after && (!textPage || (activeTab() === "Output" && "run_epoch" in after && before && "run_epoch" in before && before.output_state !== after.output_state))) void readPage();
              } catch (error) {
                if (!current()) return;
                loadError = toErrorEnvelope(error).error.message;
              }
              repaint();
            }
          } finally { refreshing = false; }
        };
        void refresh();
        repaint();
      };
      const unsubscribe = supervisor.subscribe(() => { if (exact || scopes[scope] !== "Disk") void refresh(); });
      cleanup = () => {
        if (closed) return;
        closed = true; unsubscribe(); done();
      };
      loadScope();
      const move = (delta: number) => {
        const list = rows(), index = list.findIndex(item => key(item) === selected);
        select(list[Math.max(0, Math.min(list.length - 1, index + delta))]);
        void readPage(); repaint();
      };
      const changeTab = (next: number) => {
        if (mode === "detail" && tab === next) return;
        mode = "detail"; tab = next; pressed = undefined;
        resetDetail(); void readPage(); repaint();
      };
      const setMode = (next: typeof mode) => {
        mode = next; pressed = undefined;
        resetDetail(); void readPage(); repaint();
      };
      const scrollBy = (delta: number) => {
        if (mode === "selector" && rows().length && !loadError) { move(delta); return; }
        if (mode === "detail" && activeTab() === "Timeline" && !recorded) following = false;
        scroll = Math.max(0, scroll + delta); repaint();
      };
      const ask = (target: Row | undefined) => {
        const label = actionFor(target);
        if (!label || !target || !("run_epoch" in target)) return;
        action = { kind: "confirm", row: target, label }; actionStatus = undefined; repaint();
      };
      const cancel = async (target: RunSnapshot, label: string) => {
        action = { kind: "pending", row: target, label }; repaint();
        try {
          const { task_id, run_epoch } = target;
          const { results } = await supervisor.cancel({ task_ids: [task_id], expected_run_epochs: [{ task_id, run_epoch }],
            reason: label === "Cancel" ? "Cancelled from the Subagent Console." : "Retry cleanup from the Subagent Console." });
          actionStatus = `${label}: ${results[0].outcome.replaceAll("_", " ")}`;
        } catch (error) { actionStatus = toErrorEnvelope(error).error.message; }
        finally { action = undefined; if (!closed) { void refresh(); repaint(); } }
      };
      const inspectRecorded = async (part?: "args" | "result", page?: ActivitySegment) => {
        const current = row();
        if (!current || detailLoading) return;
        const id = ++detailRequest;
        detailLoading = true; repaint();
        const item = recorded?.items[recorded.index];
        const args: ActivityQuery = { task_id: current.task_id, ...(part && item ? {
          tool_call_id: item.call_id, disambiguation_index: item.disambiguation_index, segment_part: part,
          ...(page?.continuation_offset !== undefined && { offset: page.continuation_offset, source_version: page.source_version }),
        } : { limit: 20, cursor: recorded?.cursor }) };
        try {
          const result = await inspectSubagentActivity(supervisor.home, args);
          if (closed || detailRequest !== id) return;
          if (result.status === "success" && "items" in result) {
            recorded = { items: result.items, index: 0, cursor: result.cursor, more: result.has_more }; segment = undefined;
          } else if (part) {
            segment = result.status === "success" && "call" in result && result.call.segment
              ? { part, page: result.call.segment }
              : { part, message: "error" in result ? result.error.message : "No unambiguous saved segment." };
          } else actionStatus = "error" in result ? result.error.message : "No recorded activity.";
          scroll = 0;
        } catch (error) {
          if (!closed && detailRequest === id) actionStatus = toErrorEnvelope(error).error.message;
        } finally { if (detailRequest === id) { detailLoading = false; repaint(); } }
      };
      const unavailable = () => loadError ?? (!snapshot ? "Loading…" : selected
        ? "Selected run no longer in this scope. Press s to select another." : "No subagent sessions in this scope.");
      const detailLines = (current: Row, inner: number, compact: boolean) => {
        const rule = (title: string) => compact ? [] : [accent(`─ ${title} ${"─".repeat(Math.max(0, inner - visibleWidth(title) - 3))}`)];
        const fields = (...pairs: [string, string | undefined][]) => pairs.flatMap(([label, value]) => fieldLines(label, value ?? "—", inner, accent, 16));
        const run = "run_epoch" in current ? current : undefined;
        const location = () => fields(["Task ID", current.task_id], ["Workspace", current.cwd]);
        switch (activeTab()) {
          case "Summary": return [
            ...rule("Run"), ...("run_epoch" in current ? fields(["Status", `${current.status} · ${current.phase}`], ["Persona", current.persona_id],
              ["Route", `${current.model ?? "unknown"} · thinking: ${current.thinking ?? "unknown"}`]) : fields(["Status", diskStatus(current)])),
            ...rule("Prompt"), ...fields(["Task", run?.task_preview ?? "Open the Prompt tab"]),
            ...rule("Result"), ...fields(["Output", run?.output_state.replaceAll("_", " ")], ["Tool calls", run && String(run.tool_call_count)]),
            ...(run?.active_tool ? fields(["Live tool", `${run.active_tool.name} (${run.active_tool.status})`]) : []),
            ...(run?.error ? fields(["Error", run.error.message]) : []),
            ...rule("Metadata"), ...location(),
          ];
          case "Metadata": return [...rule("Metadata"), ...location(), ...("run_epoch" in current
            ? fields(["Epoch", current.run_epoch], ["Started", current.started_at], ["Updated", current.updated_at])
            : fields(["Session", diskStatus(current)], ["Path status", current.cwd_exists ? "Present" : "Missing workspace"]))];
          case "Timeline": {
            if (segment) return [accent(`Recorded ${segment.part} · Esc back${segment.page?.has_more ? " · N next page" : ""}`),
              ...terminalLines(segment.page?.text ?? segment.message ?? "", inner)];
            if (recorded) return [accent("Recorded tools · J/K select · Enter args · V result · Esc live"), ...recorded.items.map((item, i) => {
              const text = terminalText(`${i === recorded?.index ? "›" : " "} ↳ ${item.action} · ${item.is_error ? "error" : item.result_state ?? "recorded"}`);
              return theme.fg(i === recorded?.index ? "accent" : item.is_error ? "error" : "muted", text);
            }), ...(recorded.items.length ? [] : ["No recorded tool calls."])];
            const terminal = run && isTerminal(run.status) ? run.status : undefined;
            const items = [
              ...(run?.live_assistant_preview ? wrapTextWithAnsi(`${accent("• assistant")} ${terminalText(run.live_assistant_preview)}`, inner) : []),
              ...(run?.live_thinking ? [dim("~ thinking hidden")] : []),
              ...(run?.tool_snapshots ?? []).flatMap(item => [
                theme.fg(item.status === "error" ? "error" : "muted", terminalText(`  ↳ ${item.name} (${item.status})${item.args_preview ? ` · ${item.args_preview}` : ""}`)),
                ...[item.output_preview, item.error_preview].filter((preview): preview is string => !!preview)
                  .map(preview => dim(`    ${terminalText(preview)}`)),
              ]),
              ...(terminal ? [theme.fg(terminal === "failed" ? "error" : terminal === "success" ? "success" : "warning",
                theme.bold(`${terminalMarker[terminal]} ${terminal}`))] : []),
            ];
            return [...rule("Timeline"), ...(items.length ? items : [dim("No live timeline observed. Enter opens recorded tools.")])];
          }
          case "Prompt":
          case "Output": {
            const page = textPage?.result;
            const content = page?.state === "ok" ? textPage?.view?.render(inner) ?? []
              : terminalLines(!page ? "Loading text…" : run && activeTab() === "Output" ? run.output_diagnostic?.message
                ?? (run.output_state === "pending" ? "Output pending" : `Output ${run.output_state.replaceAll("_", " ")} (text unavailable)`)
                : "Text unavailable for this run.", inner);
            return [...rule(activeTab() === "Output" ? "Result" : "Prompt"), ...content];
          }
        }
      };
      const confirmation = (inner: number, target: NonNullable<typeof action>) => {
        const title = target.label === "Cancel" ? "⚠ CANCEL SUBAGENT?" : "⚠ RETRY CLEANUP?";
        const decision = `${theme.fg("error", "[ Enter / y ]")}     ${theme.fg("success", "[ Esc / n ]")}`;
        return [theme.fg("warning", theme.bold(title)), decision,
          ...terminalLines(`${target.row.persona_id} · ${target.row.task_id}`, inner), theme.fg("warning", "━".repeat(inner))];
      };
      const changeScope = (delta: number) => {
        if (!exact) scope = (scope + delta + scopes.length) % scopes.length;
        exact = undefined; mode = "selector"; actionStatus = undefined; loadScope();
      };
      return {
        invalidate() { textPage?.view?.invalidate(); }, dispose: cleanup,
        render(width) {
          const frame = modalFrame(width, tui.terminal.rows, 90);
          const { inner, room } = frame;
          const active = row(), list = rows(), index = list.findIndex(item => key(item) === selected);
          const tail = mode === "detail" && activeTab() === "Timeline" && !recorded ? following ? "Following tail" : "Tail paused" : "";
          const scopeName = exact ? "Task" : scopes[scope];
          const title = `Larva subagent log · ${scopeName}${room < 4 && mode === "detail" ? ` · ${tail || activeTab()}` : ""}`;
          const lines: string[] = [];
          hitRows.clear();
          if (action?.kind === "confirm") {
            lines.push(...confirmation(inner, action));
            return frame.render(title, lines);
          }
          if (room >= 3) {
            if (mode === "selector") lines.push(accent(`Select subagent · [ / ] scope · ${scopes.map(name => name === scopeName ? `● ${name}` : `○ ${name}`).join("   ")}${exact ? "   ● Task" : ""}`));
            else {
              const labels = tabs.map((label, i) => i === tab ? accent(`● ${i + 1} ${label}`) : dim(`○ ${i + 1} ${label}`));
              const bar = wrapTextWithAnsi(labels.join(inner >= 64 ? "   " : " "), inner);
              lines.push(...(bar.length <= (room >= 7 ? 2 : 1) ? bar : [labels[tab] + dim(" · 1–5/←→")]));
              if (room >= 5 && tail) lines.push(dim(`${tail} · F toggle · Enter recorded tools`));
            }
          }
          const divider = room >= 7 ? lines.length : -1;
          if (divider >= 0) lines.push("");
          const failures = (snapshot?.startup_failures ?? []).map(f => theme.fg("warning",
            terminalText(`Startup failed · ${f.persona_id} · ${time(f.updated_at)} · ${f.error.message}`)));
          const status = action ? `${action.label} in progress…` : actionStatus ?? (detailLoading ? "Loading recorded activity…" : undefined);
          if (status && room > lines.length) lines.push(accent(terminalText(status)));
          const footer = room >= 5;
          viewport = Math.max(0, room - lines.length - Number(footer));
          if (viewport > 1 && failures.length && (active || list.length)) {
            const budget = Math.min(2, viewport - 1);
            lines.push(...failures.slice(0, budget));
            viewport -= Math.min(budget, failures.length);
          }
          let range = "";
          if (mode === "selector" && list.length && !loadError) {
            const first = Math.max(0, Math.min(index - Math.floor(viewport / 2), list.length - viewport));
            for (const item of list.slice(first, first + viewport)) {
              const button = actionFor(item);
              const text = "run_epoch" in item ? `${time(item.started_at)} ${short(item)} ${item.persona_id} · ${item.task_preview || item.phase}`
                : `${short(item)} ${item.lock_state} · ${item.cwd}`;
              const prefix = item === active ? "› " : "  ";
              const actionText = button ? `[${button}] ` : "";
              const label = terminalText(prefix + actionText + text);
              hitRows.set(frame.top + lines.length, { row: item, start: frame.inset,
                end: frame.inset + Math.min(visibleWidth(label), inner),
                actionEnd: button && visibleWidth(prefix + actionText) <= inner ? frame.inset + 2 + actionText.length - 1 : 0 });
              lines.push(item === active ? accent(label) : label);
            }
            if (list.length > viewport) range = ` · ${Math.max(0, index + 1)}/${list.length}`;
          } else {
            const content = mode === "detail" && active && !loadError ? detailLines(active, inner, room < 3)
              : [...terminalLines(unavailable(), inner), ...failures];
            const max = Math.max(0, content.length - viewport);
            const follow = mode === "detail" && active && activeTab() === "Timeline" && following && !recorded && !loadError;
            scroll = follow ? max : Math.min(scroll, max);
            lines.push(...content.slice(scroll, scroll + viewport));
            if (max > 0 && viewport > 0) range = ` · ${scroll + 1}–${Math.min(content.length, scroll + viewport)}/${content.length}`;
          }
          const more = segment?.page?.has_more || (!segment && recorded?.more) || (textPage?.result?.state === "ok" && textPage.result.continuation_offset !== undefined);
          if (footer) {
            while (lines.length < room - 1) lines.push("");
            lines.push(dim((more ? "N next · " : "") + (mode === "selector" ? "Enter detail · S toggle · [/] scope · C action · Esc close"
              : "1–5/←→/Tab tabs · S selector · [/] scope · C action · Esc") + range));
          }
          return frame.render(title, lines, divider);
        },
        handleInput(data) {
          if (closed) return;
          pressed = undefined;
          if (action) {
            if (action.kind === "confirm") {
              if (matchesKey(data, "y") || matchesKey(data, "enter")) void cancel(action.row, action.label);
              else if ((["n", "escape", "ctrl+c"] as const).some(k => matchesKey(data, k))) { action = undefined; repaint(); }
            }
            return;
          }
          if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
            if (segment) { segment = undefined; detailRequest++; detailLoading = false; scroll = 0; repaint(); }
            else if (recorded) { resetDetail(); repaint(); }
            else cleanup?.();
          } else if (matchesKey(data, "s")) setMode(mode === "selector" ? "detail" : "selector");
          else if (data === "[" || data === "]") changeScope(data === "[" ? -1 : 1);
          else if (/^[1-5]$/.test(data)) changeTab(Number(data) - 1);
          else if (matchesKey(data, "tab") || matchesKey(data, "right")) changeTab((tab + 1) % tabs.length);
          else if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) changeTab((tab + tabs.length - 1) % tabs.length);
          else if (matchesKey(data, "r")) { actionStatus = undefined; resetDetail(); void refresh(); }
          else if (matchesKey(data, "c")) ask(row());
          else if (matchesKey(data, "up")) scrollBy(-1);
          else if (matchesKey(data, "down")) scrollBy(1);
          else if (matchesKey(data, "pageUp")) scrollBy(-Math.max(1, viewport));
          else if (matchesKey(data, "pageDown")) scrollBy(Math.max(1, viewport));
          else if (matchesKey(data, "enter") && mode === "selector") { if (row()) setMode("detail"); }
          else if (matchesKey(data, "n")) {
            if (segment?.page?.has_more) void inspectRecorded(segment.part, segment.page);
            else if (!segment && recorded?.more) void inspectRecorded();
            else if (textPage?.result?.state === "ok" && textPage.result.continuation_offset !== undefined) void readPage(textPage.result.continuation_offset);
          } else if (mode === "detail" && activeTab() === "Timeline") {
            if (matchesKey(data, "f")) { following = !following; repaint(); }
            else if (matchesKey(data, "enter")) void inspectRecorded(recorded?.items.length ? "args" : undefined);
            else if (recorded?.items.length && matchesKey(data, "v")) void inspectRecorded("result");
            else if (recorded && !segment && !detailLoading && (matchesKey(data, "j") || matchesKey(data, "k"))) {
              recorded.index = Math.max(0, Math.min(recorded.items.length - 1, recorded.index + (matchesKey(data, "j") ? 1 : -1)));
              scroll = Math.max(0, recorded.index - viewport + 2); repaint();
            }
          }
        },
        handleMouse(event) {
          if (action || closed) { pressed = undefined; return { handled: true }; }
          if (event.type === "wheel" && event.wheelDelta && Number.isFinite(event.wheelDelta)) {
            pressed = undefined; scrollBy(Math.trunc(event.wheelDelta));
          }
          if (event.type === "press" && event.button === "left") {
            const hit = hitRows.get(event.y);
            pressed = hit && event.x >= hit.start && event.x < hit.end ? { row: hit.row,
              button: event.x >= hit.start + 2 && event.x < hit.actionEnd, x: event.x, y: event.y } : undefined;
          }
          if (event.type === "click" && event.button === "left") {
            const hit = pressed; pressed = undefined;
            if (hit && event.x === hit.x && event.y === hit.y) {
              if (hit.button) ask(hit.row);
              else if (rows().some(item => key(item) === key(hit.row))) { select(hit.row); repaint(); }
            }
          }
          return { handled: true };
        },
      };
    }, centeredOverlay);
  } finally { cleanup?.(); }
}
