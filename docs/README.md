# Larva 0.9 documentation

The [0.9 architecture specification](../design/larva-0.9-architecture.md) defines the release contract. The [PersonaSpec schema](../contracts/persona_spec.schema.json) checks the JSON input shape; Larva normalizes definitions and verifies supplied digests.

## Guides

- [User guide](guides/USER_GUIDE.md): create a persona, use it in Pi, and delegate from Codex.
- [Operator guide](guides/USAGE.md): configure an isolated home, run MCP, and maintain session state.

## Reference

- [Architecture](reference/ARCHITECTURE.md): components, filesystem, canonical data, and state ownership.
- [Interfaces](reference/INTERFACES.md): CLI help and output, Pi selectors and badges, model tools, and the Pi and Codex consoles.
- [Asynchronous subagents](reference/PI_EXTENSION_ASYNC_SUBAGENTS.md): admission and ownership, recorded activity, cancellation, and cleanup retry.
- [Pi persona switching](reference/PI_AGENT_PERSONA_SWITCH_POLICY.md): startup precedence, switching modes, leases, nested tool admission, and model-map changes.
