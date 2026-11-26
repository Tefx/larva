import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, replaceControlCharacters, stripTerminalSequences } from "@earendil-works/pi-tui";
import type { PersonaSummary, SwitchConfirmationChoice } from "../core/types.ts";
import type { PersonaSwitchContext } from "../runtime/persona-lease.ts";

export function terminalText(value: string): string {
  return replaceControlCharacters(stripTerminalSequences(value)).replace(/[\r\n\t]/g, " ");
}

export async function selectPersona(ctx: ExtensionContext, personas: readonly PersonaSummary[]): Promise<string | null | undefined> {
  const none = "None — clear the active persona";
  const options = new Map<string, string | null>([[none, null]]);
  for (const { id, description } of personas) options.set(`${id} — ${terminalText(description)}`, id);
  const selected = await ctx.ui.select(personas.length ? "Larva persona" : "Larva persona (none installed)", [...options.keys()]);
  return selected === undefined ? undefined : options.get(selected);
}

export function confirmPersonaSwitch(ctx: ExtensionContext): NonNullable<PersonaSwitchContext["confirm"]> {
  return async ({ persona_id, reason, choices, signal, respond }) => {
    const selected = await ctx.ui.custom<SwitchConfirmationChoice | null>((tui, theme, _keys, done) => {
      let index = 0;
      const abort = () => { dispose(); done(null); };
      const dispose = () => signal.removeEventListener("abort", abort);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      return {
        invalidate() {}, dispose,
        render(width) {
          return [`Switch to ${persona_id}?`, terminalText(reason), ...choices.map(({ label }, row) =>
            row === index ? theme.fg("accent", `› ${label}`) : `  ${label}`)]
            .map(line => truncateToWidth(line, width));
        },
        handleInput(data) {
          if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) abort();
          else if (matchesKey(data, "enter")) { dispose(); done(choices[index].id); }
          else if (matchesKey(data, "up") || matchesKey(data, "down")) {
            index = (index + choices.length + (matchesKey(data, "up") ? -1 : 1)) % choices.length;
            tui.requestRender();
          }
        },
      };
    }, { overlay: true, overlayOptions: { width: "90%", maxHeight: 6 } });
    respond(selected);
  };
}
