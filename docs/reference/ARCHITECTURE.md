# Larva 0.9 architecture

Larva is a persona image store and a Pi process and context supervisor. It manages in-process persona selection and turn-scoped leases in native Pi, and supervises isolated Pi children from native Pi or an external MCP host. The [architecture specification](../../design/larva-0.9-architecture.md) is binding.

## One filesystem root

An unset or empty `LARVA_HOME` means `$HOME/.larva`. A non-empty value must be a normalized absolute path without NUL bytes; invalid input fails with `LARVA_CONFIG_INVALID` rather than silently using the default.

| Path relative to `LARVA_HOME` | Purpose |
| --- | --- |
| `personas/` | One `<id>.md` or `<id>.json` definition per persona |
| `config.json` | Optional closed runtime configuration |
| `model-map.json`, `model-map.<profile>.json` | Optional route maps; named profiles use lowercase alphanumeric and hyphen names, excluding `default` |
| `state/sessions/` | Child Pi `.jsonl` transcripts and exclusive `.jsonl.lock/` leases |
| `state/artifacts/` | Full text for oversized child results |
| `state/capsules/` | Ephemeral child-specific Pi agent configuration |

Managed state directories use mode `0700`; full output artifacts use mode `0600`.

## One canonical persona

A [PersonaSpec](../../contracts/persona_spec.schema.json) contains `id`, `description`, `prompt`, `model`, `thinking`, `can_spawn`, `tools`, and computed `spec_digest`. IDs are lowercase ASCII kebab-case. Description and prompt normalize CRLF/CR to LF, trim surrounding whitespace, and must remain nonempty. The model is a literal `<provider>/<model_id>` route; static validation checks syntax, not installation or credentials.

`thinking` defaults to `medium` and accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. `can_spawn` defaults to `false`; it accepts a boolean or an array of 1–100 unique persona IDs. `tools` defaults to empty `allow` and `deny` arrays. A pattern is an exact whitespace-free tool name or a nonempty name prefix followed by one `*`; duplicates within either array are invalid.

Markdown puts the prompt in the body and the other authored fields in YAML frontmatter. Frontmatter accepts YAML 1.2 Core/JSON values, without anchors, aliases, custom tags, or `spec_digest`. JSON puts the prompt in a field and may include a digest, which must match the computed value. For any named input, the filename stem must be a valid persona ID; it supplies an omitted Markdown `id`, and any explicit `id` must match it. Standard input requires an explicit `id`; leading `{` after whitespace selects JSON, otherwise Markdown is expected.

Equivalent Markdown and JSON normalize to the same object and `sha256:<64-hex>` digest. The digest covers compact key-sorted UTF-8 JSON of the canonical fields other than the digest, after defaults and lexicographic sorting of the tool arrays and any spawn allowlist. Coexisting `.md` and `.json` for an ID are a conflict, not two variants.

## Store and runtime ownership

- The store reads persona files in-process. Exact reads inspect only the target ID's two possible files. Listing ignores dotfiles, sorts valid records by ID, and omits invalid or conflicted definitions while recording bounded diagnostics for `larva doctor`.
- `put` validates all incoming definitions before writing. Each persona commits by atomic rename of a hidden staging file, then removes the other format. A pruned directory import removes unlisted personas only after all incoming commits. A partial I/O failure reports `LARVA_STORE_WRITE_FAILED` with `committed_ids`, `pruned_ids`, and `failed_id`. `rm` checks that all targets exist before unlinking either format. Both writes can repair a dual-format conflict.
- Native Pi owns active identity and model state. See [persona switching](PI_AGENT_PERSONA_SWITCH_POLICY.md) for temporary leases and persistent selection. A single idempotent prompt composer replaces Larva identity and persona blocks across hooks and the peer prompt event.
- The supervisor owns child processes, capsules, transcript leases, deadlines, and terminal output. An accepted run has passed route and prompt checks; it is not a completion receipt. See [asynchronous subagents](PI_EXTENSION_ASYNC_SUBAGENTS.md).

## Distribution

The root `pi-larva` package builds independent ESM bundles without shared chunks or runtime npm dependencies. `dist/pi-extension.js` is the Pi-loadable extension and the only bundle that imports Pi TUI. `dist/cli.mjs` and `dist/mcp-server.mjs` are headless, `dist/child-rpc-preload.mjs` bridges child output, and `dist/timeline-worker.mjs` scans recorded activity. The Codex plugin ships its own MCP server and sibling runtime bundles in `plugins/codex/dist/`.
