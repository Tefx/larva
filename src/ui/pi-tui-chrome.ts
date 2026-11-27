import { Markdown, replaceControlCharacters, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { MarkdownTheme, OverlayHandle, OverlayOptions } from "@earendil-works/pi-tui";

const RESET = "\x1b[0m";
const SURFACE_BG = "\x1b[48;5;235m";
const BORDER_FG = "\x1b[38;5;116m";
const SHADOW_FG = "\x1b[38;5;232m";

export const centeredOverlay = {
  overlay: true,
  overlayOptions: { anchor: "center", width: "90%", maxHeight: "90%", margin: 1 } satisfies OverlayOptions,
  onHandle: (handle: OverlayHandle) => handle.focus?.(),
};

export function paintSurface(line: string, paint = (text: string) => SURFACE_BG + text): string {
  // Keep SGR's reset semantics (including foreground/bold), but restore the background
  // before the next printable cell. Some Pi components emit the short form ESC[m.
  return line.split(/\x1b\[(?:0)?m/g).map(paint).join(RESET) + RESET;
}

export function terminalText(value: string): string {
  return replaceControlCharacters(stripTerminalSequences(value)).replace(/[\r\n\t]/g, " ");
}

function safeSource(value: string): string {
  return stripTerminalSequences(value).replace(/\r\n?/g, "\n").replaceAll("\t", "   ")
    .split("\n").map(replaceControlCharacters).join("\n");
}

function plainLines(safe: string, width: number): string[] {
  return safe.split("\n").flatMap(line => line ? wrapTextWithAnsi(line, width) : [""]);
}

export function terminalLines(value: string, width: number): string[] {
  return plainLines(safeSource(value), Math.max(1, width));
}

// Same row budget as Pi's overlay compositor, so it doesn't lop off the frame.
export function modalFrame(width: number, rows: number, maxRows = Infinity) {
  const height = Math.max(1, Math.min(maxRows, Math.floor(rows * 0.9), rows - 2));
  const shadow = width >= 8 && height >= 4;
  const box = width - Number(shadow);
  const bordered = box >= 3 && height >= 3;
  const inset = bordered ? box >= 5 ? 2 : 1 : 0;
  const inner = Math.max(1, box - inset * 2);
  const room = height - 2 * Number(bordered) - Number(shadow);
  const color = (text: string) => `${BORDER_FG}${text}\x1b[39m`;
  const edge = (left: string, middle: string, right: string) => {
    const clipped = truncateToWidth(middle, box - 2, "");
    return color(left + clipped + "─".repeat(box - 2 - visibleWidth(clipped)) + right);
  };
  const shade = (text: string) => SHADOW_FG + text + RESET;
  return { inner, room, inset, top: Number(bordered), render(title: string, lines: readonly string[], divider = -1) {
    const body = lines.slice(0, room).map((line, i) => {
      if (bordered && i === divider) return edge("├", "", "┤");
      const text = truncateToWidth(line, inner, "…", true);
      const pad = inset === 2 ? " " : "";
      return bordered ? `${color("│")}${pad}${text}${pad}${color("│")}` : text;
    });
    const frame = bordered ? [edge("╭", `─ ${title} `, "╮"), ...body, edge("╰", "", "╯")]
      : body.length ? body : [truncateToWidth(title, inner, "…", true)];
    return [...frame.map(line => paintSurface(line) + (shadow ? shade("█") : "")),
      ...(shadow ? [shade(" " + "▀".repeat(box))] : [])];
  } };
}

export function fieldLines(label: string, value: string, width: number, style: (text: string) => string, columns: number): string[] {
  const prefix = `${label}:`.padEnd(columns - 1) + " ";
  const indent = visibleWidth(prefix);
  if (width - indent < 6) return terminalLines(`${label}: ${value || "—"}`, width);
  return terminalLines(value || "—", width - indent).map((line, i) => (i === 0 ? style(prefix) : " ".repeat(indent)) + line);
}

const sgr = (start: number, end: number) => (text: string) => `\x1b[${start}m${text}\x1b[${end}m`;
export const DEFAULT_MARKDOWN_THEME: MarkdownTheme = {
  heading: sgr(96, 39), link: sgr(94, 39), linkUrl: sgr(90, 39), code: sgr(93, 39),
  codeBlock: sgr(92, 39), codeBlockBorder: sgr(90, 39), codeBlockIndent: "  ",
  quote: sgr(36, 39), quoteBorder: sgr(96, 39), hr: sgr(90, 39),
  listBullet: text => sgr(96, 39)(text === "- " ? "• " : text),
  bold: sgr(1, 22), italic: sgr(3, 23), strikethrough: sgr(9, 29), underline: sgr(4, 24),
};

function hasCompleteMarkdownFence(value: string): boolean {
  let opening: string | undefined;
  for (const line of value.split("\n")) {
    if (opening === undefined) opening = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    else {
      const closing = /^ {0,3}(`{3,}|~{3,}) *$/.exec(line)?.[1];
      if (closing && closing[0] === opening[0] && closing.length >= opening.length) return true;
    }
  }
  return false;
}

function markdownLooksIntentionallyFormatted(value: string): boolean {
  return hasCompleteMarkdownFence(value)
    || /^ {0,3}(?:#{1,6}\s|(?:[-+*]|\d+[.)])\s|> *)\S/m.test(value)
    || /^ *\|?.+\|.+\|? *\n *\|? *:?-{3,}:? *(?:\| *:?-{3,}:? *)+\|? *$/m.test(value)
    || /^\S[^\n]*\n *(?:={3,}|-{3,}) *$/m.test(value)
    || /\[[^\]\n]+\]\([^\n)]+\)|\*\*[^\n]+?\*\*|__[^\n]+?__|~~[^\n]+?~~|`[^`\n]+`|(?:^|[\s(])\*[^*\n]+\*(?=$|[\s).,!?:;])/m.test(value);
}

export function presentSubagentResult(source: string) {
  let json: string | undefined;
  try { json = JSON.stringify(JSON.parse(source), null, 2); } catch { /* Not JSON (including partial pages). */ }
  const safe = safeSource(source);
  const partialJson = /^\s*(?:\{|\[\s*(?:["{\[\d-]|true\b|false\b|null\b|$))/.test(safe);
  const markdown = json !== undefined ? new Markdown(`\`\`\`json\n${safeSource(json)}\n\`\`\``, 0, 0, DEFAULT_MARKDOWN_THEME)
    : !partialJson && markdownLooksIntentionallyFormatted(safe) ? new Markdown(safe, 0, 0, DEFAULT_MARKDOWN_THEME) : undefined;
  return {
    invalidate: () => markdown?.invalidate(),
    render(width: number): string[] {
      width = Math.max(1, width);
      // The Markdown component implements semantic paragraph spacing; plain pages
      // keep exact newlines, including blank rows and whitespace at slice edges.
      let lines: readonly string[] | undefined;
      try { lines = markdown?.render(width); } catch { /* A renderer failure must not hide the saved text. */ }
      return (lines?.length ? lines : plainLines(safe, width)).map(line => truncateToWidth(line, width, ""));
    },
  };
}
