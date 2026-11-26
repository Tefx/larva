import type { PersonaSpec } from "../core/types.ts";

export const LARVA_RESOLVE_SYSTEM_PROMPT_EVENT = "larva:resolve-system-prompt:v1";
export type SystemPromptSnapshot = { activePersona: Pick<PersonaSpec, "id" | "spec_digest" | "prompt"> | null };
export type ResolveSystemPromptResult =
  | { status: "ok"; systemPrompt: string }
  | { status: "unavailable"; reason: string };

type Block = "identity-policy" | "active-persona";
const marker = (block: Block, edge: "begin" | "end") => `<!-- larva:${block}:${edge} -->`;
const tokens = /<!-- larva:(identity-policy|active-persona):(begin|end) -->/g;
const opaqueHeader = /\n<!-- larva:opaque-body:(\d+) -->\n/y;

function managedBlock(block: Block, body: string): string {
  // Persona Markdown can contain literal examples of these very delimiters.
  const header = /<!-- larva:(?:(?:identity-policy|active-persona):|opaque-body:)/.test(body)
    ? `<!-- larva:opaque-body:${body.length} -->\n` : "";
  return `${marker(block, "begin")}\n${header}${body}\n${marker(block, "end")}`;
}

function stripManaged(base: string): string {
  const scan = new RegExp(tokens);
  const header = new RegExp(opaqueHeader);
  let start: RegExpExecArray | null = null;
  let cursor = 0;
  const foreign: string[] = [];
  const remove = (begin: number, end: number) => {
    // Remove the join separator, not arbitrary foreign whitespace. Older composers prefixed identity.
    if (begin >= cursor + 2 && base.startsWith("\n\n", begin - 2)) begin -= 2;
    else if (begin === cursor && foreign.length === 0 && base.startsWith("\n\n", end)) end += 2;
    if (begin > cursor) foreign.push(base.slice(cursor, begin));
    cursor = end;
  };
  for (let token = scan.exec(base); token; token = scan.exec(base)) {
    if (token[2] === "begin") {
      header.lastIndex = scan.lastIndex;
      const frame = header.exec(base);
      const length = Number(frame?.[1]);
      const end = header.lastIndex + length;
      const closing = `\n<!-- larva:${token[1]}:end -->`;
      if (frame && Number.isSafeInteger(length) && base.startsWith(closing, end)) {
        scan.lastIndex = end + closing.length;
        remove(token.index, scan.lastIndex);
        start = null;
      } else {
        start = token;
      }
    } else if (start && token[1] === start[1]) {
      remove(start.index, scan.lastIndex);
      start = null;
    }
  }
  foreign.push(base.slice(cursor));
  return foreign.join("");
}

/** All three Pi prompt surfaces compose against the current session snapshot. */
export function composeSystemPrompt({ activePersona }: SystemPromptSnapshot, basePrompt: string): string {
  let base = basePrompt;
  // Removing a block embedded in a delimiter can expose a newly adjacent delimiter.
  for (let stripped = stripManaged(base); stripped !== base; stripped = stripManaged(base)) base = stripped;
  if (activePersona === null) return base;
  return [
    ...(base ? [base] : []),
    managedBlock("identity-policy", "Active Larva persona is the primary identity. Pi's generic coding-assistant wording describes the runtime harness and tools only."),
    managedBlock("active-persona", `<!-- larva-spec: ${activePersona.id}@${activePersona.spec_digest} -->\n${activePersona.prompt}`),
  ].join("\n\n");
}
