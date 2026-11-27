import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, replaceControlCharacters, stripTerminalSequences, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { PersonaSummary, SwitchConfirmationChoice } from "../core/types.ts";
import type { PersonaSwitchContext } from "../runtime/persona-lease.ts";

export function terminalText(value: string): string {
  return replaceControlCharacters(stripTerminalSequences(value)).replace(/[\r\n\t]/g, " ");
}

export function terminalLines(value: string, width: number): string[] {
  return value.split(/\r\n|\r|\n/).flatMap(line => wrapTextWithAnsi(terminalText(line), Math.max(1, width)));
}

type Option<T> = { value: T; label: string; preview?: string; current?: boolean };

export function selectOption<T>(ctx: ExtensionContext, title: string, options: readonly Option<T>[], search = false) {
  return ctx.ui.custom<T | undefined>((tui, theme, _keys, done) => {
    let index = 0, query = "", settled = false;
    const matches = () => options.filter(row => `${row.label} ${row.preview ?? ""}`.toLowerCase().includes(query.toLowerCase()));
    const finish = (result?: T) => { if (!settled) { settled = true; done(result); } };
    return {
      invalidate() {}, dispose: () => finish(),
      render(width) {
        const rows = matches(), row = rows[index];
        const height = Math.min(14, tui.terminal.rows);
        const header = [theme.fg("accent", title), ...(search ? [`Search: ${query}`] : [])].slice(0, Math.max(0, height - 1));
        const preview = row?.preview ? terminalLines(row.preview, width).slice(0, Math.min(4, Math.max(0, height - header.length - 1))) : [];
        const capacity = Math.max(1, height - header.length - preview.length);
        const start = Math.max(0, index - capacity + 1);
        const list = rows.slice(start, start + capacity).map((item, i) => {
          const label = `${item.label}${item.current ? " (current)" : ""}`;
          return i + start === index ? theme.fg("accent", `› ${label}`) : `  ${label}`;
        });
        return [...header, ...(list.length ? list : ["No matches"]), ...preview].slice(0, height)
          .map(line => truncateToWidth(line, width));
      },
      handleInput(data) {
        if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return finish();
        const rows = matches();
        if (matchesKey(data, "enter")) { if (rows[index]) finish(rows[index].value); return; }
        if (matchesKey(data, "up")) index = Math.max(0, index - 1);
        else if (matchesKey(data, "down")) index = Math.max(0, Math.min(rows.length - 1, index + 1));
        else if (search && matchesKey(data, "backspace")) { query = [...query].slice(0, -1).join(""); index = 0; }
        else if (search && data && data === terminalText(data)) { query += data; index = 0; }
        tui.requestRender();
      },
    };
  }, { overlay: true, overlayOptions: { width: "90%", maxHeight: 14 } });
}

export function selectPersona(ctx: ExtensionContext, personas: readonly PersonaSummary[], current: string | null) {
  return selectOption<string | null>(ctx, "Larva persona · ↑/↓ Select · Enter · Esc", [
    { value: null, label: "None", current: current === null, preview: "Clear the active persona." },
    ...personas.map(({ id, description, model, thinking, can_spawn }) => ({
      value: id, label: id, current: current === id,
      preview: `Route: ${model} · Thinking: ${thinking} · Spawn: ${Array.isArray(can_spawn) ? can_spawn.join(", ") : can_spawn ? "allowed" : "disabled"}\n${description}`,
    })),
  ], true);
}

export function confirmPersonaSwitch(ctx: ExtensionContext, from: string | null): NonNullable<PersonaSwitchContext["confirm"]> {
  return async ({ persona_id, reason, choices, signal, respond }) => {
    const selected = await ctx.ui.custom<SwitchConfirmationChoice | null>((tui, theme, _keys, done) => {
      let index = 0, offset = 0, reasonHeight = 1, maxOffset = 0, settled = false;
      const finish = (choice: SwitchConfirmationChoice | null) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        done(choice);
      };
      const abort = () => finish(null);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      return {
        invalidate() {}, dispose: abort,
        render(width) {
          const height = Math.min(tui.terminal.rows, 12);
          const choiceHeight = Math.max(1, Math.min(choices.length, height - 2));
          reasonHeight = Math.max(0, height - choiceHeight - 1);
          const parts = terminalLines(reason, width);
          maxOffset = Math.max(0, parts.length - reasonHeight);
          offset = Math.min(maxOffset, offset);
          const start = Math.max(0, index - choiceHeight + 1);
          return [`${from ?? "None"} → ${persona_id}  (PgUp/PgDn reason)`, ...parts.slice(offset, offset + reasonHeight),
            ...choices.slice(start, start + choiceHeight).map(({ label }, row) =>
              row + start === index ? theme.fg("accent", `› ${label}`) : `  ${label}`)]
            .slice(-height).map(line => truncateToWidth(line, width));
        },
        handleInput(data) {
          if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return abort();
          if (matchesKey(data, "enter")) return finish(choices[index].id);
          if (matchesKey(data, "up") || matchesKey(data, "down")) {
            index = (index + choices.length + (matchesKey(data, "up") ? -1 : 1)) % choices.length;
          } else if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
            offset = Math.max(0, Math.min(maxOffset, offset + Math.max(1, reasonHeight) * (matchesKey(data, "pageUp") ? -1 : 1)));
          }
          tui.requestRender();
        },
      };
    }, { overlay: true, overlayOptions: { width: "90%", maxHeight: 12 } });
    respond(selected);
  };
}
