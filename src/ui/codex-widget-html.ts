import { renderCodexAppHtml } from "./codex-panel-html.ts";

export const CODEX_WIDGET_URI = "ui://larva-pi-subagent/widget-v4";
export const CODEX_WIDGET_DISPLAY_MODES = ["inline", "fullscreen"] as const;

export function renderCodexWidgetHtml(version?: string): string {
  return renderCodexAppHtml("widget", CODEX_WIDGET_DISPLAY_MODES, version);
}
