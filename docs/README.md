# larva documentation map

The repository root keeps only entrypoint docs and tool-required files. Detailed
project documentation lives here by category.

## Guides

- `guides/USER_GUIDE.md` — human-oriented walkthrough
- `guides/USAGE.md` — agent/operator usage notes

## Reference

- `reference/INTERFACES.md` — public interfaces and contract surfaces
- `reference/ARCHITECTURE.md` — module boundaries and dependency rules

## Decisions

- `adr/` — accepted architecture decision records

## Design bases

- `../design/registry-local-variants-and-assembly-removal.md` — accepted design
  for removing assembly/component surfaces and adding registry-local variants
  without changing PersonaSpec
- `../design/` — design and adjudication history. Older component/assembly docs
  are historical unless restated by the accepted registry-local variants design.
## Still intentionally at repo root

- `../README.md` — project entrypoint for GitHub and package metadata
- `../INVAR.md` — Invar repair patterns referenced by root agent instructions
- `../AGENTS.md`, `../CLAUDE.md`, `../GEMINI.md` — agent/tooling entrypoints
- `../plan.yaml` — vectl-managed plan file; do not move or edit directly
