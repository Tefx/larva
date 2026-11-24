# Larva 0.8.11

`larva-subagent-result` now allows up to 36,000 normalized code points per inline callback, up from 6,000. The limit includes callback metadata and code fences.

Successful output that does not fit in the callback still provides a `full_output_artifact` and a `child_output_preview` of up to 1,000 normalized code points. The compaction focus limit is unchanged.

## Installation and use

For a source checkout at `v0.8.11`, run `uv sync` to update the local Python package. The Pi extension and Codex plugin are shipped separately in the tagged source. If the configured Codex marketplace points to the updated source, refresh the plugin and restart Codex to load it:

```bash
codex plugin remove larva-subagent@larva
codex plugin add larva-subagent@larva
```

## Verification scope

Release checks cover Pi/Codex runtime byte identity, inline and overlong callback delivery, full artifact retention, MCP runtime behavior, and the real Pi async-subagent smoke scenario.
