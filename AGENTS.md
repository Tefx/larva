# Larva repository instructions

## Local contract authority

Larva 0.9 is an independent, single-stack TypeScript package. The binding
contract is `design/larva-0.9-architecture.md` and
`contracts/persona_spec.schema.json`. The local types and enforcement live in
`src/core/errors.ts`, `src/core/types.ts`, `src/core/persona.ts`,
`src/core/config.ts`, `src/core/paths.ts`, `src/core/tool-policy.ts`, and
`src/core/spawn-policy.ts`. Report discrepancies rather than silently broadening
admission. Reject malformed values, forbidden fields, and unknown keys; do not
add compatibility aliases or accept-and-clean behavior.

## Architecture and verification

- Keep `src/core/**` pure: no side-effect I/O. Path and environment resolution
  helpers operate on supplied values as specified. Ship zero runtime npm
  dependencies.
- `src/core/**`, `src/store/**`, `src/runtime/**`, and `src/activity/**` must
  not reference `@earendil-works/pi-tui`. Within `src/surfaces/**` and
  `src/ui/**`, only Pi extension and TUI modules may import it. No `.mjs`
  bundle may contain a `@earendil-works/pi-tui` reference.
- Run `npm run typecheck`, targeted `node --test` suites, and `npm run build`.
  Run `git diff --exit-code plugins/codex/` on the committed tree after a
  build to verify that tracked Codex artifacts match the build.
- Use hermetic fixtures with temporary `LARVA_HOME` and Pi agent directories.
  Never modify the host `~/.larva` or `~/.pi/agent/settings.json` during tests.
- Pi dependency locks reproduce local builds; they do not restrict installed Pi
  versions. Record versions as context. Do not add version-based runtime
  rejection, compatibility matrices/probes, speculative adaptation, automatic
  upgrades, or global installation/configuration changes. Verify actual native
  behavior in isolated fixtures; preserve package/bin identity checks.

## Managed execution plan

`plan.yaml` belongs exclusively to Vectl. Never edit it with file tools.
Prefer Vectl MCP; CLI fallback is `uv run vectl`, then `vectl`, then `uvx vectl`.
Follow the claimed step's paths, authority, evidence and ownership. Claim at most
one step at a time; completion requires commands, observed results and gaps.
Step IDs must be globally unique. Use `vectl_guide` for planning or recovery.
Completed Plan history and original observations remain immutable.
