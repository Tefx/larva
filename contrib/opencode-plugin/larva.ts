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

import type { Plugin } from "@opencode-ai/plugin"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * How to invoke larva CLI. Resolution order:
 *   1. Auto-detect: if cwd contains pyproject.toml with name = "larva",
 *      use `uv run --project <cwd> larva`
 *   2. Fallback: try bare `larva` in PATH (pip install larva)
 */
const CACHE_TTL_MS = 5 * 60_000

// Set as agent.prompt during config so opencode uses it instead of falling
// back to the generic provider prompt (llm.ts:72 checks agent.prompt truthy).
// Replaced with real prompt via system.transform hook at runtime.
/** Each agent gets a unique placeholder containing its id. */
function placeholder(id: string) { return `[larva:${id}]` }

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PersonaSpec {
  id: string
  description?: string
  prompt?: string
  model?: string
  model_params?: Record<string, number>
  tools?: Record<string, string>
  can_spawn?: boolean | string[]
  side_effect_policy?: string
}

interface CacheEntry {
  prompt: string
  temperature?: number
  ts: number
}

// ---------------------------------------------------------------------------
// larva CLI helpers
// ---------------------------------------------------------------------------

// Set at plugin init if cwd is a larva project
let _projectDir: string | undefined

async function larvaExec($: any, args: string[]): Promise<string> {
  if (_projectDir) {
    const r = await $`uv run --project ${_projectDir} larva ${args}`.quiet()
    return r.stdout.toString()
  }
  // Try larva in PATH, fallback to uvx
  try {
    const r = await $`larva ${args}`.quiet()
    return r.stdout.toString()
  } catch {
    const r = await $`uvx larva ${args}`.quiet()
    return r.stdout.toString()
  }
}

async function larvaExportAll($: any): Promise<PersonaSpec[] | null> {
  try {
    const r = await larvaExec($, ["export", "--all", "--json"])
    const parsed = JSON.parse(r)
    console.log(`[larva-plugin] export --all: ${parsed.data?.length ?? 0} personas`)
    return parsed.data ?? null
  } catch (e: any) {
    console.error(`[larva-plugin] export --all failed:`, e?.message ?? e)
    return null
  }
}

// ---------------------------------------------------------------------------
// Prompt cache — avoids repeated CLI calls within a session
// ---------------------------------------------------------------------------

const cache = new Map<string, CacheEntry>()

function getCached(id: string): CacheEntry | null {
  const entry = cache.get(id)
  if (!entry || Date.now() - entry.ts > CACHE_TTL_MS) return null
  return entry
}

function setCache(id: string, spec: PersonaSpec) {
  if (!spec.prompt) return
  cache.set(id, {
    prompt: spec.prompt,
    temperature: spec.model_params?.temperature,
    ts: Date.now(),
  })
}

// ---------------------------------------------------------------------------
// Permission mapping: larva side_effect_policy + can_spawn → opencode rules
// ---------------------------------------------------------------------------

function toPermissions(spec: PersonaSpec) {
  const rules: Array<{ permission: string; pattern: string; action: string }> = []

  switch (spec.side_effect_policy) {
    case "read_only":
      rules.push({ permission: "edit", pattern: "*", action: "deny" })
      rules.push({ permission: "bash", pattern: "*", action: "deny" })
      break
    case "approval_required":
      rules.push({ permission: "edit", pattern: "*", action: "ask" })
      rules.push({ permission: "bash", pattern: "*", action: "ask" })
      break
    // "allow" → no restrictions
  }

  if (spec.can_spawn === false) {
    rules.push({ permission: "task", pattern: "*", action: "deny" })
  }

  return rules.length > 0 ? rules : undefined
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/** Set of agent names managed by this plugin. */
const managed = new Set<string>()

const larvaPlugin: Plugin = async ({ $, directory }) => {
  // Auto-detect: if running inside a larva project, use uv run
  try {
    const pyproject = await $`cat ${directory}/pyproject.toml`.quiet()
    if (pyproject.stdout.toString().includes('name = "larva"')) {
      _projectDir = directory
      console.log(`[larva-plugin] Auto-detected larva project at ${directory}`)
    }
  } catch { /* not a larva project — will use bare `larva` from PATH */ }

  // Which larva agent is active in the current API call.
  let active: string | null = null

  return {
    // ----------------------------------------------------------------
    // Startup: export all personas, register as opencode agents
    // ----------------------------------------------------------------
    config: async (config: any) => {
      const specs = await larvaExportAll($)
      if (!specs || !specs.length) return
      config.agent ??= {}

      for (const spec of specs) {
        managed.add(spec.id)

        // Register agent with mapped permissions and model
        console.log(`[larva-plugin] Registered agent: ${spec.id}`)
        config.agent[spec.id] = {
          description: spec.description
            ? `[larva] ${spec.description}`
            : `[larva] ${spec.id}`,
          mode: "all" as const,
          prompt: placeholder(spec.id),
          ...(spec.model ? { model: spec.model } : {}),
          ...(toPermissions(spec) ? { permission: toPermissions(spec) } : {}),
        }

        // Pre-cache prompt for first message
        setCache(spec.id, spec)
      }
    },

    // ----------------------------------------------------------------
    // Per-message: track active agent, apply temperature, re-resolve
    // on cache miss
    // ----------------------------------------------------------------
    "chat.params": async (input: any, output: any) => {
      const name = typeof input.agent === "string"
        ? input.agent
        : (input.agent as any)?.name
      if (!name || !managed.has(name)) {
        active = null
        return
      }
      active = name

      // Re-export on cache expiry (get all specs, extract needed one)
      let entry = getCached(name)
      if (!entry) {
        const specs = await larvaExportAll($)
        if (specs) {
          for (const spec of specs) {
            setCache(spec.id, spec)
          }
          entry = getCached(name)
        }
      }

      // Apply temperature only if larva persona explicitly set it
      if (entry?.temperature !== undefined) {
        output.temperature = entry.temperature
      }
    },

    // ----------------------------------------------------------------
    // Per-message: replace placeholder with real prompt + watermark
    // ----------------------------------------------------------------
    "experimental.chat.system.transform": async (_input: any, output: any) => {
      // system.transform runs BEFORE chat.params, so we cannot use `active`.
      // Instead, each agent has a unique placeholder `[larva:<id>]` in its
      // prompt. We detect which one is present and replace it.
      if (!output.system.length) return
      const sys = output.system[0] ?? ""

      for (const id of managed) {
        const ph = placeholder(id)
        if (!sys.includes(ph)) continue

        const entry = getCached(id)
        if (!entry) {
          console.log(`[larva-plugin] system.transform: no cache for ${id}, skipping`)
          break
        }

        const watermark = [
          `<larva-persona id="${id}" />`,
          `When asked "who are you" or "what persona", mention that you are the "${id}" persona loaded from larva.`,
        ].join("\n")
        output.system[0] = sys.replace(ph, entry.prompt + "\n\n" + watermark)
        console.log(`[larva-plugin] system.transform: injected prompt for ${id}`)
        break
      }
    },
  }
}

export default larvaPlugin