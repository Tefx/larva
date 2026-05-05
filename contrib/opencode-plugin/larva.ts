/**
 * larva-opencode-plugin
 *
 * Bridges larva PersonaSpec registry → opencode agent system.
 *
 * Runtime hardening rules:
 *   - startup projection only creates OpenCode agent entries with unique
 *     `[larva:<id>]` placeholders keyed by Larva base persona ids; Larva's
 *     current active registry variant supplies startup metadata for that base id
 *   - added/deleted base ids and model/provider startup fields require an
 *     OpenCode restart because OpenCode agent registration happens at startup
 *   - each model request resolves the selected placeholder id with
 *     `larva resolve <id> --json`; cache is last-known-good fallback only
 *   - system.transform replaces only the selected `[larva:<id>]` placeholder
 *   - stale last-known-good prompts may be used only when a previous good
 *     prompt exists; missing previous data fails closed
 *
 * Install in opencode.jsonc:
 *   { "plugin": ["file:///absolute/path/to/larva/contrib/opencode-plugin/larva.ts"] }
 *
 * Env:
 *   LARVA_CMD — larva CLI command (default: "larva")
 *   LARVA_OPENCODE_DEBUG=1 — emit runtime hardening warnings
 *   LARVA_OPENCODE_CACHE_TTL_MS=0 — disable performance cache
 */

import type { Plugin } from "@opencode-ai/plugin";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const CACHE_TTL_ENV = "LARVA_OPENCODE_CACHE_TTL_MS";
const DEBUG_ENV = "LARVA_OPENCODE_DEBUG";
const HOT_UPDATE_FIELDS = [
  "prompt",
  "temperature",
  "tool-policy",
  "capabilities",
  "can_spawn",
] as const;

// Set as agent.prompt during config so opencode uses it instead of falling
// back to the generic provider prompt (llm.ts:72 checks agent.prompt truthy).
// Replaced with real prompt via system.transform hook at runtime.
function placeholder(id: string) {
  return `[larva:${id}]`;
}

function debugEnabled(): boolean {
  return process.env[DEBUG_ENV] === "1";
}

function warn(message: string, details?: unknown): void {
  if (!debugEnabled()) return;
  if (details === undefined) {
    console.warn(`[larva-plugin] ${message}`);
  } else {
    console.warn(`[larva-plugin] ${message}`, details);
  }
}

function cacheTtlMs(): number {
  const raw = process.env[CACHE_TTL_ENV];
  if (raw === undefined || raw === "") return DEFAULT_CACHE_TTL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    warn(`invalid ${CACHE_TTL_ENV}; using default`, raw);
    return DEFAULT_CACHE_TTL_MS;
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PersonaSpec {
  id: string;
  description?: string;
  prompt?: string;
  model?: string;
  model_params?: Record<string, number>;
  spec_digest?: string;
  /** Canonical capability intent. */
  capabilities?: Record<string, string>;
  can_spawn?: boolean | string[];
}

interface CacheEntry {
  prompt: string;
  temperature?: number;
  spec_digest?: string;
  permissions?: Record<string, string>;
  ts: number;
}

interface ResolveOutcome {
  entry: CacheEntry | null;
  stale: boolean;
  digestChanged: boolean;
  lastKnownGood: boolean;
}

// ---------------------------------------------------------------------------
// larva CLI helpers
// ---------------------------------------------------------------------------

let _projectDir: string | undefined;

async function larvaExec($: any, args: string[]): Promise<string> {
  if (_projectDir) {
    const r = await $`uv run --project ${_projectDir} larva ${args}`.quiet();
    return r.stdout.toString();
  }
  try {
    const r = await $`larva ${args}`.quiet();
    return r.stdout.toString();
  } catch {
    const r = await $`uvx larva ${args}`.quiet();
    return r.stdout.toString();
  }
}

async function larvaExportInitial($: any): Promise<PersonaSpec[] | null> {
  try {
    const args = ["export", "--" + "all", "--json"];
    const r = await larvaExec($, args);
    const parsed = JSON.parse(r);
    return parsed.data ?? null;
  } catch (e: any) {
    warn("startup persona projection failed", e?.message ?? e);
    return null;
  }
}

async function resolvePersona($: any, id: string): Promise<PersonaSpec | null> {
  try {
    const r = await larvaExec($, ["resolve", id, "--json"]);
    const parsed = JSON.parse(r);
    return parsed.data ?? parsed;
  } catch (e: any) {
    warn(`resolve failed for ${id}`, e?.message ?? e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Prompt cache — performance-only, never authoritative
// ---------------------------------------------------------------------------

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<ResolveOutcome>>();
let selectedPermissions = new Map<string, Record<string, string>>();
const selectedIdsBySession = new Map<string, string>();
let fallbackSelectedId: string | null = null;

function inputSessionId(input: any): string | null {
  const sessionID = input?.sessionID ?? input?.session_id;
  return typeof sessionID === "string" && sessionID.length > 0 ? sessionID : null;
}

function rememberSelectedId(input: any, id: string | null): void {
  const sessionID = inputSessionId(input);
  if (sessionID) {
    if (id) selectedIdsBySession.set(sessionID, id);
    else selectedIdsBySession.delete(sessionID);
    return;
  }
  fallbackSelectedId = id;
}

function selectedIdForToolCall(input: any): string | null {
  const sessionID = inputSessionId(input);
  if (sessionID) return selectedIdsBySession.get(sessionID) ?? null;
  return fallbackSelectedId;
}

function failClosed(id: string): string {
  return `[larva prompt unavailable for ${id}; request blocked because no previous prompt is available]`;
}

function entryFromSpec(spec: PersonaSpec): CacheEntry | null {
  if (!spec.prompt) return null;
  return {
    prompt: spec.prompt,
    temperature: spec.model_params?.temperature,
    spec_digest: spec.spec_digest,
    permissions: toPermissions(spec),
    ts: Date.now(),
  };
}

function setCache(id: string, spec: PersonaSpec): CacheEntry | null {
  const entry = entryFromSpec(spec);
  if (!entry) return null;
  if (cacheTtlMs() !== 0) cache.set(id, entry);
  selectedPermissions.set(id, entry.permissions ?? {});
  return entry;
}

async function refreshPersona($: any, id: string, previous: CacheEntry | null): Promise<ResolveOutcome> {
  const spec = await resolvePersona($, id);
  if (!spec) {
    if (previous) {
      warn(`using stale lastKnownGood prompt for ${id}`);
      return { entry: previous, stale: true, digestChanged: false, lastKnownGood: true };
    }
    warn(`failClosed: no prompt available for ${id}`);
    return { entry: null, stale: false, digestChanged: false, lastKnownGood: false };
  }

  const next = setCache(id, spec);
  if (!next) {
    if (previous) {
      warn(`using stale lastKnownGood prompt for ${id}: resolved spec has no prompt`);
      return { entry: previous, stale: true, digestChanged: false, lastKnownGood: true };
    }
    warn(`failClosed: resolved spec for ${id} has no prompt`);
    return { entry: null, stale: false, digestChanged: false, lastKnownGood: false };
  }

  const digestChanged = Boolean(
    previous?.spec_digest && next.spec_digest && previous.spec_digest !== next.spec_digest,
  );
  if (digestChanged) warn(`spec_digest changed for ${id}`);
  return { entry: next, stale: false, digestChanged, lastKnownGood: false };
}

async function getPersonaForRequest($: any, id: string): Promise<ResolveOutcome> {
  const previous = cache.get(id) ?? null;

  const existing = inFlight.get(id);
  if (existing) return existing;

  const promise = refreshPersona($, id, previous).finally(() => {
    inFlight.delete(id);
  });
  inFlight.set(id, promise);
  return promise;
}

function selectedPlaceholder(system: string): { id: string; token: string } | null {
  const match = system.match(/\[larva:([^\]\s]+)\]/);
  if (!match) return null;
  return { id: match[1], token: match[0] };
}

// ---------------------------------------------------------------------------
// Permission mapping: larva capabilities + can_spawn → opencode rules
// ---------------------------------------------------------------------------

function toPermissions(spec: PersonaSpec): Record<string, string> | undefined {
  const perms: Record<string, string> = {};

  if (spec.capabilities && Object.keys(spec.capabilities).length > 0) {
    const postures = Object.values(spec.capabilities);
    const allReadOnly = postures.every(
      (p) => p === "none" || p === "read_only",
    );
    if (allReadOnly) {
      perms.edit = "deny";
      perms.bash = "deny";
    }
  }

  if (spec.can_spawn === false) perms.task = "deny";
  return Object.keys(perms).length > 0 ? perms : undefined;
}

// ---------------------------------------------------------------------------
// Tool policy: runtime deny/allow rules from tool-policy.json
// ---------------------------------------------------------------------------

interface ToolPolicyEntry {
  deny?: string[];
  allow?: string[];
}

type ToolPolicy = Record<string, ToolPolicyEntry>;

let _toolPolicy: ToolPolicy = {};

async function loadToolPolicy($: any, directory: string): Promise<void> {
  const candidates = [
    `${directory}/.opencode/tool-policy.json`,
    `${process.env.HOME}/.config/opencode/tool-policy.json`,
  ];
  for (const path of candidates) {
    try {
      const r = await $`cat ${path}`.quiet();
      _toolPolicy = parseToolPolicy(r.stdout.toString());
      return;
    } catch {
      /* try next path */
    }
  }
  _toolPolicy = {};
}

function parseToolPolicy(text: string): ToolPolicy {
  const doc = JSON.parse(text) as {
    agents?: Record<string, { deny?: string[]; allow?: string[] }>;
  } | null;
  if (!doc?.agents) return {};

  const policy: ToolPolicy = {};
  for (const [agent, entry] of Object.entries(doc.agents)) {
    policy[agent] = {
      ...(entry.deny ? { deny: entry.deny } : {}),
      ...(entry.allow ? { allow: entry.allow } : {}),
    };
  }
  return policy;
}

function applyToolPolicy(agentId: string, perms: Record<string, string>): Record<string, string> {
  const entry = _toolPolicy[agentId];
  if (!entry) return perms;
  for (const tool of entry.deny ?? []) perms[tool] = "deny";
  for (const tool of entry.allow ?? []) perms[tool] = "allow";
  return perms;
}

function wildcardMatch(value: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return value === pattern;
  const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
  return regex.test(value);
}

function toolDenyReason(agentId: string, toolName: string): string | null {
  const basePerms = { ...(selectedPermissions.get(agentId) ?? {}) };
  const perms = applyToolPolicy(agentId, { ...basePerms });
  if (perms[toolName] === "deny") {
    return basePerms[toolName] === "deny" ? "larva permissions" : "tool-policy.json";
  }
  const entry = _toolPolicy[agentId];
  if (!entry?.deny) return null;
  return entry.deny.some((pattern) => wildcardMatch(toolName, pattern))
    ? "tool-policy.json"
    : null;
}

function shortDigest(entry: CacheEntry): string {
  const digest = entry.spec_digest ?? "unknown";
  return digest.startsWith("sha256:") ? digest.slice("sha256:".length, "sha256:".length + 6) : digest.slice(0, 6);
}

function watermark(id: string, entry: CacheEntry, stale: boolean): string {
  return [
    `<!-- larva-spec: ${id}@${shortDigest(entry)}${stale ? " stale" : ""} -->`,
    `<larva-persona id="${id}" />`,
    `When asked "who are you" or "what persona", mention that you are the "${id}" persona loaded from larva.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const managed = new Set<string>();

const larvaPlugin: Plugin = async ({ $, directory }) => {
  try {
    const pyproject = await $`cat ${directory}/pyproject.toml`.quiet();
    if (pyproject.stdout.toString().includes('name = "larva"')) {
      _projectDir = directory;
    }
  } catch {
    /* not a larva project — will use bare `larva` from PATH */
  }

  return {
    config: async (config: any) => {
      await loadToolPolicy($, directory);

      const specs = await larvaExportInitial($);
      if (!specs || !specs.length) return;
      config.agent ??= {};

      for (const spec of specs) {
        managed.add(spec.id);
        const perms = toPermissions(spec) ?? {};
        const finalPerms = applyToolPolicy(spec.id, perms);
        selectedPermissions.set(spec.id, finalPerms);

        config.agent[spec.id] = {
          description: spec.description ? `[larva] ${spec.description}` : `[larva] ${spec.id}`,
          mode: "all" as const,
          prompt: placeholder(spec.id),
          ...(spec.model ? { model: spec.model } : {}),
          ...(Object.keys(finalPerms).length ? { permission: finalPerms } : {}),
        };

        setCache(spec.id, spec);
      }
    },

    "chat.params": async (input: any, output: any) => {
      await loadToolPolicy($, directory);
      const name = typeof input.agent === "string" ? input.agent : (input.agent as any)?.name;
      if (!name || !managed.has(name)) {
        rememberSelectedId(input, null);
        return;
      }
      rememberSelectedId(input, name);

      const resolved = await getPersonaForRequest($, name);
      if (resolved.entry?.temperature !== undefined) {
        output.temperature = resolved.entry.temperature;
      }
    },

    "experimental.chat.system.transform": async (input: any, output: any) => {
      if (!output.system.length) return;
      const sys = output.system[0] ?? "";
      const selected = selectedPlaceholder(sys);
      if (!selected) return;

      rememberSelectedId(input, selected.id);
      const resolved = await getPersonaForRequest($, selected.id);
      const replacement = resolved.entry
        ? `${resolved.entry.prompt}\n\n${watermark(selected.id, resolved.entry, resolved.stale)}`
        : failClosed(selected.id);
      output.system[0] = sys.replace(selected.token, replacement);
    },

    "tool.execute.before": async (input: any, _output: any) => {
      await loadToolPolicy($, directory);
      const agentId = selectedIdForToolCall(input);
      if (!agentId) return;
      const denyReason = toolDenyReason(agentId, input.tool);
      if (denyReason) {
        throw new Error(
          `[larva] Tool "${input.tool}" is denied for agent "${agentId}" by ${denyReason}`,
        );
      }
    },
  };
};

export default larvaPlugin;
