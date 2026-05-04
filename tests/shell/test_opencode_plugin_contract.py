"""Contract tests for the OpenCode plugin hardening path.

These tests pin wrapper/plugin behavior with narrow source-structure checks
against ``contrib/opencode-plugin/larva.ts``.  They document that startup
projection is separate from selected-id runtime refresh and that export-all is
not runtime semantic authority.
"""

from __future__ import annotations

import re
from pathlib import Path


PLUGIN = Path(__file__).resolve().parents[2] / "contrib" / "opencode-plugin" / "larva.ts"


def _source() -> str:
    return PLUGIN.read_text(encoding="utf-8")


def test_plugin_selected_id_main_path_does_not_export_all() -> None:
    """Selected ``[larva:<id>]`` requests must resolve that id, not export all."""
    source = _source()

    assert '"export", "--all", "--json"' not in source
    assert re.search(r"resolve[^\n]+--json", source), (
        "selected-id runtime path should call larva resolve <id> --json"
    )


def test_plugin_cache_miss_stale_and_digest_change_use_single_id_resolve() -> None:
    """Cache misses, TTL staleness, and digest changes are per-id refreshes."""
    source = _source()

    assert "spec_digest" in source, "cache entries must remember PersonaSpec digest"
    assert "resolvePersona" in source, "single-id resolver seam is required"
    assert "digest" in source and "stale" in source, (
        "refresh logic should distinguish TTL stale from digest-change refresh"
    )


def test_plugin_deduplicates_concurrent_same_id_resolves() -> None:
    """Concurrent cache refreshes for one id should share one in-flight promise."""
    source = _source()

    assert "inFlight" in source
    assert re.search(r"Map<string,\s*Promise", source), (
        "same-id resolve calls should be deduplicated with a Promise map"
    )


def test_plugin_placeholder_never_leaks_when_prompt_unavailable() -> None:
    """A missing previous prompt is fail-closed, not a leaked placeholder."""
    source = _source()

    assert "failClosed" in source
    assert "[larva prompt unavailable" in source
    assert "skipping" not in source, (
        "system.transform must replace the placeholder or fail closed"
    )


def test_plugin_stale_last_known_good_fallback_warns_in_debug() -> None:
    """Stale last-known-good prompts may be used only with a debug warning."""
    source = _source()

    assert "lastKnownGood" in source
    assert "warn" in source
    assert "LARVA_OPENCODE_DEBUG" in source


def test_plugin_debug_and_ttl_are_controlled_by_environment() -> None:
    """Debug logging and cache TTL must be externally tunable env behavior."""
    source = _source()

    assert "LARVA_OPENCODE_DEBUG" in source
    assert "LARVA_OPENCODE_CACHE_TTL_MS" in source
    assert "const CACHE_TTL_MS = 5 * 60_000" not in source


def test_plugin_watermark_strings_remain_contractual() -> None:
    """The injected prompt keeps both larva identity watermark strings."""
    source = _source()

    assert '<larva-persona id="${id}" />' in source
    assert 'persona loaded from larva' in source


def test_plugin_hot_update_boundaries_are_explicit() -> None:
    """Hot updates refresh only runtime-safe fields for the selected persona."""
    source = _source()

    for token in (
        "HOT_UPDATE_FIELDS",
        "prompt",
        "temperature",
        "tool-policy",
        "capabilities",
        "can_spawn",
    ):
        assert token in source

    assert "model" not in re.search(
        r"HOT_UPDATE_FIELDS\s*=\s*[^;]+", source, re.DOTALL
    ).group(0), "model changes require OpenCode restart and must not hot-update"
    assert "added/deleted base ids and model/provider startup fields require" in source


def test_plugin_prompt_hot_updates_are_not_blocked_by_fresh_cache() -> None:
    """Runtime transform must resolve active variants instead of trusting startup cache."""
    source = _source()
    get_persona = re.search(
        r"async function getPersonaForRequest.*?\n}\n",
        source,
        re.DOTALL,
    ).group(0)

    assert "resolvePersona" in source
    assert "previous = cache.get(id)" in get_persona
    assert "isFresh" not in source
    assert "return { entry: previous" not in get_persona


def test_plugin_per_request_active_id_comes_from_selected_placeholder() -> None:
    """Per-request state should be keyed by the selected placeholder id."""
    source = _source()

    assert "selectedIdsBySession" in source
    assert "fallbackSelectedId" in source
    assert "selectedIdForToolCall(input)" in source
    assert "active = id" not in source, (
        "module-global active id can bleed across concurrent OpenCode requests"
    )


def test_plugin_tool_policy_uses_tool_call_session_id() -> None:
    """Tool denial must not inherit a stale subagent id from another session."""
    source = _source()

    assert "inputSessionId" in source
    assert "selectedIdsBySession.get(sessionID) ?? null" in source
    assert "rememberSelectedId(input, name)" in source
    assert "rememberSelectedId(input, selected.id)" in source


def test_plugin_startup_registration_has_no_global_active_variant() -> None:
    """Startup registration uses base ids and placeholders, not larva-active state."""
    source = _source()

    assert "config.agent[spec.id]" in source
    assert "prompt: placeholder(spec.id)" in source
    assert "larva-active" not in source
