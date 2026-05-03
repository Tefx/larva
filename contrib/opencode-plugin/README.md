# larva-opencode-plugin

Bridges larva's PersonaSpec registry to opencode's agent system.

## Current behavior

```
Launcher (`larva opencode`):
  1. Read currently active registered personas through larva's normal facade/export path
  2. Build a temporary OPENCODE_CONFIG_CONTENT with one placeholder agent per
     Larva base persona id
  3. Inject this plugin and exec the real opencode binary

Plugin startup (config hook):
  1. Load tool-policy.json (optional deny/allow rules)
  2. larva export --all --json → one-time startup projection of existing base ids
  3. Register/refresh opencode agents with permissions mapped
  4. Seed the performance cache with last-known-good prompt data

Runtime (per API call):
  chat.params → detect selected larva agent → resolve that id → apply temperature (if set)
  system.transform → replace placeholder with full prompt + watermark
  tool.execute.before → apply current tool-policy/permission denial for the selected id
  cache refresh → last-known-good performance state only; see the hardening contract below
```

`export --all` is **not** runtime semantic authority for prompt contents. It is
used only to satisfy OpenCode startup registration for the ids that must exist
before `--agent <larva-id>` validation. Per-request prompt/temperature and
permission refreshes use `larva resolve <id> --json` for the selected base id.

The launcher exists because some OpenCode versions validate `--agent` before
plugin config hooks finish. Early `OPENCODE_CONFIG_CONTENT` injection makes
`--agent <larva-id>` visible without writing `.opencode/opencode.json`.

There is no `larva-active` alias and no process-global active persona. The
OpenCode agent name is the Larva base persona id. Registry-local variants remain
Larva registry metadata: `larva resolve <id>` returns that id's active variant as
a canonical PersonaSpec, and the OpenCode wrapper projects the active variant for
each base persona id.

## Runtime refresh hardening contract

This section is the implementation contract for hardening the wrapper/plugin
path. Persona prompts must be injected at OpenCode's system-prompt transform
layer, not as MCP/tool-result context. The plugin must treat caching only as a
performance optimization:

1. Each model request identifies the selected Larva id from the placeholder
   already present in the OpenCode system prompt.
2. The plugin checks whether the cached spec for that id is still current. Prefer
   a cheap digest/mtime/stat check; if that is unavailable, use a very short
   cache window or allow disabling the cache for development.
3. On cache miss, stale cache, or digest change, resolve only the selected id
   (`larva resolve <id> --json` or equivalent). Do not refresh one selected id by
   running `larva export --all --json` unless this is a fallback path.
4. If resolve succeeds, inject the latest `prompt` and update request-scoped
   state such as supported `model_params`, capability-derived runtime policy,
   and tool-policy data.
5. If resolve fails but a last-known-good prompt exists, inject that prompt with
   a stale watermark and write a debug warning.
6. If resolve fails and no last-known-good prompt exists, fail closed. Never send
   the raw `[larva:<id>]` placeholder to the model.

Concurrent requests for the same id must share one in-flight resolve operation
instead of spawning multiple Larva CLI processes.

### Acceptance criteria

| ID | Criterion |
|----|-----------|
| AC-Per-Id-Resolve | Runtime cache miss, stale cache, or digest change resolves the selected id only, using `larva resolve <id> --json` or an equivalent single-id API. Startup may still use `export --all`. |
| AC-Placeholder-Never-Leaks | No final system prompt sent to OpenCode's model provider contains a raw `[larva:<id>]` placeholder. |
| AC-Last-Known-Good | If latest resolve fails and a previous prompt exists for the id, inject that last-known-good prompt with a stale watermark and write a debug warning. |
| AC-Fail-Closed | If latest resolve fails and no previous prompt exists, prevent the model request from proceeding with a degraded prompt. The plugin should halt the request pipeline with an explicit Larva resolve error, or use an equally safe fail-closed mechanism that cannot be mistaken for persona instructions. |
| AC-In-Flight-Dedup | Concurrent runtime resolves for the same id share one in-flight operation. |
| AC-Watermark | Normal prompts use `<!-- larva-spec: <id>@<short-digest> -->`; stale prompts use `<!-- larva-spec: <id>@<short-digest> stale -->`. The projection layer does not add extra identity instructions. |
| AC-Cache-Control | If a time-based cache fallback remains, `LARVA_OPENCODE_CACHE_TTL_MS=0` disables it for development. Digest/mtime/stat invalidation is preferred over TTL. |

### Hot-update boundary

| PersonaSpec / policy input | Runtime refresh target | Notes |
|----------------------------|------------------------|-------|
| `prompt` | yes | Injected via `system.transform`. |
| `model_params.temperature` | yes, if OpenCode exposes the request field | Applied via `chat.params` when explicitly set. |
| `tool-policy.json` | yes | Re-read when its mtime/digest changes. |
| `capabilities` / `can_spawn` runtime enforcement | target yes | Runtime hooks can block tools; startup OpenCode permission metadata may remain stale. |
| `description` | no | OpenCode displays startup agent metadata. |
| `model` / provider | usually no | Treat as startup-bound unless OpenCode supports per-request model override for the selected agent. |
| Added or deleted persona ids | no | Requires restarting `larva opencode` so OpenCode sees the new agent list. |

## Install

Preferred wrapper (no `.opencode/opencode.json` write required):

```bash
larva opencode
larva opencode --agent python-senior
larva opencode run "check this bug" --agent python-senior
larva opencode -- run "check this bug" --agent python-senior
```

Arguments after `larva opencode` are forwarded to OpenCode. The explicit `--`
separator is optional; when present, larva strips it before forwarding.

The wrapper builds a temporary `OPENCODE_CONFIG_CONTENT` value from the larva
registry, injects this plugin, and execs the real `opencode` process.

Plugin path resolution order:

1. `LARVA_OPENCODE_PLUGIN=/absolute/path/to/larva.ts`
2. bundled wheel resource at `larva/shell/opencode_plugin/larva.ts`
3. source-tree fallback at `contrib/opencode-plugin/larva.ts`

Manual plugin install remains possible for sessions that do not rely on early
`--agent <larva-id>` validation:

```jsonc
// .opencode/opencode.json (project) or ~/.config/opencode/opencode.json (global)
{
  "plugin": ["file:///path/to/larva/contrib/opencode-plugin/larva.ts"]
}
```

larva CLI resolution inside the plugin:
1. If cwd is a larva project (pyproject.toml with `name = "larva"`) → `uv run --project . larva`
2. `larva` in PATH → direct
3. Fallback → `uvx larva`

## Runtime cache and refresh semantics

The plugin cache is performance-only and stores last-known-good data by Larva
base persona id: `prompt`, optional `temperature`, optional `spec_digest`,
derived permissions, and a timestamp. Runtime requests are keyed from the
selected `[larva:<id>]` placeholder, not from module-global active variant state.

| Runtime condition | Behavior |
|-------------------|----------|
| Normal request | Resolve the selected id with `larva resolve <id> --json`; update cache when the resolved spec has a prompt |
| Same-id concurrent refresh | Share the in-flight resolve promise for that id |
| Digest change | Replace the cached entry and emit a debug warning when debug logging is enabled |
| Resolve failure with previous good prompt | Use stale last-known-good prompt and emit a debug warning |
| Resolve failure without previous good prompt | Fail closed with `[larva prompt unavailable for <id>; ...]` instead of leaking the placeholder |
| Resolved spec without prompt and previous good prompt exists | Use stale last-known-good prompt and emit a debug warning |
| Resolved spec without prompt and no previous good prompt | Fail closed |

Environment knobs:

| Env var | Default | Meaning |
|---------|---------|---------|
| `LARVA_OPENCODE_DEBUG=1` | unset/off | Emit cache/fallback/hardening warnings to stderr |
| `LARVA_OPENCODE_CACHE_TTL_MS` | `300000` | Cache storage knob; nonzero values allow last-known-good entries to be stored, `0` disables storing new entries; invalid or negative values fall back to default with a debug warning |

## Hot-update versus restart-required boundaries

Hot-updated on the next selected-id runtime request:

- prompt text
- `model_params.temperature`
- tool-policy deny/allow rules
- permission derivation from `capabilities`
- task denial from `can_spawn: false`

Requires an OpenCode restart because agent registration/config happens at
startup:

- added or deleted Larva base ids
- model/provider startup fields
- changes that require a new OpenCode agent entry to exist before `--agent` validation

Explicit non-goals:

- no `larva-active` pseudo-agent or state channel
- no global active variant shared across concurrent requests
- no use of `larva export --all` as runtime semantic authority for prompt refresh

Debug logging should remain opt-in. The hardening implementation should use
`LARVA_OPENCODE_DEBUG=1` for injection evidence such as selected id,
digest/source, stale fallback, or resolve errors. Normal successful refreshes
should be silent.

## Permission mapping

### From PersonaSpec (larva)

| PersonaSpec | opencode permission | Notes |
|-------------|---------------------|-------|
| `capabilities: {fs: "read_only", git: "read_only"}` | `edit: deny, bash: deny` | If ALL capabilities are none/read_only |
| `capabilities: {fs: "read_write"}` | no restrictions | ANY read_write/destructive = no restriction |
| `capabilities: {}` or absent | no restrictions | No postures declared; external runtime policy may still apply |
| `can_spawn: false` | `task: deny` | |

`side_effect_policy` is not a live PersonaSpec input here. Larva rejects it at
canonical admission, so this plugin derives permissions from `capabilities`
only.

### From tool-policy.json (runtime)

Per-agent deny/allow rules for specific opencode tools. This is **not** part of the persona definition — it's runtime enforcement (tela's job in the full opifex system, approximated here for opencode).

**Search order:**
1. `.opencode/tool-policy.json` (project-level)
2. `~/.config/opencode/tool-policy.json` (global)

**Format:**
```json
{
  "agents": {
    "python-senior": {
      "deny": ["vectl_vectl_claim", "vectl_vectl_mutate"]
    },
    "wiring-auditor": {
      "deny": ["write", "edit"]
    },
    "vectl-orchestrator": {
      "deny": ["serena_*", "read", "edit", "write", "glob", "grep"]
    }
  }
}
```

If the file doesn't exist, no tool restrictions are applied beyond what larva's
`capabilities` and `can_spawn` provide. `side_effect_policy` is invalid at the
larva canonical boundary and must not be treated as PersonaSpec input.

## Other mappings

| PersonaSpec | opencode Agent | Notes |
|-------------|---------------|-------|
| `id` | agent name | direct |
| `description` | `description` | prefixed with `[larva]` |
| `prompt` | system prompt | injected on-demand via system.transform |
| `model` | `model` | passed as-is |
| `model_params.temperature` | `temperature` | only if explicitly set |

### Not mapped

| PersonaSpec | Reason |
|-------------|--------|
| `tools` | Invalid legacy field; larva canonical admission rejects it |
| `side_effect_policy` | Invalid legacy field; larva canonical admission rejects it |
| `capabilities` | Used for permission derivation (see above) |
| `model_params.max_tokens` | opencode manages per-provider |
| `compaction_prompt` | opencode has its own compaction system |

## Target watermark format

Every larva-loaded prompt includes a low-noise marker near the end of the
injected system prompt plus the contractual identity instruction. Prefer
comment-style metadata so the marker is useful for debugging without becoming
user-facing instruction text:

```html
<!-- larva-spec: python-senior@abc123 -->
```

If the plugin must use last-known-good content because the latest resolve failed,
mark it explicitly:

```html
<!-- larva-spec: python-senior@abc123 stale -->
```

```text
When asked "who are you" or "what persona", mention that you are the "python-senior" persona loaded from larva.
```

## Limitations

- Agent list is fixed at OpenCode startup. Adding or deleting a persona id
  requires restarting `larva opencode` so the wrapper can project the new agent
  list. Editing the active variant behind an already-projected id is the runtime
  re-resolve target in the hardening contract above.
- Most `model`/provider changes are startup-bound in OpenCode. Request-scoped
  `model_params` such as temperature may be refreshed only when OpenCode exposes
  a matching hook field.
- The wrapper requires the real `opencode` executable to be available in `PATH`.
- Manual plugin-only install may be too late for `--agent <larva-id>` validation
  in OpenCode versions that validate agents before plugin config hooks finish;
  prefer `larva opencode` for that path.
- `capabilities` field is used for permission derivation but does not map 1:1 to
  OpenCode tool names.
- Temperature is only applied if larva persona explicitly sets it.
- There is no `/larva refresh` or `/larva status` command in the minimal design.
  Runtime refresh should be automatic after the hardening contract above is
  implemented. Troubleshooting should use fail-closed errors, opt-in debug logs,
  and ordinary Larva CLI commands such as `larva resolve <id> --json`.
