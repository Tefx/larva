import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Markdown, Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { isRecord } from "../core/predicates.ts";
import { terminalText } from "./pi-selector-tui.ts";

export function registerSubagentMessageRenderers(pi: Pick<ExtensionAPI, "registerMessageRenderer">): void {
  for (const type of ["larva-subagent-result", "larva-subagent-alert"]) {
    pi.registerMessageRenderer(type, (message, { expanded }, theme) => {
      const details = isRecord(message.details) ? message.details : {};
      const alert = type === "larva-subagent-alert";
      const status = alert ? "stall suspected" : String(details.status ?? "result");
      const output = details.result_text ?? details.result_preview;
      const error = isRecord(details.error) ? details.error.message : undefined;
      const diagnostic = isRecord(details.output_diagnostic) ? details.output_diagnostic.message : undefined;
      const artifact = isRecord(details.full_output_artifact) ? details.full_output_artifact.path : undefined;
      const body = [error, diagnostic, output].filter((value): value is string => typeof value === "string" && !!value).join("\n");
      const title = terminalText(`Larva subagent ${status}: ${details.persona_id ?? "unknown"}`);
      const bg = alert ? "toolPendingBg" : status === "failed" || status === "cancelled" || diagnostic ? "toolErrorBg" : "toolSuccessBg";
      const safe = body.split(/\r\n|\r|\n/).map(terminalText).join("\n");
      const identity = (text: string) => text;
      const markdown = expanded && safe && /^\s*(?:#{1,6}\s|[-*]\s|```|>\s)|\*\*|\[[^\]]+\]\(/m.test(safe) ? new Markdown(safe, 0, 0, {
        heading: identity, link: identity, linkUrl: identity, code: identity, codeBlock: identity, codeBlockBorder: identity,
        quote: identity, quoteBorder: identity, hr: identity, listBullet: identity, bold: identity, italic: identity,
        strikethrough: identity, underline: identity,
      }) : undefined;
      return {
        invalidate: () => markdown?.invalidate(),
        render(width) {
          const out = [title];
          if (expanded) {
            for (const line of [details.task_id, artifact]) if (typeof line === "string") out.push(...wrapTextWithAnsi(terminalText(line), width));
            if (markdown) out.push(...markdown.render(width).map(terminalText));
            else if (safe) out.push(...wrapTextWithAnsi(safe, width));
          } else if (body) out.push(terminalText(body));
          else if (alert) out.push("No recognized progress. The run can still recover.");
          return out.map(line => theme.bg(bg, truncateToWidth(line, width, "…", true)));
        },
      };
    });
  }
}

export function piToolRenderers(name: string, description: string): Pick<ToolDefinition, "renderCall" | "renderResult"> {
  return {
    renderCall(args, theme) {
      const input = isRecord(args) ? args : {};
      const persona = typeof input.persona_id === "string" ? `: ${input.persona_id}` : "";
      const label = name === "larva_subagent" ? `${input.task_id ? "Resume" : "Start"} Larva subagent${persona}`
        : name === "larva_persona_switch" ? `Switch persona${persona}`
        : `${name.replace(/^larva_/, "").replaceAll("_", " ")}${typeof input.scope === "string" ? ` · ${input.scope}` : ""}`;
      return new Text(theme.fg("accent", terminalText(label)), 0, 0);
    },
    renderResult({ details, isError }, { expanded, isPartial }, theme) {
      const d = isRecord(details) ? details : {};
      const error = isRecord(d.error) ? d.error.message : undefined;
      const summary = typeof error === "string" ? error : isPartial ? "Working…"
        : d.status === "accepted" ? "Accepted — result will arrive by callback"
        : Array.isArray(details) ? `${details.length} matching personas`
        : Array.isArray(d.results) ? d.results.map(row => String(row.outcome).replaceAll("_", " ")).join(", ")
        : typeof d.ready === "boolean" ? d.ready ? "Wait ready" : d.timed_out ? "Wait timed out" : "Wait not ready"
        : Array.isArray(d.runs) ? `${d.disk_sessions instanceof Array ? d.disk_sessions.length : d.runs.length} sessions · ${Array.isArray(d.startup_failures) ? d.startup_failures.length : 0} startup failures`
        : Array.isArray(d.items) ? `${d.items.length} recorded calls`
        : d.ok === true ? `${d.persistent ? "Switched" : "Borrowed"}: ${d.persona_id}`
        : typeof d.status === "string" ? d.status.replaceAll("_", " ") : description;
      const body = expanded && details !== undefined && !isPartial ? d.status === "accepted" ? String(d.task_id) : JSON.stringify(details, null, 2) : "";
      return new Text(theme.fg(isError || error ? "warning" : "accent", terminalText(summary))
        + (body ? "\n" + body.split("\n").map(terminalText).join("\n") : ""), 0, 0);
    },
  };
}
