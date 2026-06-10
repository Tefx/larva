# larva documentation map

The repository root keeps only entrypoint docs and tool-required files. Detailed
project documentation lives here by category.

## Guides

- `guides/USER_GUIDE.md` — human-oriented walkthrough
- `guides/USAGE.md` — agent/operator usage notes

## Reference

- [`reference/ARCHITECTURE.md`](reference/ARCHITECTURE.md)
- [`reference/INTERFACES.md`](reference/INTERFACES.md)
- [`reference/PI_EXTENSION_ASYNC_SUBAGENTS.md`](reference/PI_EXTENSION_ASYNC_SUBAGENTS.md) — accepted design basis for Pi async/background subagents, targeted cancellation, and `/larva-subagent` UX.
- [`reference/PI_AGENT_PERSONA_SWITCH_POLICY.md`](reference/PI_AGENT_PERSONA_SWITCH_POLICY.md) — target four-level Pi agent/runtime persona switch policy: `manual`, `confirm`, `auto`, `free`.
- [`reference/PI_EXTENSION_COMPACTION_FOCUS.md`](reference/PI_EXTENSION_COMPACTION_FOCUS.md) — target design for adding Larva/persona compaction focus while preserving Pi's default compaction prompts.

## Decisions

- `adr/` — accepted architecture decision records

## Design bases

- `../design/registry-local-variants-and-assembly-removal.md` — accepted design
  for removing assembly/component surfaces and adding registry-local variants
  without changing PersonaSpec
- `../design/pi-agent-persona-self-switch.md` — historical first-target design;
  its `off|ask|auto` mode semantics are obsolete for new work. Current mode
  semantics are owned by `reference/PI_AGENT_PERSONA_SWITCH_POLICY.md`.
- `../design/pi-coding-agent-integration.md` — current Pi integration design
  except `/larva-mode` / `--agent-persona-switch` mode semantics, which are owned
  by `reference/PI_AGENT_PERSONA_SWITCH_POLICY.md`.
- `../design/` — design and adjudication history. Older component/assembly docs
  are historical unless restated by the accepted registry-local variants design.

## Still intentionally at repo root

- `../README.md` — project entrypoint for GitHub and package metadata
- `../INVAR.md` — Invar repair patterns referenced by root agent instructions
- `../AGENTS.md`, `../CLAUDE.md`, `../GEMINI.md` — agent/tooling entrypoints
- `../plan.yaml` — vectl-managed plan file; do not move or edit directly
