import { basename, extname } from "node:path";
import { canonicalizePersona } from "./digest.ts";
import { LarvaError } from "./errors.ts";
import type { PersonaInputFormat, PersonaSpec, PersonaSummary, ThinkingLevel } from "./types.ts";
import { parseYamlFrontmatter, serializeYamlFrontmatter } from "./yaml-frontmatter.ts";

export { computePersonaDigest } from "./digest.ts";

const thinkingLevels: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const markdownFields = ["id", "description", "model", "thinking", "can_spawn", "tools"];
const jsonFields = [...markdownFields, "prompt", "spec_digest"];
const modelRoute = /^[^\s/]+\/[^\s]+$/;
const toolPattern = /^[^\s*]+\*?$/;

function invalid(message: string): never {
  throw new LarvaError("LARVA_PERSONA_INVALID", message);
}

export function isValidPersonaId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function closedObject(value: unknown, label: string, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object.`);
  const fields: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!allowed.includes(key)) invalid(`Unexpected ${label} field: ${JSON.stringify(key)}.`);
    fields[key] = item;
  }
  return fields;
}

function normalizeText(value: unknown, field: "description" | "prompt"): string {
  if (typeof value !== "string") invalid(`${field} must be a non-empty string.`);
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (!normalized) invalid(`${field} must be a non-empty string.`);
  return normalized;
}

function uniqueStrings(value: unknown, field: string, matches: (entry: string) => boolean): string[] {
  if (!Array.isArray(value)) invalid(`${field} must be an array.`);
  const entries = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || !matches(entry)) invalid(`${field} contains an invalid entry.`);
    if (entries.has(entry)) invalid(`${field} contains a duplicate entry.`);
    entries.add(entry);
  }
  return [...entries];
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    invalid("Invalid JSON persona input.");
  }
}

function parse(text: string, format: PersonaInputFormat, stem?: string): PersonaSpec {
  const md = format === "md" ? parseYamlFrontmatter(text) : undefined;
  const fields = md
    ? closedObject(md.fields, "frontmatter", markdownFields)
    : closedObject(parseJson(text), "persona", jsonFields);
  const { description, model, thinking, can_spawn, tools, spec_digest } = fields;
  const id = md && !Object.hasOwn(fields, "id") ? stem : fields.id;
  if (!isValidPersonaId(id)) invalid("id must be a lowercase kebab-case identifier.");
  if (stem !== undefined && id !== stem) invalid("Persona id must match the filename stem.");
  if (typeof model !== "string" || !modelRoute.test(model)) invalid("model must be a whitespace-free provider/model_id route.");
  const level = thinking === undefined ? undefined : thinkingLevels.find(candidate => candidate === thinking);
  if (thinking !== undefined && level === undefined) invalid("Invalid thinking level.");

  let spawn: PersonaSpec["can_spawn"] | undefined;
  if (can_spawn === undefined || typeof can_spawn === "boolean") spawn = can_spawn;
  else {
    if (!Array.isArray(can_spawn) || can_spawn.length < 1 || can_spawn.length > 100) {
      invalid("can_spawn must be a boolean or an array of 1 to 100 persona IDs.");
    }
    spawn = uniqueStrings(can_spawn, "can_spawn", isValidPersonaId);
  }

  const policy = tools === undefined ? undefined : closedObject(tools, "tools", ["allow", "deny"]);
  const patterns = (key: "allow" | "deny") => policy && Object.hasOwn(policy, key)
    ? uniqueStrings(policy[key], `tools.${key}`, entry => toolPattern.test(entry))
    : undefined;
  const spec = canonicalizePersona({
    id, model, thinking: level, can_spawn: spawn,
    description: normalizeText(description, "description"),
    prompt: normalizeText(md ? md.body : fields.prompt, "prompt"),
    tools: { allow: patterns("allow"), deny: patterns("deny") },
  });
  if (Object.hasOwn(fields, "spec_digest") && spec_digest !== spec.spec_digest) {
    invalid("spec_digest does not match the computed persona digest.");
  }
  return spec;
}

/** Parses supplied file contents without filesystem access; the path binds format and id. */
export function parsePersonaFile(text: string, filePath: string): PersonaSpec {
  const extension = extname(filePath);
  if (extension !== ".md" && extension !== ".json") invalid("Expected a .md or .json persona filename.");
  const stem = basename(filePath, extension);
  if (!isValidPersonaId(stem)) invalid("Persona filename stem must be a lowercase kebab-case identifier.");
  return parse(text, extension === ".md" ? "md" : "json", stem);
}

/** A source of '-' denotes stdin, where an explicit id is required in either format. */
export function parsePersonaInput(text: string, source = "-"): PersonaSpec {
  if (source !== "-") return parsePersonaFile(text, source);
  return parse(text, text.trimStart().startsWith("{") ? "json" : "md");
}

export function serializePersonaMarkdown(spec: PersonaSpec): string {
  const { id, description, model, thinking, can_spawn, tools, prompt } = spec;
  return serializeYamlFrontmatter({ id, description, model, thinking, can_spawn, tools }, prompt);
}

export function serializePersonaJson(spec: PersonaSpec): string {
  return `${JSON.stringify(spec, null, 2)}\n`;
}

export function toPersonaSummary(spec: PersonaSpec): PersonaSummary {
  const { id, description, model, thinking, can_spawn, spec_digest } = spec;
  return { id, description, model, thinking, can_spawn, spec_digest };
}
