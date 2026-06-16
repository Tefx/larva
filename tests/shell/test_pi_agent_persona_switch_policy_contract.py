"""Expected-red contract tests for the Pi agent persona switch policy.

These tests intentionally define the *target* behavior documented in
``docs/reference/PI_AGENT_PERSONA_SWITCH_POLICY.md`` before implementation is
changed.  Current legacy implementation is expected to fail this file until it
moves from persistent ``off|ask|auto`` switching to temporary
``manual|confirm|auto|free`` borrowing semantics.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import textwrap
from pathlib import Path
from typing import Any, Final

import pytest

ROOT: Final = Path(__file__).resolve().parents[2]
EXTENSION: Final = ROOT / "contrib" / "pi-extension" / "larva.ts"
POLICY: Final = ROOT / "docs" / "reference" / "PI_AGENT_PERSONA_SWITCH_POLICY.md"
README: Final = ROOT / "README.md"
USER_GUIDE: Final = ROOT / "docs" / "guides" / "USER_GUIDE.md"
PI_EXTENSION_README: Final = ROOT / "contrib" / "pi-extension" / "README.md"
PI_INTEGRATION_DESIGN: Final = ROOT / "design" / "pi-coding-agent-integration.md"
PI_SELF_SWITCH_DESIGN: Final = ROOT / "design" / "pi-agent-persona-self-switch.md"

CANONICAL_MODES: Final = ("manual", "confirm", "auto", "free")
LEGACY_ALIASES: Final = ("off", "ask")
CONFIRM_CHOICES: Final = (
    "Borrow once",
    "Deny",
    "Auto-borrow for this session",
    "Switch persistently",
)
TERMINAL_RESTORE_PATHS: Final = ("success", "failure", "cancellation", "timeout")
ASYNC_SUBAGENT_CONSTRAINT_TOKENS: Final = (
    "Do not use shell sleep polling",
    "exact task_id",
    "no public `run_id`",
    "last alias",
    "fuzzy selector",
    "sidecar metadata",
    "never orchestration authority",
)


def _source() -> str:
    assert EXTENSION.exists(), f"missing extension under test: {EXTENSION.relative_to(ROOT)}"
    return EXTENSION.read_text(encoding="utf-8")


def _document(path: Path) -> str:
    assert path.exists(), f"missing required policy source: {path.relative_to(ROOT)}"
    return path.read_text(encoding="utf-8")


def _run_node(tmp_path: Path, script: str, *, timeout: float = 8.0) -> dict[str, Any]:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is required for Pi extension persona switch policy contract tests")

    script_path = tmp_path / "scenario.mjs"
    script_path.write_text(textwrap.dedent(script), encoding="utf-8")
    completed = subprocess.run(
        [node, str(script_path)],
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout,
        env={**os.environ, "LARVA_PI_INITIAL_PERSONA_ID": "", "LARVA_PI_LAUNCHED": "0"},
    )
    assert completed.returncode == 0, completed.stderr
    return json.loads(completed.stdout)


def _run_confirm_borrow_dialog_scenario(tmp_path: Path, selected_expression: str) -> dict[str, Any]:
    return _run_node(
        tmp_path,
        f"""
        import {{ mkdtemp, writeFile }} from "node:fs/promises";
        import {{ tmpdir }} from "node:os";
        import {{ join }} from "node:path";
        import {{ pathToFileURL }} from "node:url";
        const dir = await mkdtemp(join(tmpdir(), "larva-confirm-borrow-dialog-"));
        const cli = join(dir, "fake-larva-cli.mjs");
        await writeFile(cli, `
        const [, , command, personaId, jsonFlag] = process.argv;
        if (command !== "resolve" || jsonFlag !== "--json") process.exit(3);
        process.stdout.write(JSON.stringify({{ data: {{
          id: personaId, description: "Persona " + personaId, prompt: "Prompt " + personaId,
          model: "provider/model", capabilities: {{}}, spec_version: "0.1.0", spec_digest: "sha256:" + personaId,
          can_spawn: true
        }} }}));
        `, "utf8");
        const mod = await import(pathToFileURL({json.dumps(str(EXTENSION))}).href + "?case=confirm-borrow-dialog-" + Date.now() + Math.random());
        const selectCalls = [];
        const statuses = [];
        const entries = [];
        const setModelCalls = [];
        const activeToolCalls = [];
        const ctx = {{
          env: {{ LARVA_PI_AGENT_PERSONA_SWITCH: "confirm", LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, cli]) }},
          ui: {{
            select: async (title, options) => {{
              selectCalls.push({{ title, options }});
              return {selected_expression};
            }},
            setStatus: async (...args) => statuses.push(args),
            notify: async () => undefined,
          }},
          modelRegistry: {{ find: async () => ({{ id: "model" }}) }},
        }};
        const pi = {{
          getAllTools: async () => ["read", "bash", "larva_persona_switch", "larva_personas"],
          setActiveTools: async (tools) => {{ activeToolCalls.push(tools); return true; }},
          setModel: async (...args) => {{ setModelCalls.push(args); return true; }},
          appendEntry: (customType, data) => entries.push({{ customType, data }}),
          registerCommand: () => undefined,
          registerTool: () => undefined,
          on: () => undefined,
        }};
        await mod.initializeExtension(ctx, pi);
        await mod.commitPersona("origin", ctx, pi);
        setModelCalls.length = 0;
        activeToolCalls.length = 0;
        entries.length = 0;
        const beforePersona = mod.getActiveEnvelope()?.persona_id ?? null;
        const result = await mod.larva_persona_switch({{ persona_id: "target", reason: "confirm borrow dialog selection mapping" }}, ctx, pi);
        const afterPersona = mod.getActiveEnvelope()?.persona_id ?? null;
        console.log(JSON.stringify({{
          beforePersona,
          afterPersona,
          resultStatus: result.status,
          errorCode: result.error?.code ?? null,
          lease: result.details?.lease ?? null,
          selectOptions: selectCalls[0]?.options ?? null,
          selectOptionTypes: (selectCalls[0]?.options ?? []).map((option) => typeof option),
          selectTitle: selectCalls[0]?.title ?? null,
          setModelCallCount: setModelCalls.length,
          activeToolCallCount: activeToolCalls.length,
          auditEvents: entries.filter((entry) => entry.customType === "larva-agent-persona-switch-audit").map((entry) => entry.data),
          statusTexts: statuses.map((args) => args.filter((value) => typeof value === "string").join(" ")),
        }}));
        """,
    )


def test_policy_docs_are_synchronized_on_canonical_modes_and_legacy_rejection() -> None:
    """All operator-facing docs must name exactly manual/confirm/auto/free.

    ``design/pi-agent-persona-self-switch.md`` is allowed to mention the legacy
    first target only as explicitly historical/superseded text; the current
    authority and operator docs must reject legacy aliases.
    """

    policy = _document(POLICY)
    docs = {
        "README.md": _document(README),
        "docs/guides/USER_GUIDE.md": _document(USER_GUIDE),
        "contrib/pi-extension/README.md": _document(PI_EXTENSION_README),
        "design/pi-coding-agent-integration.md": _document(PI_INTEGRATION_DESIGN),
    }
    historical = _document(PI_SELF_SWITCH_DESIGN)

    assert "manual < confirm < auto < free" in policy
    assert "The default mode is `confirm`." in policy
    assert "no `off`/`ask` aliases" in policy
    assert "fail safe to `confirm` with a warning" in policy

    for name, text in docs.items():
        for mode in CANONICAL_MODES:
            assert mode in text, f"{name} must document canonical mode {mode!r}"
        assert "default is `confirm`" in text or "defaults to `confirm`" in text
        assert "Unknown mode values fail safe to `confirm`" in text
        assert "off|ask|auto" not in text, f"{name} must not present legacy aliases as current modes"

    assert "historical" in historical.lower()
    assert "superseded" in historical.lower()
    assert "manual`, `confirm`,\n`auto`, and `free`" in historical


def test_extension_source_declares_exact_canonical_modes_default_confirm_and_no_alias_mapping() -> None:
    """Runtime mode parser must be canonical, fail-safe, and not compat-mapped."""

    source = _source()
    assert 'export type AgentPersonaSwitchMode = "manual" | "confirm" | "auto" | "free"' in source
    assert 'let agentPersonaSwitchMode: AgentPersonaSwitchMode = "confirm"' in source
    assert 'value === "manual" || value === "confirm" || value === "auto" || value === "free"' in source
    assert 'return isAgentPersonaSwitchMode(envMode) ? envMode : "confirm"' in source
    assert "unknown agent persona switch mode" in source.lower()
    assert "warn" in source.lower() or "warning" in source.lower()
    assert '"off"' not in source
    assert '"ask"' not in source


@pytest.mark.parametrize("bad_mode", ["off", "ask", "invalid", "", "CONFIRM"])
def test_unknown_or_legacy_modes_fall_back_to_confirm_with_warning_no_alias(tmp_path: Path, bad_mode: str) -> None:
    """Persisted/env unknown modes are safety fallback, not compatibility aliases."""

    result = _run_node(
        tmp_path,
        f"""
        import {{ pathToFileURL }} from "node:url";
        const mod = await import(pathToFileURL({json.dumps(str(EXTENSION))}).href + "?case=unknown-{bad_mode}-" + Date.now());
        const registeredTools = [];
        const warnings = [];
        const ctx = {{
          env: {{ LARVA_PI_AGENT_PERSONA_SWITCH: {json.dumps(bad_mode)} }},
          ui: {{
            setStatus: async () => undefined,
            notify: async (message, type) => warnings.push({{ message, type }}),
          }},
        }};
        const pi = {{
          registerCommand: () => undefined,
          registerTool: (tool) => registeredTools.push(tool.name),
          on: () => undefined,
        }};
        await mod.initializeExtension(ctx, pi);
        console.log(JSON.stringify({{
          registeredTools,
          warnings,
          decision: mod.decideToolCall("larva_persona_switch"),
        }}));
        """,
    )

    assert "larva_persona_switch" in result["registeredTools"], "confirm fallback keeps request surface available"
    assert result["decision"]["action"] == "allow"
    assert any("confirm" in item["message"] and "unknown" in item["message"].lower() for item in result["warnings"])
    assert not any(bad_mode in item["message"] and "mapped" in item["message"].lower() for item in result["warnings"])


def test_manual_mode_rejects_autonomous_tools_but_preserves_manual_slash_switch_without_lease(tmp_path: Path) -> None:
    """manual forbids agent/runtime switching; user `/larva-persona` still wins."""

    result = _run_node(
        tmp_path,
        f"""
        import {{ mkdtemp, writeFile }} from "node:fs/promises";
        import {{ tmpdir }} from "node:os";
        import {{ join }} from "node:path";
        import {{ pathToFileURL }} from "node:url";
        const dir = await mkdtemp(join(tmpdir(), "larva-manual-mode-"));
        const cli = join(dir, "fake-larva-cli.mjs");
        await writeFile(cli, `
        const [, , command, personaId, jsonFlag] = process.argv;
        if (command !== "resolve" || jsonFlag !== "--json") process.exit(3);
        process.stdout.write(JSON.stringify({{ data: {{
          id: personaId, description: "Persona " + personaId, prompt: "Prompt " + personaId,
          model: "provider/model", capabilities: {{}}, spec_version: "0.1.0", spec_digest: "sha256:" + personaId
        }} }}));
        `, "utf8");
        const mod = await import(pathToFileURL({json.dumps(str(EXTENSION))}).href + "?case=manual-" + Date.now());
        const tools = [];
        const commands = {{}};
        const ctx = {{
          env: {{ LARVA_PI_AGENT_PERSONA_SWITCH: "manual", LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, cli]) }},
          ui: {{ setStatus: async () => undefined, notify: async () => undefined }},
          modelRegistry: {{ find: async () => ({{ id: "model" }}) }},
        }};
        const pi = {{
          getAllTools: async () => ["read", "larva_persona_switch", "larva_personas"],
          setActiveTools: async () => true,
          setModel: async () => true,
          registerCommand: (name, options) => {{ commands[name] = options; }},
          registerTool: (tool) => tools.push(tool.name),
          on: () => undefined,
        }};
        await mod.initializeExtension(ctx, pi);
        const forged = await mod.larva_persona_switch({{ persona_id: "target", reason: "forged stale call" }}, ctx, pi);
        const manual = await commands["larva-persona"].handler("target", ctx);
        console.log(JSON.stringify({{
          tools,
          decision: mod.decideToolCall("larva_persona_switch"),
          forged,
          manual,
          envelope: mod.getActiveEnvelope(),
          prompt: mod.before_agent_start({{ systemPrompt: "base" }}),
        }}));
        """,
    )

    assert "larva_persona_switch" not in result["tools"]
    assert "larva_personas" not in result["tools"]
    assert result["decision"]["action"] == "deny"
    assert result["forged"]["status"] == "failed"
    assert result["forged"]["error"]["code"] == "LARVA_AGENT_PERSONA_SWITCH_MANUAL"
    assert result["manual"]["ok"] is True
    assert result["envelope"]["persona_id"] == "target"
    assert "PersonaLease" not in json.dumps(result)


def test_confirm_mode_requires_four_outcomes_and_defaults_to_borrow_once() -> None:
    """confirm is confirmation before temporary borrow, not persistent ask mode."""

    source = _source()
    for choice in CONFIRM_CHOICES:
        assert choice in source
    assert "Borrow persona?" in source
    assert "Borrow once" in source and "default" in source.lower()
    assert "createTurnScopedPersonaLease" in source or "scope: \"turn\"" in source
    assert "Deny" in source and "do not change persona, model, or tool state" in source
    assert "Auto-borrow for this session" in source and "session-local mode override" in source
    assert "Switch persistently" in source and "clear any active lease" in source
    assert "fails safely without changing the active persona" in source or "LARVA_CONFIRMATION_UNAVAILABLE" in source


@pytest.mark.parametrize("choice", CONFIRM_CHOICES)
def test_confirm_mode_runtime_outcomes(choice: str) -> None:
    """Each confirmation button must map to the documented state transition."""

    source = _source()
    outcome_map = {
        "Borrow once": ("turn", "restore", "originPersonaId"),
        "Deny": ("unchanged", "persona", "tools"),
        "Auto-borrow for this session": ("confirm -> auto", "session", "override"),
        "Switch persistently": ("manual", "persistent", "clear"),
    }
    for token in outcome_map[choice]:
        assert token in source, f"missing confirm outcome token {token!r} for {choice!r}"


def test_confirm_mode_borrow_dialog_uses_string_select_labels_and_maps_borrow_once(tmp_path: Path) -> None:
    """Pi select gets readable string rows, and the default label maps to borrow_once."""

    result = _run_confirm_borrow_dialog_scenario(tmp_path, json.dumps("Borrow once"))

    assert result["selectOptions"] == list(CONFIRM_CHOICES)
    assert result["selectOptionTypes"] == ["string"] * len(CONFIRM_CHOICES)
    assert "[object Object]" not in json.dumps(result["selectOptions"])
    assert result["resultStatus"] == "success"
    assert result["afterPersona"] == "target"
    assert result["lease"]["borrowedPersonaId"] == "target"
    assert result["lease"]["originPersonaId"] == "origin"


def test_confirm_mode_borrow_dialog_deny_label_is_visible_and_maps_to_deny_without_state_change(tmp_path: Path) -> None:
    """The visible Deny row is selectable and preserves persona/model/tool state."""

    result = _run_confirm_borrow_dialog_scenario(tmp_path, json.dumps("Deny"))

    assert result["selectOptions"] == list(CONFIRM_CHOICES)
    assert "Deny" in result["selectOptions"]
    assert result["resultStatus"] == "failed"
    assert result["errorCode"] == "LARVA_BAD_INPUT"
    assert result["beforePersona"] == "origin"
    assert result["afterPersona"] == "origin"
    assert result["setModelCallCount"] == 0
    assert result["activeToolCallCount"] == 0


@pytest.mark.parametrize("selected_expression", ["undefined", json.dumps("Unknown selection")])
def test_confirm_mode_borrow_dialog_cancel_or_unknown_selection_fails_safe_as_deny(tmp_path: Path, selected_expression: str) -> None:
    """Cancel/timeout and unexpected labels deny without mutating persona/model/tools."""

    result = _run_confirm_borrow_dialog_scenario(tmp_path, selected_expression)

    assert result["selectOptions"] == list(CONFIRM_CHOICES)
    assert result["resultStatus"] == "failed"
    assert result["errorCode"] == "LARVA_BAD_INPUT"
    assert result["beforePersona"] == "origin"
    assert result["afterPersona"] == "origin"
    assert result["setModelCallCount"] == 0
    assert result["activeToolCallCount"] == 0


def test_confirm_mode_borrow_dialog_accepts_legacy_object_id_return_with_string_options(tmp_path: Path) -> None:
    """A host returning an old object-shaped {id} selection still maps safely."""

    result = _run_confirm_borrow_dialog_scenario(tmp_path, '({ id: "borrow_once", label: "Borrow once" })')

    assert result["selectOptions"] == list(CONFIRM_CHOICES)
    assert result["selectOptionTypes"] == ["string"] * len(CONFIRM_CHOICES)
    assert result["resultStatus"] == "success"
    assert result["afterPersona"] == "target"
    assert result["lease"]["borrowedPersonaId"] == "target"
    assert result["lease"]["originPersonaId"] == "origin"


def test_auto_mode_is_temporary_borrow_with_turn_end_restore() -> None:
    """auto means runtime-enforced temporary borrow and assistant-turn-end restore."""

    source = _source()
    assert 'agentPersonaSwitchMode === "auto"' in source
    assert "PersonaLease" in source
    assert "originPersonaId" in source
    assert "borrowedPersonaId" in source
    assert "scope" in source and "turn" in source
    assert "assistant turn" in source.lower()
    assert "restore" in source.lower()
    assert "terminate" not in source[source.find("larva_persona_switch") : source.find("larva_personas", source.find("larva_persona_switch"))]


def test_free_mode_is_persistent_switch_without_automatic_restore() -> None:
    """free is the only unconfirmed persistent agent/runtime switch mode."""

    source = _source()
    assert 'agentPersonaSwitchMode === "free"' in source
    assert "persistent" in source.lower()
    assert "No persona lease is created" in source or "lease" in source and "free" in source
    assert "No automatic restore" in source or "automatic restore" in source and "free" in source
    assert "free" in source and "only mode" in source.lower()


def test_persona_switch_guidance_requires_inspected_description_not_name_guessing() -> None:
    """Prompt/tool guidance must ground persona switching in inspected definitions."""

    source = _source()
    guidance_start = source.find("const PERSONA_SWITCH_GROUNDING_GUIDANCE")
    guidance_end = source.find("export function replaceLarvaWatermark", guidance_start)
    guidance_window = source[guidance_start:guidance_end]
    tool_start = source.find("const switchSchema")
    tool_end = source.find('name: "larva_personas"', tool_start)
    tool_window = source[tool_start:tool_end]

    assert "inspect candidate persona descriptions or resolved definitions" in guidance_window
    assert "persona id/name alone is not suitability evidence" in guidance_window
    assert "reason must cite the inspected description/definition" in guidance_window
    assert "do not switch automatically" in guidance_window
    assert "Do not call this tool until you have inspected" in tool_window
    assert "do not infer suitability from persona id/name alone" in tool_window
    assert "exact persona id/name only proves target identity, not semantic suitability" in tool_window
    assert "use persona discovery/resolve first" in tool_window


def test_manual_user_switch_during_active_lease_clears_lease_and_prevents_old_origin_restore() -> None:
    """Explicit user `/larva-persona` wins over lease origin and future restore."""

    source = _source()
    assert "clearActivePersonaLease" in source or "activePersonaLease = null" in source
    assert "source: \"slash-command\"" in source
    assert "manual switch" in source.lower() and "clears" in source.lower()
    assert "do not later restore" in source.lower() or "skip restore" in source.lower()
    assert "originPersonaId" in source


@pytest.mark.parametrize("terminal_path", TERMINAL_RESTORE_PATHS)
def test_restore_attempted_on_all_terminal_paths(terminal_path: str) -> None:
    """Any active lease must attempt restore on success/failure/cancel/timeout."""

    source = _source().lower()
    assert "restore" in source
    assert "active lease" in source or "personalease" in source
    assert terminal_path in source
    assert 'pi.on?.("agent_end"' in source or 'pi.on("agent_end"' in source


def test_agent_end_cancellation_restores_turn_scoped_persona_lease(tmp_path: Path) -> None:
    """Esc/abort terminal events must restore auto-borrowed personas via agent_end."""

    result = _run_node(
        tmp_path,
        f"""
        import {{ mkdtemp, writeFile }} from "node:fs/promises";
        import {{ tmpdir }} from "node:os";
        import {{ join }} from "node:path";
        import {{ pathToFileURL }} from "node:url";
        const dir = await mkdtemp(join(tmpdir(), "larva-agent-end-restore-"));
        const cli = join(dir, "fake-larva-cli.mjs");
        await writeFile(cli, `
        const [, , command, personaId, jsonFlag] = process.argv;
        if (command !== "resolve" || jsonFlag !== "--json") process.exit(3);
        process.stdout.write(JSON.stringify({{ data: {{
          id: personaId, description: "Persona " + personaId, prompt: "Prompt " + personaId,
          model: "provider/model", capabilities: {{}}, spec_version: "0.1.0", spec_digest: "sha256:" + personaId,
          can_spawn: true
        }} }}));
        `, "utf8");
        const mod = await import(pathToFileURL({json.dumps(str(EXTENSION))}).href + "?case=agent-end-restore-" + Date.now());
        const handlers = {{}};
        const statuses = [];
        const entries = [];
        const ctx = {{
          env: {{ LARVA_PI_AGENT_PERSONA_SWITCH: "auto", LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, cli]) }},
          ui: {{ setStatus: async (...args) => statuses.push(args), notify: async () => undefined }},
          modelRegistry: {{ find: async () => ({{ id: "model" }}) }},
        }};
        const pi = {{
          getAllTools: async () => ["read", "bash", "larva_persona_switch", "larva_personas"],
          setActiveTools: async () => true,
          setModel: async () => true,
          appendEntry: (customType, data) => entries.push({{ customType, data }}),
          registerCommand: () => undefined,
          registerTool: () => undefined,
          on: (name, handler) => {{ handlers[name] = handler; }},
        }};
        await mod.initializeExtension(ctx, pi);
        await mod.commitPersona("origin", ctx, pi);
        const switched = await mod.larva_persona_switch({{ persona_id: "target", reason: "test turn-scoped cancellation restore" }}, ctx, pi);
        const during = mod.getActiveEnvelope()?.persona_id ?? null;
        await handlers.agent_end({{ messages: [{{ role: "assistant", stopReason: "aborted", content: [] }}] }}, ctx);
        const after = mod.getActiveEnvelope()?.persona_id ?? null;
        console.log(JSON.stringify({{
          switchedStatus: switched.status,
          during,
          after,
          statusTexts: statuses.map((args) => args.filter((value) => typeof value === "string").join(" ")),
          restoreAudit: entries.some((entry) => entry.customType === "larva-agent-persona-switch-audit" && entry.data?.event === "restore" && entry.data?.terminal === "cancellation" && entry.data?.restored === true),
        }}));
        """,
    )

    assert result["switchedStatus"] == "success"
    assert result["during"] == "target"
    assert result["after"] == "origin"
    assert result["restoreAudit"] is True
    assert any("Restored persona: origin" in text for text in result["statusTexts"])


def test_restore_notices_never_chat_body() -> None:
    """Restore notices belong only in status/event/audit, never assistant text."""

    source = _source()
    assert "Restored persona:" in source
    assert "setStatus" in source or "appendSessionCustomEntry" in source
    assert "audit" in source.lower()
    assert "assistant chat" in source.lower() or "chat-body" in source.lower()
    assert "sendUserMessage" not in source[source.find("restore") : source.find("restore") + 1500]


def test_restore_failure_reports_preserves_state_requires_user_choice_and_has_no_safe_default() -> None:
    """Restore failure must be visible and block further persona changes until user choice."""

    source = _source()
    assert "LARVA_PERSONA_RESTORE_FAILED" in source
    assert "preserve current runtime state" in source.lower() or "restoreFailureState" in source
    assert "audit" in source.lower()
    assert "explicit user persona choice" in source.lower()
    assert "safe-default" in source.lower() or "safe default" in source.lower()
    assert "fallbackPersona" not in source


def test_generic_deterministic_tasks_do_not_own_persona_leases_agent_session_is_model_context_only() -> None:
    """Only model-calling agent contexts may own agent_session leases."""

    source = _source()
    assert "agent_session" in source
    assert "calls a model" in source or "model-calling" in source
    assert "deterministic" in source and "no persona" in source.lower()
    for generic_task in ("status", "wait", "events", "select", "cancel"):
        window_start = source.find(f"larva_subagent_{generic_task}")
        if window_start != -1:
            assert "PersonaLease" not in source[window_start : window_start + 1200]


def test_async_subagent_constraints_are_preserved_while_adding_persona_policy() -> None:
    """Persona switch policy tests must not relax async subagent authority."""

    readme = _document(PI_EXTENSION_README)
    design = _document(PI_INTEGRATION_DESIGN)
    source = _source()
    combined = "\n".join([readme, design, source])

    assert '"larva-log"' not in source
    assert "/larva-log" not in readme
    for token in ASYNC_SUBAGENT_CONSTRAINT_TOKENS:
        assert token in combined, f"missing preserved async subagent constraint {token!r}"
    assert "larva_subagent_wait" in source
    assert "larva_subagent_select" in source
    assert "larva_subagent_events" in source
    assert "cache/sidecar authority" not in source.lower()
