import { basename } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { inspectSubagentActivity } from "../activity/inspector.ts";
import { toErrorEnvelope } from "../core/errors.ts";
import type { ActivityCallItem, ActivityQuery, ActivitySegment, DiskSessionSummary, RunSnapshot, RunTextSliceResult, SubagentStatusOutput } from "../core/types.ts";
import { isTerminal } from "../runtime/outbox.ts";
import type { SubagentSupervisor } from "../runtime/supervisor.ts";
import * as capsule from "../store/capsule.ts";
import { scanDiskSessions } from "../store/session-index.ts";
import { createSessionLeaseStore } from "../store/session-lease.ts";
import { terminalLines, terminalText } from "./pi-selector-tui.ts";

type Row = RunSnapshot | DiskSessionSummary;
const scopes = ["Active", "Recent", "Disk"] as const;
const tabs = ["Summary", "Output", "Prompt", "Timeline", "Metadata"] as const;
const key = (row: Row) => JSON.stringify([row.task_id, "run_epoch" in row ? row.run_epoch : null]);
const actionFor = (row: Row | undefined) => row && "run_epoch" in row
  ? row.cleanup_unconfirmed ? "Retry cleanup" : !isTerminal(row.status) && row.status !== "cancelling" ? "Cancel" : undefined : undefined;
const short = (row: Row) => {
  const name = basename(row.task_id, ".jsonl");
  return name.length <= 14 ? name : `${name.slice(0, 5)}…${name.slice(-8)}`;
};
const time = (value: string) => /^\d{4}-\d\d-\d\dT/.test(value) ? `${value.slice(5, 10)} ${value.slice(11, 19)}` : value;
const summary = (row: Row) => "run_epoch" in row ? [
  `${row.persona_id} · ${row.status} · ${row.phase}`,
  row.model && `Route: ${row.model} · thinking: ${row.thinking ?? "unknown"}`,
  row.task_preview && `Task: ${row.task_preview}`,
  row.active_tool && `${row.active_tool.name} (${row.active_tool.status})`,
  row.live_thinking && "Thinking…", row.live_assistant_preview && `Assistant: ${row.live_assistant_preview}`,
  row.error?.message, `Output: ${row.output_state.replaceAll("_", " ")}`, `Tool calls: ${row.tool_call_count}`,
] : [row.lock_state === "unlocked" ? "Recorded session" : `Busy (${row.lock_state})`, !row.cwd_exists && "Missing workspace"];

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
      let snapshot: SubagentStatusOutput | undefined, loadError: string | undefined;
      let closed = false, generation = 0;
      let refresh: () => Promise<void>;
      let selected: string | undefined, scroll = 0, viewport = 1;
      let action: { kind: "confirm" | "pending"; row: RunSnapshot; label: string } | undefined;
      let actionStatus: string | undefined, pressed: { row: Row; button: boolean } | undefined;
      let hitRows = new Map<number, { row: Row; button: boolean }>();
      let following = true;
      let textPage: { result?: RunTextSliceResult } | undefined;
      let recorded: { items: ActivityCallItem[]; index: number; cursor: string; more: boolean } | undefined;
      let segment: { part: "args" | "result"; page?: ActivitySegment; message?: string } | undefined;
      let detailRequest = 0, detailLoading = false;
      const repaint = () => { if (!closed) tui.requestRender(); };
      const rows = (): Row[] => snapshot?.disk_sessions ?? snapshot?.runs ?? [];
      const row = () => rows().find(item => key(item) === selected);
      const resetDetail = () => { scroll = 0; textPage = recorded = segment = undefined; detailRequest++; detailLoading = false; };
      const select = (next: Row | undefined) => {
        const id = next && key(next);
        if (selected !== id) { selected = id; resetDetail(); }
      };
      const readPage = async (offset = 0) => {
        const current = row();
        if (!current || (tab !== 1 && tab !== 2)) return;
        const id = ++detailRequest;
        textPage = {}; repaint();
        const result = await supervisor.readRunTextSlice({ task_id: current.task_id,
          run_epoch: "run_epoch" in current ? current.run_epoch : undefined, source: tab === 1 ? "output" : "prompt", offset }).catch(() => ({ state: "unavailable" as const }));
        if (closed || detailRequest !== id) return;
        textPage = { result }; scroll = 0; repaint();
      };
      // Coalesce notifications even during the initial load, independently for each scope.
      const loadScope = () => {
        const epoch = ++generation, task = exact, view = scopes[scope];
        snapshot = undefined; loadError = undefined;
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
                if (after && (!textPage || (tab === 1 && "run_epoch" in after && before && "run_epoch" in before && before.output_state !== after.output_state))) void readPage();
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
      const changeTab = (delta: number) => { tab = (tab + tabs.length + delta) % tabs.length; resetDetail(); void readPage(); repaint(); };
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
        } finally { if (detailRequest === id) { detailLoading = false; repaint(); } }
      };
      const body = (current: Row | undefined): string[] => {
        if (loadError) return [loadError];
        if (!snapshot) return ["Loading…"];
        const failures = snapshot.startup_failures.map(f => `Startup failed · ${f.persona_id} · ${time(f.updated_at)} · ${f.error.message}`);
        if (!current) return [...failures, selected ? "Selected run no longer in this scope. Use ↑/↓ to select another." : "No subagent sessions in this scope."];
        if (tab === 0) return [...failures, ...summary(current).filter((v): v is string => typeof v === "string" && !!v)];
        if (tab === 4) return [current.task_id, `Workspace: ${current.cwd}`, ...("run_epoch" in current
          ? [`Epoch: ${current.run_epoch}`, `Started: ${current.started_at}`, `Updated: ${current.updated_at}`]
          : summary(current).filter((value): value is string => typeof value === "string"))];
        if (tab === 3) {
          if (segment) return [`Recorded ${segment.part} · Esc back${segment.page?.has_more ? " · N next page" : ""}`, segment.page?.text ?? segment.message ?? ""];
          if (recorded) return ["Recorded tools · J/K select · Enter args · V result · Esc live", ...recorded.items.map((item, i) =>
            `${i === recorded?.index ? "›" : " "} ${item.action} · ${item.is_error ? "error" : item.result_state ?? "recorded"}`),
            ...(recorded.items.length ? [] : ["No recorded tool calls."])];
          return [`${following ? "Following tail" : "Tail paused"} · F toggle · Enter recorded tools`, ...("run_epoch" in current
            ? [...(current.tool_snapshots ?? []).map(item => `${item.name} (${item.status}) · ${item.args_preview ?? ""}`),
              ...(current.live_thinking ? ["Thinking…"] : []), ...(current.live_assistant_preview ? [current.live_assistant_preview] : [])] : [])];
        }
        const page = textPage?.result;
        if (page?.state === "ok") return [page.text, ...(page.continuation_offset !== undefined ? ["N: next text page"] : [])];
        if (!page) return ["Loading text…"];
        if (tab === 1 && "run_epoch" in current) return [current.output_diagnostic?.message ?? (current.output_state === "pending" ? "Output pending" : `Output ${current.output_state.replaceAll("_", " ")} (text unavailable)`)];
        return ["Text unavailable for this run."];
      };
      return {
        invalidate() {}, dispose: cleanup,
        render(width) {
          const height = tui.terminal.rows, inner = Math.max(1, width - 2);
          const line = (text: string) => `│${truncateToWidth(text, inner, "…", true)}│`;
          const border = (text: string, start: string, end: string) => `${start}${truncateToWidth(text.padEnd(inner, "─"), inner, "", true)}${end}`;
          const list = rows(), index = list.findIndex(item => key(item) === selected);
          const listHeight = Math.min(list.length, Math.max(0, Math.floor((height - 3) / 2)));
          const first = Math.max(0, Math.min(index - listHeight + 1, list.length - listHeight));
          const active = row();
          const tail = tab === 3 && !recorded ? ` · ${following ? "Following tail" : "Tail paused"} (F)` : "";
          const header = ` Larva Subagent Console · ${exact ? "Task" : scopes[scope]}${index >= 0 ? ` ${index + 1}/${list.length}` : ""}${tail} `;
          const lines = [border(header, "┌", "┐"), line(tabs.map((label, i) => i === tab ? theme.fg("accent", `[${label}]`) : label).join(" / "))];
          hitRows = new Map();
          for (const item of list.slice(first, first + listHeight)) {
            const mark = item === active ? "› " : "  ";
            const button = actionFor(item);
            hitRows.set(lines.length, { row: item, button: !!button });
            const description = "run_epoch" in item ? `${time(item.started_at)} ${short(item)} ${item.persona_id} · ${item.task_preview || item.phase}`
              : `${short(item)} ${item.lock_state} · ${item.cwd}`;
            lines.push(line(terminalText(`${mark}${button ? `[${button}] ` : ""}${description}`)));
          }
          viewport = Math.max(1, height - lines.length - 1);
          const status = action?.kind === "confirm" ? `Confirm ${action.label.toLowerCase()} ${action.row.persona_id} · ${short(action.row)}? (Y/N)`
            : action ? `${action.label} in progress…` : actionStatus;
          const content = body(active).flatMap(text => terminalLines(text, inner));
          const room = Math.max(0, viewport - Number(!!status));
          const max = Math.max(0, content.length - room);
          scroll = Math.min(max, tab === 3 && following && !recorded ? Math.max(0, max) : scroll);
          if (status) lines.push(line(theme.fg("accent", terminalText(status))));
          lines.push(...content.slice(scroll, scroll + room).map(line));
          while (lines.length < height - 1) lines.push(line(""));
          lines.push(border(` Tab: tabs · S: scope · ↑/↓: runs · PgUp/PgDn · C: action · Esc `, "└", "┘"));
          return lines.slice(0, height).map(value => truncateToWidth(value, width));
        },
        handleInput(data) {
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
          } else if (matchesKey(data, "up")) move(-1);
          else if (matchesKey(data, "down")) move(1);
          else if (matchesKey(data, "tab")) changeTab(1);
          else if (matchesKey(data, "shift+tab")) changeTab(-1);
          else if (matchesKey(data, "s")) { if (!exact) scope = (scope + 1) % scopes.length; exact = undefined; loadScope(); }
          else if (matchesKey(data, "r")) { actionStatus = undefined; resetDetail(); void refresh(); }
          else if (matchesKey(data, "c")) ask(row());
          else if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
            if (tab === 3) following = false;
            scroll = Math.max(0, scroll + (viewport * (matchesKey(data, "pageUp") ? -1 : 1))); repaint();
          } else if (matchesKey(data, "n")) {
            if (segment?.page?.has_more) void inspectRecorded(segment.part, segment.page);
            else if (!segment && recorded?.more) void inspectRecorded();
            else if (textPage?.result?.state === "ok" && textPage.result.continuation_offset !== undefined) void readPage(textPage.result.continuation_offset);
          } else if (tab === 3) {
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
          if (action) { pressed = undefined; return { handled: true }; }
          if (event.type === "wheel") move(event.wheelDelta ?? 0);
          if (event.type === "press" && event.button === "left") {
            const hit = hitRows.get(event.y);
            const label = actionFor(hit?.row);
            pressed = hit && { row: hit.row, button: !!label && event.x >= 3 && event.x < 5 + label.length };
          }
          if (event.type === "click" && event.button === "left") {
            const hit = pressed; pressed = undefined;
            if (hit?.button) ask(hit.row);
            else if (hit) { select(hit.row); void readPage(); repaint(); }
          }
          return { handled: true };
        },
      };
    }, { overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" } });
  } finally { cleanup?.(); }
}
