# RFC: Larva MCP Transport — Add HTTP Transport Type

**Status**: Implemented
**Date**: 2026-03-22
**Affects**: MCPTransportMode type, mcp_contract.py, documentation

## Terminology

See opifex umbrella RFC for canonical definitions. In short: `"http"` =
MCP Streamable HTTP (spec 2025-03-26+). `"sse"` = legacy transport.

## Context

The MCP specification (2025-03-26+) designates **Streamable HTTP** as the
standard remote transport. Larva currently defines `MCPTransportMode` as
`Literal["stdio", "sse"]` but only implements stdio. As a CLI-first persona
toolkit, stdio is the correct default — but the type definition and docs
should reflect the current MCP standard.

## Current State

| Component | Value | Location |
|-----------|-------|----------|
| `MCPTransportMode` | `Literal["stdio", "sse"]` | `mcp_contract.py:314` |
| `MCPServerConfig` | TypedDict with transport, host, port | `mcp_contract.py:317-323` |
| Implemented transport | stdio only | `mcp_server.py:175-182` |
| CLI description | "Start the MCP server (stdio transport)" | `cli_parser.py` |
| USAGE.md | "larva runs as an MCP server (stdio or SSE)" | `USAGE.md` |

## Proposed Changes

### 1. Update `MCPTransportMode`

```python
# Before
MCPTransportMode = Literal["stdio", "sse"]

# After
MCPTransportMode = Literal["stdio", "http", "sse"]
```

`"http"` = MCP Streamable HTTP (spec 2025-03-26+).
`"sse"` retained for type completeness but marked deprecated in docstring.

### 2. Update documentation

USAGE.md:

```markdown
# Before
larva runs as an MCP server (stdio or SSE)

# After
larva runs as an MCP server (stdio, HTTP, or SSE).
stdio is the default for CLI usage. HTTP is the standard remote transport
(MCP spec 2025-03-26+). SSE is legacy.
```

## Non-Changes

- `run_mcp_stdio()`: unchanged, remains the default and only implementation
- `MCPServerConfig` TypedDict: already has host/port fields, no structural change
- FastMCP dependency: not currently used (larva uses `mcp.server.fastmcp.FastMCP`
  directly from the mcp SDK) — sufficient for both stdio and future HTTP
- HTTP implementation is out of scope for this RFC. When larva needs remote
  serving (e.g., for nervus dispatch), a follow-up RFC will cover it using
  the `FastMCP.run(transport="http", ...)` pattern.

## Risk

- **Minimal**: This is a type-level and documentation change only.
  No runtime behavior changes. Forward-compatible with future HTTP
  implementation.

## Acceptance Criteria

1. `MCPTransportMode` includes `"http"`.
2. USAGE.md reflects all three transport modes with HTTP as recommended remote.
3. No runtime behavior changes.

## Rollback

Revert `MCPTransportMode` to `Literal["stdio", "sse"]` and USAGE.md text.
