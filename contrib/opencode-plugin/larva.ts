/**
 * larva-opencode-plugin
 *
 * Bridges larva PersonaSpec registry → opencode agent system.
 *
 * Startup (config hook):
 *   - `larva export --all --json` → get all persona specs in one call
 *   - Register as opencode agents with permissions mapped
 *   - Pre-cache prompts (avoids CLI call on first message)
 *
 * Runtime (chat.params + system.transform):
 *   - chat.params: identify active larva agent, apply model_params
 *   - system.transform: replace placeholder prompt with full larva prompt
 *   - Re-resolves from larva CLI only on cache expiry (5 min)
 *
 * Install in opencode.jsonc:
 *   { "plugin": ["file:///absolute/path/to/larva/contrib/opencode-plugin/larva.ts"] }
 *
 * Env:
 *   LARVA_CMD — larva CLI command (default: "larva")
 */

import type { Plugin } from "@opencode-ai/plugin";
// no external dependencies needed — tool-policy uses JSON

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * How to invoke larva CLI. Resolution order:
 *   1. Auto-detect: if cwd contains pyproject.toml with name = "larva",
 *      use `uv run --project <cwd> larva`
 *   2. Fallback: try bare `larva` in PATH (pip install larva)
 */
const CACHE_TTL_MS = 5 * 60_000;

// Set as agent.prompt during config so opencode uses it instead of falling
// back to the generic provider prompt (llm.ts:72 checks agent.prompt truthy).
// Replaced with real prompt via system.transform hook at runtime.
/** Each agent gets a unique placeholder containing its id. */
function placeholder(id: string) {
  return `[larva:${id}]`;
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
  /** Canonical capability intent. Preferred over deprecated `tools`. */
  capabilities?: Record<string, string>;
  /** @deprecated Use `capabilities` instead. Retained for transition compatibility. */
  tools?: Record<string, string>;
  can_spawn?: boolean | string[];
  /** @deprecated Runtime policy (approval gating) moved out of PersonaSpec per ADR-002. */
  side_effect_policy?: string;
}

interface CacheEntry {
  prompt: string;
  temperature?: number;
  ts: number;
}

// ---------------------------------------------------------------------------
// larva CLI helpers
// ---------------------------------------------------------------------------

// Set at plugin init if cwd is a larva project
let _projectDir: string | undefined;

async function larvaExec($: any, args: string[]): Promise<string> {
  if (_projectDir) {
    const r = await $`uv run --project ${_projectDir} larva ${args}`.quiet();
    return r.stdout.toString();
  }
  // Try larva in PATH, fallback to uvx
  try {
    const r = await $`larva ${args}`.quiet();
    return r.stdout.toString();
  } catch {
    const r = await $`uvx larva ${args}`.quiet();
    return r.stdout.toString();
  }
}

async function larvaExportAll($: any): Promise<PersonaSpec[] | null> {
  try {
    const r = await larvaExec($, ["export", "--all", "--json"]);
    const parsed = JSON.parse(r);
    // debug: console.log(`[larva-plugin] export --all: ${parsed.data?.length ?? 0} personas`)
    return parsed.data ?? null;
  } catch (e: any) {
    // debug: console.error(`[larva-plugin] export --all failed:`, e?.message ?? e)
    return null;
  }
}

// ---------------------------------------------------------------------------
// Prompt cache — avoids repeated CLI calls within a session
// ---------------------------------------------------------------------------

const cache = new Map<string, CacheEntry>();

function getCached(id: string): CacheEntry | null {
  const entry = cache.get(id);
  if (!entry || Date.now() - entry.ts > CACHE_TTL_MS) return null;
  return entry;
}

function setCache(id: string, spec: PersonaSpec) {
  if (!spec.prompt) return;
  cache.set(id, {
    prompt: spec.prompt,
    temperature: spec.model_params?.temperature,
    ts: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Permission mapping: larva capabilities/side_effect_policy + can_spawn → opencode rules
// ---------------------------------------------------------------------------

/**
 * Derive opencode permissions from larva capabilities (ADR-002).
 *
 * ADR-002 Migration:
 * - `side_effect_policy` is DEPRECATED; runtime policy should come from separate source.
 * - `capabilities` is canonical and expresses capability intent via postures:
 *   - "none" / "read_only" → read-only operations
 *   - "read_write" / "destructive" → potentially mutating operations
 *
 * Permission derivation strategy:
 * - If ALL capabilities are "none" or "read_only" → read-only (edit: deny, bash: deny)
 * - If ANY capability is "read_write" or "destructive" → no additional restrictions
 *   (runtime policy for approval gating should be injected externally)
 * - If `capabilities` absent → fall back to deprecated `side_effect_policy` for compat
 *
 * TODO: Runtime approval policy (ask/allow) should be provided by external source,
 * not derived from persona. This function provides minimal deny-only derivation.
 *
 * opencode expects { [permission_name]: "allow" | "deny" | "ask" }
 */
function toPermissions(spec: PersonaSpec): Record<string, string> | undefined {
  const perms: Record<string, string> = {};

  // ADR-002: Prefer capabilities over deprecated side_effect_policy
  if (spec.capabilities && Object.keys(spec.capabilities).length > 0) {
    const postures = Object.values(spec.capabilities);
    const allReadOnly = postures.every(
      (p) => p === "none" || p === "read_only",
    );

    if (allReadOnly) {
      // All capabilities are read-only → restrict write operations
      perms.edit = "deny";
      perms.bash = "deny";
    }
    // If any capability allows mutation, no permission restrictions from capabilities.
    // Runtime approval policy (ask/allow) should come from external source.
  } else if (spec.side_effect_policy) {
    // Fall back to deprecated side_effect_policy for backward compatibility
    switch (spec.side_effect_policy) {
      case "read_only":
        perms.edit = "deny";
        perms.bash = "deny";
        break;
      case "approval_required":
        perms.edit = "ask";
        perms.bash = "ask";
        break;
      // "allow" → no restrictions
    }
  }

  if (spec.can_spawn === false) {
    perms.task = "deny";
  }

  return Object.keys(perms).length > 0 ? perms : undefined;
}

// ---------------------------------------------------------------------------
// Tool policy: runtime deny/allow rules from tool-policy.json
// ---------------------------------------------------------------------------

/**
 * Tool policy file (optional). Searched in order:
 *   1. .opencode/tool-policy.json  (project-level)
 *   2. ~/.config/opencode/tool-policy.json  (global)
 *
 * Format:
 *   agents:
 *     python-senior:
 *       deny: [vectl_vectl_claim, vectl_vectl_mutate]
 *     vectl-orchestrator:
 *       deny: [serena_*, playwright_*, invar_*]
 *       allow: [vectl_*, task]
 *     wiring-auditor:
 *       deny: [write, edit]
 */
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
      const text = r.stdout.toString();
      // Simple YAML parser for our flat structure
      _toolPolicy = parseToolPolicy(text);
      return;
    } catch {
      /* file not found, try next */
    }
  }
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

function applyToolPolicy(
  agentId: string,
  perms: Record<string, string>,
): Record<string, string> {
  const entry = _toolPolicy[agentId];
  if (!entry) return perms;

  for (const tool of entry.deny ?? []) {
    perms[tool] = "deny";
  }
  for (const tool of entry.allow ?? []) {
    perms[tool] = "allow";
  }
  return perms;
}

/** Simple wildcard match: "serena_*" matches "serena_find_symbol" */
function wildcardMatch(value: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return value === pattern;
  const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
  return regex.test(value);
}

/** Check if a tool is denied for a given agent */
function isToolDenied(agentId: string, toolName: string): boolean {
  const entry = _toolPolicy[agentId];
  if (!entry?.deny) return false;
  return entry.deny.some((pattern) => wildcardMatch(toolName, pattern));
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/** Set of agent names managed by this plugin. */
const managed = new Set<string>();

const larvaPlugin: Plugin = async ({ $, directory }) => {
  // Auto-detect: if running inside a larva project, use uv run
  try {
    const pyproject = await $`cat ${directory}/pyproject.toml`.quiet();
    if (pyproject.stdout.toString().includes('name = "larva"')) {
      _projectDir = directory;
      // debug: console.log(`[larva-plugin] Auto-detected larva project at ${directory}`)
    }
  } catch {
    /* not a larva project — will use bare `larva` from PATH */
  }

  // Which larva agent is active in the current API call.
  let active: string | null = null;

  return {
    // ----------------------------------------------------------------
    // Startup: export all personas, register as opencode agents
    // ----------------------------------------------------------------
    config: async (config: any) => {
      // Load tool policy (optional file)
      await loadToolPolicy($, directory);

      const specs = await larvaExportAll($);
      if (!specs || !specs.length) return;
      config.agent ??= {};

      for (const spec of specs) {
        managed.add(spec.id);

        // Build permissions: larva policy + tool-policy.json overrides
        const perms = toPermissions(spec) ?? {};
        const finalPerms = applyToolPolicy(spec.id, perms);

        config.agent[spec.id] = {
          description: spec.description
            ? `[larva] ${spec.description}`
            : `[larva] ${spec.id}`,
          mode: "all" as const,
          prompt: placeholder(spec.id),
          ...(spec.model ? { model: spec.model } : {}),
          ...(Object.keys(finalPerms).length ? { permission: finalPerms } : {}),
        };

        // Pre-cache prompt for first message
        setCache(spec.id, spec);
      }
    },

    // ----------------------------------------------------------------
    // Per-message: track active agent, apply temperature, re-resolve
    // on cache miss
    // ----------------------------------------------------------------
    "chat.params": async (input: any, output: any) => {
      const name =
        typeof input.agent === "string"
          ? input.agent
          : (input.agent as any)?.name;
      if (!name || !managed.has(name)) {
        active = null;
        return;
      }
      active = name;

      // Re-export on cache expiry (get all specs, extract needed one)
      let entry = getCached(name);
      if (!entry) {
        const specs = await larvaExportAll($);
        if (specs) {
          for (const spec of specs) {
            setCache(spec.id, spec);
          }
          entry = getCached(name);
        }
      }

      // Apply temperature only if larva persona explicitly set it
      if (entry?.temperature !== undefined) {
        output.temperature = entry.temperature;
      }
    },

    // ----------------------------------------------------------------
    // Per-message: replace placeholder with real prompt + watermark
    // ----------------------------------------------------------------
    "experimental.chat.system.transform": async (_input: any, output: any) => {
      // system.transform runs BEFORE chat.params, so we cannot use `active`.
      // Instead, each agent has a unique placeholder `[larva:<id>]` in its
      // prompt. We detect which one is present and replace it.
      if (!output.system.length) return;
      const sys = output.system[0] ?? "";

      for (const id of managed) {
        const ph = placeholder(id);
        if (!sys.includes(ph)) continue;

        const entry = getCached(id);
        if (!entry) {
          // debug: console.log(`[larva-plugin] system.transform: no cache for ${id}, skipping`)
          break;
        }

        const watermark = [
          `<larva-persona id="${id}" />`,
          `When asked "who are you" or "what persona", mention that you are the "${id}" persona loaded from larva.`,
        ].join("\n");
        output.system[0] = sys.replace(ph, entry.prompt + "\n\n" + watermark);
        // debug: console.log(`[larva-plugin] system.transform: injected prompt for ${id}`)
        // Also track which agent is active (system.transform runs before chat.params)
        active = id;
        break;
      }
    },

    // ----------------------------------------------------------------
    // Tool enforcement: block denied tools before execution
    // ----------------------------------------------------------------
    "tool.execute.before": async (input: any, _output: any) => {
      // no debug logging
      if (!active) return;
      if (isToolDenied(active, input.tool)) {
        throw new Error(
          `[larva] Tool "${input.tool}" is denied for agent "${active}" by tool-policy.json`,
        );
      }
    },
  };
};

export default larvaPlugin;
