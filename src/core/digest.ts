import { createHash } from "node:crypto";
import type { PersonaSpec, ToolPolicy } from "./types.ts";

type PersonaFields = Pick<PersonaSpec, "id" | "description" | "prompt" | "model">
  & Partial<Pick<PersonaSpec, "thinking" | "can_spawn">>
  & { tools?: Partial<ToolPolicy> };

/** The caller validates fields and normalizes text before canonicalization. */
export function canonicalizePersona(fields: PersonaFields): PersonaSpec {
  const { id, description, prompt, model, thinking = "medium", can_spawn = false, tools } = fields;
  // Insert keys in lexical order, including the only nested object, for compact JSON hashing.
  const canonical = {
    can_spawn: Array.isArray(can_spawn) ? [...can_spawn].sort() : can_spawn,
    description,
    id,
    model,
    prompt,
    thinking,
    tools: { allow: [...(tools?.allow ?? [])].sort(), deny: [...(tools?.deny ?? [])].sort() },
  };
  const hex = createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
  return { ...canonical, spec_digest: `sha256:${hex}` };
}

export function computePersonaDigest(fields: PersonaFields): string {
  return canonicalizePersona(fields).spec_digest;
}
