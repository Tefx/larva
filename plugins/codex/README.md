# Larva Subagents for Codex

Larva Subagents 0.9.0 runs Persona-bound Pi child sessions from Codex. Use Codex's native tools for ordinary work. Type `@larva:` in the composer to select an exact persona, or use `@larva` to ask Codex to discover one.

Install **Larva Subagents** from the Larva marketplace. The plugin runs the bundled MCP server with Node and uses an installed Pi CLI; it does not require a global `pi-larva` installation. Configure the persona store with `LARVA_HOME` and, if needed, point `LARVA_PI_CLI_SCRIPT` at the Pi CLI. For a source checkout, run `npm ci` and `npm run build` before installing the local plugin.

Open **Larva Subagents** from the thread to inspect active, recent, or recorded sessions. Spawn and wait cards follow the original run, even if its session is later resumed. Closing a view does not cancel a child. See [the skill](skills/larva-subagent/SKILL.md) for workspace selection and delegation rules.
