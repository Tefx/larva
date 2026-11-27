import { isValidPersonaId } from "../core/predicates.ts";
import type { SearchMentionsToolInput, SearchMentionsToolOutput } from "../core/types.ts";
import type { PersonaStore } from "../store/persona-store.ts";

export const CODEX_PERSONA_URI_TEMPLATE = "larva://personas/{persona_id}";

export function personaResourceUri(id: string): string {
  return `larva://personas/${encodeURIComponent(id)}`;
}

export function parsePersonaResourceUri(uri: string): string | undefined {
  const prefix = "larva://personas/";
  const id = uri.startsWith(prefix) ? uri.slice(prefix.length) : undefined;
  return isValidPersonaId(id) ? id : undefined;
}

export async function buildSearchMentionsOutput(
  personas: PersonaStore, input: SearchMentionsToolInput,
): Promise<SearchMentionsToolOutput> {
  const text = input.query.trim().toLowerCase();
  const query = /^@(?:larva(?: subagents)?|persona)$/.test(text) ? "" : text.replace(/^(?:@?(?:larva|persona):|@)/, "");
  const items = (await personas.list({ query, limit: input.preload ? 200 : 30 })).map(persona => {
    const title = `@larva:${persona.id}`;
    return {
      type: "resource_link" as const,
      uri: personaResourceUri(persona.id),
      name: persona.id,
      title,
      searchTerms: [persona.id, title, persona.description, persona.model],
      description: persona.description,
      mimeType: "text/markdown" as const,
    };
  });
  return { items };
}

// Embedded so the MCP bundle works without locating a skill file at runtime.
// The Codex UI/packaging test checks byte-for-byte equality with SKILL.md.
export const CODEX_INITIALIZE_INSTRUCTIONS = `---
name: larva-subagent
description: Discover Larva personas and delegate self-contained work to Pi child sessions through MCP.
---

# Larva subagent routing

- An exact \`@larva:<persona_id>\`, \`@persona:<persona_id>\`, or \`larva://personas/<persona_id>\` resource (including a composer link with that title) delegates directly to \`larva_subagent\` with the supplied \`persona_id\`. Do not call \`larva_personas\` first.
- A generic \`@larva\` or \`@Larva Subagents\` mention without a persona ID calls \`larva_personas\` first. Select a returned ID; do not invent one.
- For ordinary work without a Larva or Persona request, use Codex's native tools. Do not mix Larva \`task_id\` handles with Codex agent IDs.

## Choose the workspace

For a fresh spawn, omit \`cwd\` only when the host supports \`roots/list\` and returns exactly one root (\`roots.length === 1\`) whose URI is a local \`file://\` directory that exists. For zero roots, multiple roots (even if only one exists), an unusable root, or unsupported \`roots/list\`, pass an explicitly authorized absolute \`cwd\`; ask the user if it is ambiguous. For resume, use the exact returned \`task_id\` and omit \`cwd\` so Larva uses the recorded workspace.

## Delegate and observe

Give \`larva_subagent\` the exact \`persona_id\`, a self-contained task, scope, and completion checks. Use \`wait_for_completion: true\` to receive one run's terminal output directly, or \`wait_for_completion: false\` to receive an accepted receipt before waiting. Keep exact \`.jsonl\` handles and retain responsibility for integrating results. Reconcile any uncertain effects before a user-authorized resume.

Use \`larva_subagent_wait\` with \`return_when: "any"\` and a bounded \`timeout_ms\` to collect ready runs. A timed-out checkpoint is not completion; inspect ready runs and their terminal outputs. Use unified \`larva_subagent_status\` with an exact \`task_id\` or an \`active\`, \`recent\`, or \`disk\` scope. Use \`larva_subagent_activity\` with \`task_id\` to inspect recorded tool activity, not to infer live state. To cancel, use \`larva_subagent_cancel\` with \`task_ids\` and \`reason\`; inspect each outcome rather than assuming cleanup succeeded.

For example, using an exact handle returned by \`larva_subagent\`:

\`\`\`json
[
  {"name":"larva_subagent_wait","arguments":{"task_ids":["/example/sessions/child.jsonl"],"return_when":"any","timeout_ms":60000}},
  {"name":"larva_subagent_status","arguments":{"task_id":"/example/sessions/child.jsonl"}},
  {"name":"larva_subagent_activity","arguments":{"task_id":"/example/sessions/child.jsonl"}},
  {"name":"larva_subagent_cancel","arguments":{"task_ids":["/example/sessions/child.jsonl"],"reason":"The user requested cancellation."}}
]
\`\`\`
`;
