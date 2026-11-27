import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { isRecord } from "../core/predicates.ts";
import { paintSurface, presentSubagentResult, terminalLines, terminalText } from "./pi-tui-chrome.ts";

const PREVIEW_LINES = 8;

export function registerSubagentMessageRenderers(pi: Pick<ExtensionAPI, "registerMessageRenderer">): void {
  for (const type of ["larva-subagent-result", "larva-subagent-alert"]) {
    pi.registerMessageRenderer(type, (message, { expanded, outputPad }, theme) => {
      const details = isRecord(message.details) ? message.details : {};
      const alert = type === "larva-subagent-alert";
      const status = alert ? "stall suspected" : String(details.status ?? "result");
      const output = details.result_text ?? details.result_preview;
      const error = isRecord(details.error) ? details.error.message : undefined;
      const diagnostic = isRecord(details.output_diagnostic) ? details.output_diagnostic.message : undefined;
      const artifact = isRecord(details.full_output_artifact) ? details.full_output_artifact.path : undefined;
      const metadata = expanded ? [details.task_id, artifact] : [];
      const notes = [...metadata, error, diagnostic].filter((value): value is string => typeof value === "string" && !!value);
      const title = terminalText(`Larva subagent ${status}: ${details.persona_id ?? "unknown"}`);
      const failed = status === "failed" || !!diagnostic;
      const pending = !failed && status !== "success";
      const bg = failed ? "toolErrorBg" : pending ? "toolPendingBg" : "toolSuccessBg";
      const fg = failed ? "error" : pending ? "warning" : "success";
      // Only structured display data belongs in the card, not message.content's model preamble.
      const presentation = presentSubagentResult(typeof output === "string" && output ? output : alert
        ? "No recognized progress. The run can still recover." : notes.length ? "" : "No final subagent output is available.");
      return {
        invalidate: () => presentation.invalidate(),
        render(width) {
          const padding = Math.min(outputPad ?? 0, Math.max(0, Math.floor((width - 1) / 2)));
          const inner = Math.max(1, width - padding * 2);
          const pad = " ".repeat(padding);
          const body = [...notes.flatMap(note => terminalLines(note, inner)), ...presentation.render(inner)];
          const preview = expanded || body.length <= PREVIEW_LINES ? body
            : [...body.slice(0, PREVIEW_LINES - 1), "… [truncated]"];
          return ["", theme.fg(fg, theme.bold(title)), ...preview, ""].map(line =>
            paintSurface(`${pad}${truncateToWidth(line, inner, "…", true)}${pad}`, text => theme.bg(bg, text)));
        },
      };
    });
  }
}

export function piToolRenderers(name: string, description: string): Pick<ToolDefinition, "renderCall" | "renderResult"> {
  return {
    renderCall(args, theme) {
      const input = isRecord(args) ? args : {};
      const persona = typeof input.persona_id === "string" ? terminalText(input.persona_id) : "";
      if (name === "larva_subagent") {
        const resume = typeof input.task_id === "string";
        const header = `larva_subagent -> ${persona} [${resume ? "resume" : "spawn"}]`;
        const task = typeof input.task === "string" ? terminalText(input.task).replace(/\s+/g, " ").trim() : "";
        const preview = truncateToWidth(task, Math.max(1, 119 - header.length), "…");
        const handle = resume ? terminalText(String(input.task_id)) : "";
        const idLine = handle ? `\n${theme.fg("dim", `task_id: ${handle.length > 80 ? `…${handle.slice(-79)}` : handle}`)}` : "";
        return new Text(`${theme.fg("accent", header)}${preview ? ` ${preview}` : ""}${idLine}`, 0, 0);
      }
      const label = name === "larva_persona_switch" ? `Switch persona${persona ? `: ${persona}` : ""}`
        : `${name.replace(/^larva_/, "").replaceAll("_", " ")}${typeof input.scope === "string" ? ` · ${input.scope}` : ""}`;
      return new Text(theme.fg("accent", terminalText(label)), 0, 0);
    },
    renderResult({ details, isError }, { expanded, isPartial }, theme, context) {
      const d = isRecord(details) ? details : {};
      const error = isRecord(d.error) ? d.error.message : undefined;
      const summary = typeof error === "string" ? error : isPartial ? "Working…"
        : d.status === "accepted" ? "Accepted — result will arrive by callback"
        : Array.isArray(details) ? `${details.length} matching personas`
        : Array.isArray(d.results) ? d.results.flatMap(row => isRecord(row) && typeof row.outcome === "string"
          ? [row.outcome.replaceAll("_", " ")] : []).join(", ") || "No cancellation outcomes"
        : typeof d.ready === "boolean" ? d.ready ? "Wait ready" : d.timed_out ? "Wait timed out" : "Wait not ready"
        : Array.isArray(d.runs) ? `${Array.isArray(d.disk_sessions) ? d.disk_sessions.length : d.runs.length} sessions · ${Array.isArray(d.startup_failures) ? d.startup_failures.length : 0} startup failures`
        : Array.isArray(d.items) ? `${d.items.length} recorded calls`
        : isRecord(d.call) ? "Recorded call details"
        : d.ok === true ? `${d.persistent ? "Switched" : "Borrowed"}: ${d.persona_id}`
        : typeof d.status === "string" ? d.status.replaceAll("_", " ") : description;
      const header = theme.fg(context?.isError || isError || error ? "error" : isPartial || d.status === "accepted" ? "warning" : "accent", terminalText(summary));
      if (!expanded || details === undefined || isPartial) return new Text(header, 0, 0);
      const { task_id, ...receipt } = d;
      const accepted = d.status === "accepted" && typeof task_id === "string";
      const body = presentSubagentResult(JSON.stringify(accepted ? receipt : details, null, 2));
      return {
        invalidate: () => body.invalidate(),
        render: width => [...new Text(header, 0, 0).render(width), ...(accepted ? terminalLines(task_id, width) : []), ...body.render(width)],
      };
    },
  };
}
