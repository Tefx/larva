import { LarvaError } from "./errors.ts";

type Scalar = string | number | boolean | null;
type YamlMap = { [key: string]: YamlValue };
type YamlValue = Scalar | YamlValue[] | YamlMap;

function invalid(message: string): never {
  throw new LarvaError("LARVA_PERSONA_INVALID", `Invalid YAML frontmatter: ${message}`);
}

function checkDepth(depth: number): void {
  if (depth > 64) invalid("collections are nested too deeply");
}

const nonPrintable = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x84\x86-\x9f\ufffe\uffff]/u;
const horizontal = /^[ \t]*/;
const separation = /[ \t\n]/;
const flowPunctuation = /[\[\]{},]/;
const blockItem = /^-(?:[ \t]+|$)/;
const explicitKey = /^\?(?:[ \t]+|$)/;
const explicitValue = /^:(?:[ \t]+|$)/;
const blockPair = /^((?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*')[ \t]*|[^\[\]{},"'][\s\S]*?):(?=[ \t]|$)/;
const escapes: Readonly<Record<string, string>> = {
  '"': '"', "/": "/", "\\": "\\", " ": " ", "0": "\0", a: "\x07", b: "\b", t: "\t", "\t": "\t",
  n: "\n", v: "\v", f: "\f", r: "\r", e: "\x1b", N: "\x85", _: "\xa0", L: "\u2028", P: "\u2029",
};

function resolvePlain(text: string): Scalar {
  if (/^(?:~|null|Null|NULL)$/.test(text)) return null;
  if (/^(?:true|True|TRUE)$/.test(text)) return true;
  if (/^(?:false|False|FALSE)$/.test(text)) return false;
  if (/^[+-]?\.(?:inf|Inf|INF)$|^\.(?:nan|NaN|NAN)$/.test(text)) invalid("non-finite numbers are not supported");
  if (!/^(?:0x[\da-fA-F]+|0o[0-7]+|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)$/.test(text)) return text;
  const value = Number(text);
  if (!Number.isFinite(value)) invalid("non-finite numbers are not supported");
  return value;
}

function insert(map: Map<string, YamlValue>, key: YamlValue, value: YamlValue): void {
  if (typeof key !== "string") invalid("map keys must be strings");
  if (key === "<<") invalid("merge keys are not supported");
  if (map.has(key)) invalid("duplicate map key");
  map.set(key, value);
}

/** Reads flow collections and quoted/plain scalars directly from the shared header. */
class Inline {
  readonly source: string;
  readonly minIndent: number;
  pos: number;

  constructor(source: string, pos: number, minIndent = 0) {
    this.source = source;
    this.pos = pos;
    this.minIndent = minIndent;
  }

  get char(): string { return this.source[this.pos] ?? ""; }

  skipFlowSpace(): void {
    while (true) {
      if (this.char === "\n") {
        const next = this.lineAfter(this.pos);
        const char = this.source[next.content] ?? "";
        if (char && char !== "\n" && char !== "#"
          && next.indent < this.minIndent - (char === "]" || char === "}" ? 1 : 0)) {
          invalid("invalid flow collection indentation");
        }
        this.pos = next.content;
      } else if (separation.test(this.char)) this.pos++;
      else if (this.char === "#" && separation.test(this.source[this.pos - 1] ?? "")) {
        this.pos = this.source.indexOf("\n", this.pos);
      } else return;
    }
  }

  value(depth: number, flow: boolean): YamlValue {
    checkDepth(depth);
    if (this.char === "[" || this.char === "{") return this.collection(depth);
    if (this.char === '"' || this.char === "'") return this.quoted();
    return resolvePlain(this.plain(flow));
  }

  private collection(depth: number): YamlValue {
    const array = this.char === "[";
    const end = array ? "]" : "}";
    this.pos++;
    const items: YamlValue[] = [];
    const map = new Map<string, YamlValue>();
    this.skipFlowSpace();
    while (this.char !== end) {
      const next = this.source[this.pos + 1] ?? "";
      const explicit = this.char === "?" && (separation.test(next) || flowPunctuation.test(next));
      if (explicit) {
        this.pos++;
        this.skipFlowSpace();
      }
      const start = this.pos;
      const first = this.value(depth + 1, true);
      const endOfFirst = this.pos;
      this.skipFlowSpace();
      const hasValue = this.char === ":";
      let value: YamlValue = null;
      if (hasValue) {
        if (!explicit && this.source.indexOf("\n", start) < (array ? this.pos : endOfFirst)) {
          invalid("implicit map keys must be on one line");
        }
        this.pos++;
        this.skipFlowSpace();
        const next = this.source[this.pos];
        if (next !== end && next !== ",") value = this.value(depth + 1, true);
      }
      if (!array) insert(map, first, value);
      else if (explicit || hasValue) {
        const pair = new Map<string, YamlValue>();
        insert(pair, first, value);
        items.push(Object.fromEntries(pair));
      } else items.push(first);
      this.skipFlowSpace();
      if (this.char === end) break;
      if (this.char !== ",") invalid("expected a flow collection separator");
      this.pos++;
      this.skipFlowSpace();
    }
    this.pos++;
    return array ? items : Object.fromEntries(map);
  }

  private plain(flow: boolean): string {
    const start = this.pos;
    const next = this.source[start + 1] ?? "";
    if (!this.char || /[&*!|>%@`#,\[\]{}]/.test(this.char)
      || (/[?:-]/.test(this.char) && (!next || separation.test(next) || (flow && flowPunctuation.test(next))))) {
      invalid("expected a scalar or collection");
    }
    let text = "";
    let segmentStart = start;
    while (this.char) {
      if (this.char === "\n") {
        const { content, breaks, indent } = this.nonBlankAfter(this.pos);
        const next = this.source[content] ?? "";
        if (!next || next === "#" || indent < this.minIndent || (flow
          && (flowPunctuation.test(next) || (next === ":" && this.mappingSeparator(content, flow))))) break;
        text += this.source.slice(segmentStart, this.pos).replace(/[ \t]+$/, "") + this.fold(breaks);
        this.pos = segmentStart = content;
        continue;
      }
      if (this.char === "#" && separation.test(this.source[this.pos - 1] ?? "")) break;
      if (flow && flowPunctuation.test(this.char)) break;
      if (this.char === ":" && this.mappingSeparator(this.pos, flow)) {
        if (!flow) invalid("unexpected mapping separator in a plain scalar");
        break;
      }
      this.pos++;
    }
    return text + this.source.slice(segmentStart, this.pos).replace(/[ \t]+$/, "");
  }

  private mappingSeparator(colon: number, flow: boolean): boolean {
    const next = this.source[colon + 1] ?? "";
    return !next || separation.test(next) || (flow && flowPunctuation.test(next));
  }

  private quoted(): string {
    const quote = this.char;
    this.pos++;
    let text = "";
    let segmentStart = this.pos;
    while (this.char) {
      const c = this.char;
      if (c === quote) {
        this.pos++;
        if (quote !== "'" || this.char !== "'") return text + this.source.slice(segmentStart, this.pos - 1);
        text += this.source.slice(segmentStart, this.pos++);
        segmentStart = this.pos;
      } else if (c === "\n") {
        text += this.source.slice(segmentStart, this.pos).replace(/[ \t]+$/, "");
        text += this.foldBreak();
        segmentStart = this.pos;
      } else if (c === "\\" && quote === '"') {
        text += this.source.slice(segmentStart, this.pos++);
        const code = this.char;
        if (code === "\n") text += this.foldBreak(true);
        else {
          this.pos++;
          const digits = code === "x" ? 2 : code === "u" ? 4 : code === "U" ? 8 : 0;
          if (digits) {
            const hex = this.source.slice(this.pos, this.pos + digits);
            const point = Number.parseInt(hex, 16);
            if (hex.length !== digits || /[^0-9a-f]/i.test(hex) || point > 0x10ffff) invalid("invalid Unicode escape");
            text += String.fromCodePoint(point);
            this.pos += digits;
          } else if (Object.hasOwn(escapes, code)) text += escapes[code];
          else invalid("unknown quoted escape");
        }
        segmentStart = this.pos;
      } else this.pos++;
    }
    invalid("unterminated quoted string");
  }

  private lineAfter(newline: number): { content: number; indent: number } {
    let content = newline + 1;
    while (this.source[content] === " ") content++;
    const indent = content - newline - 1;
    while (this.source[content] === " " || this.source[content] === "\t") content++;
    return { content, indent };
  }

  private nonBlankAfter(newline: number): { content: number; indent: number; breaks: number } {
    let line = this.lineAfter(newline);
    let breaks = 1;
    while (this.source[line.content] === "\n") {
      line = this.lineAfter(line.content);
      breaks++;
    }
    return { ...line, breaks };
  }

  private fold(breaks: number, escaped = false): string {
    return breaks === 1 ? (escaped ? "" : " ") : "\n".repeat(breaks - 1);
  }

  private foldBreak(escaped = false): string {
    const { content, indent, breaks } = this.nonBlankAfter(this.pos);
    if (indent < this.minIndent) invalid("invalid quoted string indentation");
    this.pos = content;
    return this.fold(breaks, escaped);
  }
}

type Line = { text: string; indent: number; start: number };

/** Block indentation is separate from flow syntax; comments never enter the value tree. */
class Block {
  private row = 0;
  private readonly lines: Line[] = [];
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
    let start = 0;
    for (const text of source.split("\n").slice(0, -1)) {
      this.lines.push({ text, start, indent: text.length - text.replace(/^ */, "").length });
      start += text.length + 1;
    }
  }

  parse(): YamlMap {
    const line = this.peek();
    if (!line) invalid("expected a map");
    const value = this.node(line.indent, 0);
    if (this.peek()) invalid("unexpected content or indentation");
    if (typeof value !== "object" || value === null || Array.isArray(value)) invalid("expected a map");
    return value;
  }

  private peek(): Line | undefined {
    while (true) {
      const line = this.lines[this.row];
      if (!line) return undefined;
      if (/^[ \t]*(?:#|$)/.test(line.text)) this.row++;
      else if (line.text[line.indent] === "\t") invalid("tabs cannot be used for block indentation");
      else return line;
    }
  }

  private node(column: number, depth: number, parent = column - 1): YamlValue {
    checkDepth(depth);
    const line = this.lines[this.row];
    const content = line.text.slice(column);
    if (blockItem.test(content)) {
      const items: YamlValue[] = [];
      let current: Line | undefined = line;
      do {
        const dash = blockItem.exec(current.text.slice(column));
        if (!dash) break;
        items.push(this.entry(column + dash[0].length, column, depth + 1));
        current = this.peek();
      } while (current?.indent === column);
      return items;
    }
    if (explicitKey.test(content) || blockPair.test(content)) return this.map(column, depth);
    return this.entry(column, parent, depth);
  }

  private map(column: number, depth: number): YamlMap {
    checkDepth(depth);
    const map = new Map<string, YamlValue>();
    let current: Line | undefined = this.lines[this.row];
    do {
      const content = current.text.slice(column);
      const explicit = explicitKey.exec(content);
      if (explicit) {
        const name = this.entry(column + explicit[0].length, column, depth + 1);
        const next = this.peek();
        const value = next?.indent === column ? explicitValue.exec(next.text.slice(column)) : null;
        insert(map, name, value ? this.entry(column + value[0].length, column, depth + 1, "explicit-value") : null);
      } else {
        const pair = blockPair.exec(content);
        if (!pair) break;
        const key = new Inline(`${pair[1].replace(/[ \t]+$/, "")}\n`, 0);
        const name = key.value(depth + 1, false);
        if (key.char !== "\n") invalid("malformed map key");
        insert(map, name, this.entry(column + pair[0].length, column, depth + 1, "implicit-value"));
      }
      current = this.peek();
    } while (current?.indent === column);
    return Object.fromEntries(map);
  }

  private entry(column: number, parent: number, depth: number, mode: "node" | "implicit-value" | "explicit-value" = "node"): YamlValue {
    checkDepth(depth);
    const line = this.lines[this.row];
    const rest = line.text.slice(column);
    const start = column + horizontal.exec(rest)![0].length;
    const content = line.text.slice(start);
    if (!content || content.startsWith("#")) {
      this.row++;
      const next = this.peek();
      if (next && (next.indent > parent || (mode !== "node" && next.indent === parent
        && blockItem.test(next.text.slice(parent))))) return this.node(next.indent, depth, parent);
      return null;
    }
    if (content.startsWith("|") || content.startsWith(">")) return this.blockScalar(content, parent);
    if (blockItem.test(content)) {
      if (mode === "implicit-value") invalid("block sequences cannot start on an implicit key's line");
      return this.node(start, depth);
    }
    if (mode !== "implicit-value" && (explicitKey.test(content) || blockPair.test(content))) return this.map(start, depth);
    const value = new Inline(this.source, line.start + start, parent + 1);
    const result = value.value(depth, false);
    while (this.lines[this.row + 1]?.start <= value.pos) this.row++;
    const tail = this.source.slice(value.pos, this.lines[this.row].start + this.lines[this.row].text.length);
    if (!/^(?:[ \t]+(?:#.*)?|#.*)?$/.test(tail)
      || (tail.startsWith("#") && !separation.test(this.source[value.pos - 1]))) invalid("unexpected text after value");
    this.row++;
    return result;
  }

  private blockScalar(header: string, parent: number): string {
    const match = /^([|>])([1-9][+-]?|[+-][1-9]?)?(?:[ \t]+(?:#.*)?)?$/.exec(header);
    if (!match) invalid("malformed block scalar header");
    const modifiers = match[2] ?? "";
    const indicated = /[1-9]/.exec(modifiers);
    this.row++;
    let first = this.row;
    while (/^ *$/.test(this.lines[first]?.text ?? "x")) first++;
    const firstLine = this.lines[first];
    const indent = indicated ? parent + Number(indicated[0]) : Math.max(parent + 1, firstLine?.indent ?? 0);
    if (!indicated && firstLine && firstLine.indent > parent) {
      for (let row = this.row; row < first; row++) {
        if (this.lines[row].indent > indent) invalid("leading blank line is too indented for the block scalar");
      }
    }
    const lines: string[] = [];
    while (this.row < this.lines.length) {
      const line = this.lines[this.row];
      if (line.indent < indent && line.text.trimEnd() !== "") break;
      lines.push(line.text.slice(indent));
      this.row++;
    }
    let text = "";
    let previous: string | undefined;
    let breaks = 0;
    for (const line of lines) {
      if (line) {
        if (match[1] === ">" && previous && !/^[ \t]/.test(previous) && !/^[ \t]/.test(line)) {
          text += breaks === 1 ? " " : "\n".repeat(breaks - 1);
        } else text += "\n".repeat(breaks);
        text += line;
        previous = line;
        breaks = 0;
      }
      breaks++;
    }
    if (modifiers.includes("+")) return text + "\n".repeat(breaks);
    return !modifiers.includes("-") && previous !== undefined ? `${text}\n` : text;
  }
}

export function parseYamlFrontmatter(text: string): { fields: YamlMap; body: string } {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---\n")) invalid("expected an opening '---' line");
  const closing = /\n---(?:\n|$)/g;
  closing.lastIndex = 3;
  const match = closing.exec(normalized);
  if (!match) invalid("expected a closing '---' line");
  const header = normalized.slice(4, match.index + 1);
  if (nonPrintable.test(header)) invalid("unexpected control character");
  return { fields: new Block(header).parse(), body: normalized.slice(closing.lastIndex) };
}

export function serializeYamlFrontmatter(fields: YamlMap, body: string): string {
  // JSON flow style quotes every string, preserving strings that resemble YAML syntax.
  const header = JSON.stringify(fields).replace(new RegExp(nonPrintable.source, "gu"), c =>
    `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `---\n${header}\n---\n${body}\n`;
}
