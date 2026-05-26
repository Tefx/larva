"""Focused static coverage for Pi extension adapter-local tool policy.

These tests protect policy target 14-17 semantics without requiring a real Pi
runtime or TypeScript toolchain in the Python test environment.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Final

ROOT: Final = Path(__file__).resolve().parents[2]
EXTENSION: Final = ROOT / "contrib" / "pi-extension" / "larva.ts"


def _source() -> str:
    return EXTENSION.read_text(encoding="utf-8")


def test_tool_call_empty_allow_denies_when_persona_policy_committed() -> None:
    source = _source()
    decision_match = re.search(
        r"export function decideToolCall\(tool: string\): ToolPolicyDecision \{(?P<body>[\s\S]*?)\n\}",
        source,
    )
    assert decision_match is not None
    body = decision_match.group("body")

    assert "!state.envelope" in body
    assert "state.activeTools.size === 0" not in body
    assert "state.activeTools.has(tool)" in body
    assert "LARVA_TOOL_DENIED" in body


def test_policy_filter_uses_exact_current_baseline_and_deny_wins() -> None:
    source = _source()
    filter_match = re.search(
        r"export function filterPolicyTools\(baseline: string\[], policy: PiToolPolicy\): string\[] \{(?P<body>[\s\S]*?)\n\}",
        source,
    )
    assert filter_match is not None
    body = filter_match.group("body")

    assert "new Set(baseline)" in body
    assert "existing.has(name)" in body
    assert "policy.allow === undefined ? baseline" in body
    assert "!denied.has(name)" in body


def test_policy_parser_validates_only_active_entry_and_normalizes_duplicates() -> None:
    source = _source()
    load_match = re.search(
        r"async function loadPolicy\(personaId: string, env: RuntimeEnv\): Promise<PiToolPolicy> \{(?P<body>[\s\S]*?)\n\}",
        source,
    )
    assert load_match is not None
    body = load_match.group("body")

    assert "LARVA_PI_TOOL_POLICY_FILE" in body
    assert "parsed.personas[personaId]" in body
    assert "if (target === undefined) return {}" in body
    assert "key !== \"allow\" && key !== \"deny\"" in body
    assert "normalizePolicyArray" in body
    assert "Array.from(new Set(value))" in source


def test_commit_validates_policy_before_model_mutation_and_restores_tools() -> None:
    source = _source()
    commit_match = re.search(
        r"export async function commitPersona\(personaId: string, ctx: PiContext, pi: PiApi = ctx\): Promise<PersonaSwitchResult> \{(?P<body>[\s\S]*?)\n\}",
        source,
    )
    assert commit_match is not None
    body = commit_match.group("body")

    assert body.index("const baseline = await enumerateTools(pi)") < body.index("const tool_policy = await loadPolicy")
    assert body.index("const tool_policy = await loadPolicy") < body.index("await validateModel(spec, ctx, pi)")
    assert "rollbackTools" in body
    assert "await pi.setActiveTools?.(rollbackTools)" in body
