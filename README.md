# Larva 0.9.0

Larva stores reusable agent personas and runs isolated [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) processes. A persona describes the agent's instructions, model, thinking level, tool policy, and authority to launch subagents. Use Larva inside Pi to select a persona or delegate work, or connect an external MCP host such as Codex to launch and supervise Pi children.

## Install and start

Install Pi and the Larva CLI with npm, then install the Larva package in Pi to enable its native extension:

```sh
npm install -g @earendil-works/pi-coding-agent pi-larva@0.9.0
pi install npm:pi-larva@0.9.0
```

Larva uses one `LARVA_HOME` for persona definitions, configuration, and managed session state. It defaults to `$HOME/.larva`. Save this example as `reviewer.md`, replacing `provider/model-id` with a route configured in Pi:

```markdown
---
description: Reviews a proposed change for correctness.
model: provider/model-id
---

Review the change. Report concrete findings with file references and explain
what evidence would resolve any uncertainty.
```

```sh
larva persona validate reviewer.md
larva persona put reviewer.md
larva doctor
pi --larva-persona reviewer
```

For a named file, its stem is the persona ID. Equivalent Markdown (`.md`) and JSON (`.json`) definitions produce the same canonical spec and digest. Keep only one file per ID in the store.

## Surfaces

- **CLI:** `larva persona validate`, `put`, `get`, `list`, and `rm` manage definitions; `larva doctor` checks setup; `larva gc` cleans up inactive state. These commands print human-readable summaries by default or JSON with `--json`. Use `--help` on any subcommand, including `larva mcp --help` without starting the server.
- **Native Pi:** `🎭` shows persona state and `🤖` shows active subagent counts. In an idle TUI, `/larva-persona`, `/larva-mode`, and `/larva-model-map` open selectors; add `--status` to inspect without changing anything. `/larva-subagent` opens the five-tab console. The extension registers seven model-facing tools, subject to persona policy and session mode.
- **External MCP:** `larva mcp` serves six model-facing tools over stdio. The Codex marketplace plugin in `plugins/codex/` bundles its own server and a four-tab fullscreen console. Pi is still required to run children.

Start with the [user guide](docs/guides/USER_GUIDE.md) or the [operator guide](docs/guides/USAGE.md). See the [documentation index](docs/README.md) for all guides and reference documents. The [0.9 architecture specification](design/larva-0.9-architecture.md) is the binding contract.

Larva is licensed under [AGPL-3.0-or-later](LICENSE).
