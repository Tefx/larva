import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { toErrorEnvelope } from "../core/errors.ts";
import type { DiskSessionSummary, RunSnapshot, SubagentStatusOutput, SubagentStatusScope } from "../core/types.ts";
import type { SubagentSupervisor } from "../runtime/supervisor.ts";
import { isTerminal } from "../runtime/outbox.ts";
import { terminalText } from "./pi-selector-tui.ts";

type Row = RunSnapshot | DiskSessionSummary;
const scopes: SubagentStatusScope[] = ["recent", "active", "disk"];
const canCancel = (row: Row | undefined): row is RunSnapshot => !!row && "run_epoch" in row && !isTerminal(row.status) && row.status !== "cancelling";
const rowKey = (row: Row) => "run_epoch" in row ? row.run_epoch : row.task_id;

function detail(row: Row): string[] {
  if (!("run_epoch" in row)) return [row.task_id, row.cwd, !row.cwd_exists ? "Missing workspace" : "",
    row.lock_state === "unlocked" ? "Recorded session" : `Busy (${row.lock_state})`];
  const heading = [row.task_id, row.cwd, `${row.status} · ${row.phase}`, ...(row.error ? [row.error.message] : [])];
  switch (row.output_state) {
    case "pending": return [...heading, "Output pending"];
    case "inline": return [...heading, row.result_text || "No output text"];
    case "artifactized": return [...heading, row.full_output_artifact?.path ?? "Output artifact", row.result_preview ?? ""];
    case "delivery_failed": return [...heading, row.output_diagnostic?.message ?? "Could not deliver output"];
    case "evicted": return [...heading, "Snapshot expired; inspect the recorded transcript."];
  }
}

export async function openSubagentConsole(ctx: ExtensionContext, supervisor: SubagentSupervisor, taskId?: string): Promise<void> {
  // Keep observer and terminal resources scoped to Pi's overlay handle lifetime.
  let cleanup: (() => void) | undefined;
  try {
    await ctx.ui.custom<void>((tui, theme, _keys, done) => {
      let scopeIndex = 0;
      let exact = taskId;
      let snapshot: SubagentStatusOutput | undefined;
      let selected: string | undefined;
      let visible: Row[] = [];
      let displayed: Row | undefined;
      let loadError: string | undefined;
      let actionStatus: string | undefined;
      let cancelling = false;
      let closed = false;
      let refreshQueued = false;
      let refreshing = false;
      let queryGeneration = 0;
      const rows = () => [...(snapshot?.runs ?? []), ...(snapshot?.disk_sessions ?? [])];
      const refresh = async () => {
        refreshQueued = true;
        if (refreshing || closed) return;
        refreshing = true;
        try {
          while (refreshQueued && !closed) {
            refreshQueued = false;
            const generation = queryGeneration;
            try {
              const next = await supervisor.status(exact ? { task_id: exact } : { scope: scopes[scopeIndex], limit: 25 });
              if (closed || generation !== queryGeneration) continue;
              snapshot = next;
              loadError = undefined;
            } catch (error) {
              if (closed || generation !== queryGeneration) continue;
              snapshot = undefined;
              loadError = toErrorEnvelope(error).error.message;
            }
            tui.requestRender();
          }
        } finally { refreshing = false; }
      };
      const unsubscribe = supervisor.subscribe(() => { if (scopes[scopeIndex] !== "disk" || exact) void refresh(); });
      cleanup = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
      };
      const move = (delta: number) => {
        const list = rows();
        const cursor = Math.max(0, list.findIndex(row => rowKey(row) === selected));
        selected = rowKeyOrUndefined(list[Math.max(0, Math.min(list.length - 1, cursor + delta))]);
        tui.requestRender();
      };
      const cancel = async (row: RunSnapshot) => {
        if (cancelling) return;
        cancelling = true;
        actionStatus = "Cancelling…";
        tui.requestRender();
        try {
          const { results } = await supervisor.cancel({ task_ids: [row.task_id], reason: "Cancelled from the Subagent Console.",
            expected_run_epochs: { [row.task_id]: row.run_epoch } });
          actionStatus = `Cancel: ${results[0].outcome}`;
        } catch (error) { actionStatus = toErrorEnvelope(error).error.message; }
        finally { cancelling = false; if (!closed) { void refresh(); tui.requestRender(); } }
      };
      void refresh();
      return {
        invalidate() {}, dispose: cleanup,
        render(width) {
          const height = tui.terminal.rows;
          const list = rows();
          const index = Math.max(0, list.findIndex(row => rowKey(row) === selected));
          selected = rowKeyOrUndefined(list[index]);
          const rowCount = Math.max(0, Math.floor((height - 3) / 2));
          const start = Math.max(0, index - rowCount + 1);
          visible = list.slice(start, start + rowCount);
          displayed = rowCount ? list[index] : undefined;
          const lines = [theme.fg("accent", `Larva Subagent Console — ${exact ? "task" : scopes[scopeIndex]} (${list.length})`),
            "↑/↓ Select · Tab Scope · C Cancel · R Refresh · Esc Close"];
          for (const row of visible) {
            const marker = row === displayed ? "›" : " ";
            const line = "run_epoch" in row ? `${row.persona_id} · ${row.phase} · ${row.task_id}` : `${row.lock_state} · ${row.task_id}`;
            lines.push(`${marker} ${canCancel(row) ? "[Cancel] " : ""}${terminalText(line)}`);
          }
          if (actionStatus) lines.push(theme.fg("accent", terminalText(actionStatus)));
          if (loadError) lines.push(theme.fg("error", terminalText(loadError)));
          else if (!snapshot) lines.push("Loading…");
          else if (!list.length) lines.push(snapshot.startup_failures.length
            ? terminalText(`Startup failed: ${snapshot.startup_failures[0].error.message}`) : "No subagent sessions in this scope.");
          if (displayed) for (const line of detail(displayed)) {
            for (const part of line.split(/\r?\n/, height)) {
              if (lines.length >= height) break;
              if (part) lines.push(terminalText(part));
            }
          }
          return Array.from({ length: height }, (_, i) => {
            const line = lines[i] ?? "";
            return truncateToWidth(line, width, "…", true);
          });
        },
        handleInput(data) {
          if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) done();
          else if (matchesKey(data, "up")) move(-1);
          else if (matchesKey(data, "down")) move(1);
          else if (matchesKey(data, "c") && canCancel(displayed) && rowKey(displayed) === selected) void cancel(displayed);
          else if (matchesKey(data, "r")) void refresh();
          else if (matchesKey(data, "tab")) {
            if (!exact) scopeIndex = (scopeIndex + 1) % scopes.length;
            exact = undefined;
            queryGeneration++;
            snapshot = displayed = selected = loadError = undefined;
            visible = [];
            void refresh();
            tui.requestRender();
          }
        },
        // Fullscreen Pi owns mouse mode and dispatches normalized events.
        // Regular Pi does not dispatch them; keyboard actions still work there.
        handleMouse(event) {
          if (event.type === "wheel") { move(event.wheelDelta ?? 0); return { handled: true }; }
          if (event.type === "click" && event.button === "left") {
            const row = visible[event.y - 2];
            if (row) {
              selected = rowKey(row);
              if (event.x >= 2 && event.x < 10 && canCancel(row)) void cancel(row);
            }
          }
          return { handled: true };
        },
      };
    }, { overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" } });
  } finally { cleanup?.(); }
}

function rowKeyOrUndefined(row: Row | undefined): string | undefined {
  return row && rowKey(row);
}
