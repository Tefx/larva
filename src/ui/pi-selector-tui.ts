import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, SelectList, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { PersonaSummary, SwitchConfirmationChoice } from "../core/types.ts";
import type { PersonaSwitchContext } from "../runtime/persona-lease.ts";
import { centeredOverlay, fieldLines, modalFrame, terminalLines, terminalText } from "./pi-tui-chrome.ts";

export { terminalText } from "./pi-tui-chrome.ts"; // Also used by the Pi extension's status surface.

type Option<T> = { value: T; label: string; preview?: string; current?: boolean; details?: readonly (readonly [string, string])[] };
const CURRENT = " (current)";

export function selectOption<T>(ctx: ExtensionContext, title: string, options: readonly Option<T>[], search = false) {
  return ctx.ui.custom<T | undefined>((tui, theme, _keys, done) => {
    const input = search ? new Input({ prompt: "Filter: " }) : undefined;
    let rows = options, index = 0, settled = false;
    let detailOffset = 0, detailRoom = 0, detailMax = 0;
    const finish = (result?: T) => { if (!settled) { settled = true; done(result); } };
    const dim = (line: string) => theme.fg("dim", line);
    const accent = (line: string) => theme.fg("accent", theme.bold(line));
    const listTheme = {
      selectedPrefix: accent, selectedText: accent, description: (text: string) => theme.fg("muted", text),
      scrollInfo: dim, noMatch: () => theme.fg("warning", "No matches"),
    };
    let list: SelectList | undefined, maxVisible = 0;
    const filter = (value: string) => {
      const query = value.trim().toLocaleLowerCase();
      rows = options.filter(row => `${row.label} ${row.preview ?? ""}`.toLocaleLowerCase().includes(query));
      // Prefer ID prefix matches while keeping the original order within each rank.
      if (query) {
        const rank = (row: Option<T>) => {
          const id = row.label.toLocaleLowerCase();
          return id.startsWith(query) ? 0 : id.includes(query) ? 1 : 2;
        };
        rows = [...rows].sort((left, right) => rank(left) - rank(right));
      }
      index = detailOffset = 0; list = undefined;
    };
    return {
      get focused() { return input?.focused ?? true; },
      set focused(value: boolean) { if (input) input.focused = value; },
      invalidate() { input?.invalidate(); list?.invalidate(); }, dispose: () => finish(),
      render(width) {
        const frame = modalFrame(width, tui.terminal.rows, 36);
        const { inner, room } = frame;
        const row = rows[index];
        const details = row ? (row.details ?? (row.preview ? [["Description", row.preview]] as const : []))
          .flatMap(([label, value]) => fieldLines(label, value, inner, accent, 13)) : [];
        const header = input && room >= 2 ? input.render(inner) : [];
        if (input && room >= 12) header.push(dim("Type to filter persona IDs/descriptions."));
        const footer = room >= 7 ? [dim("↑↓ navigate · Enter confirm · Esc cancel · PgUp/PgDn detail")] : [];
        const usable = room - header.length - footer.length;
        const showDetail = usable >= 5;
        // Reserve native list indicator space only when the list is scrollable.
        const listRoom = showDetail ? Math.min(Math.max(2, rows.length + 1), Math.max(2, Math.floor(usable / 2))) : usable;
        const capacity = Math.max(1, listRoom - Number(listRoom > 1 && rows.length > listRoom));
        if (!list || capacity !== maxVisible) {
          maxVisible = capacity;
          list = new SelectList(rows.map(({ label, preview, current }, i) => ({ value: String(i),
            label: terminalText(`${label}${current ? CURRENT : ""}`), description: preview ? terminalText(preview) : undefined,
          })), capacity, listTheme, {
            minPrimaryColumnWidth: 18, maxPrimaryColumnWidth: 34,
            truncatePrimary: ({ item, text, maxWidth }) => rows[Number(item.value)]?.current && maxWidth > CURRENT.length && visibleWidth(text) > maxWidth
              ? truncateToWidth(text.slice(0, -CURRENT.length), maxWidth - CURRENT.length, "…") + CURRENT
              : truncateToWidth(text, maxWidth, "…"),
          });
        }
        list.setSelectedIndex(index);
        const body = [...header, ...list.render(inner).slice(0, listRoom)];
        const divider = showDetail ? body.length : -1;
        detailRoom = showDetail ? usable - (body.length - header.length) - 2 : 0;
        detailMax = Math.max(0, details.length - detailRoom);
        detailOffset = Math.min(detailMax, detailOffset);
        if (showDetail) body.push("", accent(`Detail${detailMax ? ` · ${detailOffset + 1}–${Math.min(details.length, detailOffset + detailRoom)}/${details.length}` : ""}`),
          ...(row ? details.slice(detailOffset, detailOffset + detailRoom) : [dim("No matching option.")]));
        return frame.render(title, [...body, ...footer], divider);
      },
      handleInput(data) {
        if (settled) return;
        if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return finish();
        if (matchesKey(data, "enter")) { if (rows[index]) finish(rows[index].value); return; }
        if (matchesKey(data, "up") || matchesKey(data, "down")) {
          index = Math.max(0, Math.min(rows.length - 1, index + (matchesKey(data, "up") ? -1 : 1)));
          detailOffset = 0;
        } else if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
          detailOffset = Math.max(0, Math.min(detailMax, detailOffset + Math.max(1, detailRoom) * (matchesKey(data, "pageUp") ? -1 : 1)));
        } else if (input) {
          const before = input.getValue();
          // Pi delivers bracketed paste as one frame; Input cleans whitespace but
          // otherwise stores its payload verbatim, including terminal controls.
          const paste = /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(data);
          input.handleInput(paste ? `\x1b[200~${terminalText(paste[1])}\x1b[201~` : data);
          if (input.getValue() !== before) filter(input.getValue());
        }
        tui.requestRender();
      },
    };
  }, centeredOverlay);
}

export function selectPersona(ctx: ExtensionContext, personas: readonly PersonaSummary[], current: string | null) {
  return selectOption<string | null>(ctx, "Select Larva persona", [
    { value: null, label: "None", current: current === null, preview: "Clear the active persona.",
      details: [["ID", "None"], ["Status", current === null ? "Current" : "Inactive"], ["Description", "Clear the active persona."]] },
    ...personas.map(({ id, description, model, thinking, can_spawn, spec_digest }) => ({
      value: id, label: id, current: current === id, preview: `${model} | ${description}`,
      details: [["ID", id], ["Status", current === id ? "Current" : "Available"], ["Model", model], ["Thinking", thinking],
        ["Spawn", Array.isArray(can_spawn) ? can_spawn.join(", ") || "disabled" : can_spawn ? "allowed" : "disabled"],
        ["Description", description], ["Digest", spec_digest]] as const,
    })),
  ], true);
}

export function confirmPersonaSwitch(ctx: ExtensionContext, from: string | null): NonNullable<PersonaSwitchContext["confirm"]> {
  return async ({ persona_id, reason, choices, signal, respond }) => {
    if (signal.aborted) { respond(null); return; }
    const selected = await ctx.ui.custom<SwitchConfirmationChoice | null>((tui, theme, _keys, done) => {
      let index = 0, offset = 0, reasonHeight = 0, maxOffset = 0, settled = false;
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
          const frame = modalFrame(width, tui.terminal.rows, 22);
          const { inner, room } = frame;
          const route = terminalText(`${from ?? "None"} → ${persona_id}`);
          const choiceHeight = Math.min(choices.length, Math.max(1, room - Number(room > 1)));
          const spare = room - choiceHeight;
          const parts = terminalLines(reason, inner);
          reasonHeight = Math.max(0, Math.min(parts.length, spare - (spare >= 4 ? 3 : 2)));
          maxOffset = Math.max(0, parts.length - reasonHeight);
          offset = Math.min(maxOffset, offset);
          const start = Math.max(0, index - choiceHeight + 1);
          const header = spare ? [theme.fg("accent", route) + (spare === 3 ? theme.fg("dim", " · Reason: PgUp/PgDn") : "")] : [];
          if (spare >= 4) header.push(theme.fg("dim", "Reason · PgUp/PgDn"));
          header.push(...parts.slice(offset, offset + reasonHeight));
          const divider = spare >= 2 ? header.length : -1;
          if (divider >= 0) header.push("");
          return frame.render("⚠ Borrow persona?", [...header, ...choices.slice(start, start + choiceHeight).map(({ label }, i) =>
            i + start === index ? theme.fg("accent", theme.bold(`› ${label}`)) : `  ${label}`)], divider);
        },
        handleInput(data) {
          if (settled) return;
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
    }, centeredOverlay);
    respond(selected);
  };
}
