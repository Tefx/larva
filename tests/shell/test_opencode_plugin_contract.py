"""Contract tests for the OpenCode plugin hardening path.

These tests pin wrapper/plugin behavior with narrow source-structure checks
against ``contrib/opencode-plugin/larva.ts``.  They document that startup
projection is separate from selected-id runtime refresh and that export-all is
not runtime semantic authority.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import textwrap
from pathlib import Path
from typing import Any

import pytest

PLUGIN = Path(__file__).resolve().parents[2] / "contrib" / "opencode-plugin" / "larva.ts"
PYPROJECT = Path(__file__).resolve().parents[2] / "pyproject.toml"


def _run_node(
    tmp_path: Path,
    script: str,
    *,
    timeout: float = 3.0,
) -> dict[str, Any]:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is required for OpenCode plugin runtime contract tests")

    script_path = tmp_path / "scenario.mjs"
    script_path.write_text(textwrap.dedent(script), encoding="utf-8")
    completed = subprocess.run(
        [node, str(script_path)],
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    assert completed.returncode == 0, completed.stderr
    return json.loads(completed.stdout)


def _runtime_plugin_copy(tmp_path: Path, appended_exports: str) -> Path:
    plugin = tmp_path / "larva-runtime-test.ts"
    plugin.write_text(
        _source() + "\n" + textwrap.dedent(appended_exports),
        encoding="utf-8",
    )
    return plugin


def _source() -> str:
    return PLUGIN.read_text(encoding="utf-8")


def _never_resolving_dollar_script() -> str:
    return r'''
        function createDollar(spec) {
          const stats = { killed: 0, resolveStarted: 0 };
          const stdout = (text) => Promise.resolve({ stdout: { toString: () => text } });
          const reject = (message) => Promise.reject(new Error(message));

          function neverResolvingResolve() {
            const promise = new Promise(() => {});
            promise.kill = () => { stats.killed += 1; };
            return promise;
          }

          const dollar = (strings, ...values) => ({
            quiet() {
              const commandStart = String(strings[0]);
              const args = values.find((value) => Array.isArray(value)) ?? [];
              if (commandStart.startsWith("cat ")) return reject("fixture file absent");
              if (
                commandStart.startsWith("larva ") ||
                commandStart.startsWith("uvx larva ") ||
                commandStart.startsWith("uv run")
              ) {
                if (args[0] === "export") {
                  return stdout(JSON.stringify({ data: [spec] }));
                }
                if (args[0] === "resolve") {
                  stats.resolveStarted += 1;
                  return neverResolvingResolve();
                }
              }
              return reject(`unexpected command: ${commandStart}`);
            },
          });
          dollar.stats = stats;
          return dollar;
        }

        function assert(condition, message) {
          if (!condition) throw new Error(message);
        }
    '''


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
    assert "LARVA_OPENCODE_RESOLVE_TIMEOUT_MS" in source
    assert "const CACHE_TTL_MS = 5 * 60_000" not in source


def test_plugin_resolve_timeout_env_parsing_default_override_invalid(tmp_path: Path) -> None:
    """Resolve timeout env uses default, accepts valid override, rejects invalid values."""
    runtime_plugin = _runtime_plugin_copy(
        tmp_path,
        """
        export {
          DEFAULT_RESOLVE_TIMEOUT_MS as __defaultResolveTimeoutMs,
          resolveTimeoutMs as __resolveTimeoutMs,
        };
        """,
    )

    result = _run_node(
        tmp_path,
        f"""
        const module = await import({json.dumps(runtime_plugin.as_uri())});
        delete process.env.LARVA_OPENCODE_RESOLVE_TIMEOUT_MS;
        const defaultValue = module.__resolveTimeoutMs();
        process.env.LARVA_OPENCODE_RESOLVE_TIMEOUT_MS = "37";
        const validOverride = module.__resolveTimeoutMs();
        process.env.LARVA_OPENCODE_RESOLVE_TIMEOUT_MS = "invalid";
        const invalidFallback = module.__resolveTimeoutMs();
        process.env.LARVA_OPENCODE_RESOLVE_TIMEOUT_MS = "0";
        const zeroFallback = module.__resolveTimeoutMs();
        process.env.LARVA_OPENCODE_RESOLVE_TIMEOUT_MS = "-1";
        const negativeFallback = module.__resolveTimeoutMs();

        console.log(JSON.stringify({{
          defaultConstant: module.__defaultResolveTimeoutMs,
          defaultValue,
          validOverride,
          invalidFallback,
          zeroFallback,
          negativeFallback,
        }}));
        """,
    )

    assert result == {
        "defaultConstant": 5_000,
        "defaultValue": 5_000,
        "validOverride": 37,
        "invalidFallback": 5_000,
        "zeroFallback": 5_000,
        "negativeFallback": 5_000,
    }


def test_plugin_system_transform_times_out_to_stale_cached_prompt(tmp_path: Path) -> None:
    """A hung runtime resolve falls back to stale last-known-good prompt."""
    result = _run_node(
        tmp_path,
        f"""
        {_never_resolving_dollar_script()}

        process.env.LARVA_OPENCODE_DEBUG = "1";
        process.env.LARVA_OPENCODE_RESOLVE_TIMEOUT_MS = "25";
        process.env.LARVA_OPENCODE_CACHE_TTL_MS = "60000";

        const module = await import({json.dumps(PLUGIN.as_uri())});
        const spec = {{
          id: "python-senior",
          prompt: "cached senior prompt",
          spec_digest: "sha256:abcdef123456",
          model_params: {{ temperature: 0.2 }},
        }};
        const $ = createDollar(spec);
        const hooks = await module.default({{ $, directory: "/tmp/no-larva-project" }});
        await hooks.config({{}});

        process.env.LARVA_OPENCODE_CACHE_TTL_MS = "0";
        const output = {{ system: ["before [larva:python-senior] after"] }};
        const started = performance.now();
        await hooks["experimental.chat.system.transform"]({{ sessionID: "s1" }}, output);
        const elapsedMs = performance.now() - started;

        assert(elapsedMs < 750, `transform blocked too long: ${{elapsedMs}}ms`);
        assert(output.system[0].includes("cached senior prompt"), "stale prompt missing");
        assert(output.system[0].includes("stale"), "stale watermark missing");
        assert(!output.system[0].includes("[larva:python-senior]"), "placeholder leaked");
        assert($.stats.resolveStarted === 1, "resolve mock was not exercised");
        assert($.stats.killed === 1, "hung resolve was not killed");

        console.log(JSON.stringify({{ elapsedMs, system: output.system[0] }}));
        """,
    )

    assert result["elapsedMs"] < 750
    assert "cached senior prompt" in result["system"]
    assert "stale" in result["system"]


def test_plugin_system_transform_times_out_to_fail_closed_without_cache(tmp_path: Path) -> None:
    """A first request with hung resolve fails closed instead of leaking placeholder."""
    result = _run_node(
        tmp_path,
        f"""
        {_never_resolving_dollar_script()}

        process.env.LARVA_OPENCODE_DEBUG = "1";
        process.env.LARVA_OPENCODE_RESOLVE_TIMEOUT_MS = "25";
        process.env.LARVA_OPENCODE_CACHE_TTL_MS = "0";

        const module = await import({json.dumps(PLUGIN.as_uri())});
        const $ = createDollar({{ id: "unused", prompt: "unused" }});
        const hooks = await module.default({{ $, directory: "/tmp/no-larva-project" }});
        const output = {{ system: ["before [larva:missing] after"] }};
        const started = performance.now();
        await hooks["experimental.chat.system.transform"]({{ sessionID: "s2" }}, output);
        const elapsedMs = performance.now() - started;

        assert(elapsedMs < 750, `transform blocked too long: ${{elapsedMs}}ms`);
        assert(
          output.system[0].includes("[larva prompt unavailable for missing"),
          "fail-closed prompt missing",
        );
        assert(!output.system[0].includes("[larva:missing]"), "placeholder leaked");
        assert($.stats.resolveStarted === 1, "resolve mock was not exercised");
        assert($.stats.killed === 1, "hung resolve was not killed");

        console.log(JSON.stringify({{ elapsedMs, system: output.system[0] }}));
        """,
    )

    assert result["elapsedMs"] < 750
    assert "[larva prompt unavailable for missing" in result["system"]
    assert "[larva:missing]" not in result["system"]


def test_plugin_chat_params_timeout_does_not_block_request_preparation(tmp_path: Path) -> None:
    """A hung resolve in chat.params returns promptly so provider prep can continue."""
    result = _run_node(
        tmp_path,
        f"""
        {_never_resolving_dollar_script()}

        process.env.LARVA_OPENCODE_DEBUG = "1";
        process.env.LARVA_OPENCODE_RESOLVE_TIMEOUT_MS = "25";
        process.env.LARVA_OPENCODE_CACHE_TTL_MS = "0";

        const module = await import({json.dumps(PLUGIN.as_uri())});
        const spec = {{
          id: "python-senior",
          prompt: "startup-only prompt",
          model_params: {{ temperature: 0.9 }},
        }};
        const $ = createDollar(spec);
        const hooks = await module.default({{ $, directory: "/tmp/no-larva-project" }});
        await hooks.config({{}});

        const output = {{}};
        const started = performance.now();
        await hooks["chat.params"]({{ agent: "python-senior", sessionID: "s3" }}, output);
        const elapsedMs = performance.now() - started;

        assert(elapsedMs < 750, `chat.params blocked too long: ${{elapsedMs}}ms`);
        assert(
          output.temperature === undefined,
          "timed-out first resolve should not invent params",
        );
        assert($.stats.resolveStarted === 1, "resolve mock was not exercised");
        assert($.stats.killed === 1, "hung resolve was not killed");

        console.log(JSON.stringify({{ elapsedMs, output }}));
        """,
    )

    assert result["elapsedMs"] < 750
    assert result["output"] == {}


def test_opencode_plugin_packaged_path_force_includes_source_plugin() -> None:
    """Wheel packaging must include the fixed plugin source at the runtime path."""
    pyproject = PYPROJECT.read_text(encoding="utf-8")

    assert (
        '"contrib/opencode-plugin/larva.ts" = "larva/shell/opencode_plugin/larva.ts"'
        in pyproject
    )


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
