"""Expected-red contracts for Pi PersonaCandidate cache semantics.

These tests intentionally pin the public-source-only projection and
stale-while-revalidate cache behavior before the Pi extension implementation
exists.  They must not read or write the operator's real home directory.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import textwrap
from pathlib import Path
from typing import Any, Final

import pytest

ROOT: Final = Path(__file__).resolve().parents[2]
EXTENSION: Final = ROOT / "contrib" / "pi-extension" / "larva.ts"
CACHE_OVERRIDE_ENV: Final = "LARVA_PI_PERSONA_CANDIDATES_CACHE_FILE"
CACHE_BASENAME: Final = "persona-candidates-cache.json"


def _source() -> str:
    assert EXTENSION.exists(), f"missing Pi extension at {EXTENSION}"
    return EXTENSION.read_text(encoding="utf-8")


def _run_node(tmp_path: Path, script: str, *, timeout: float = 4.0) -> dict[str, Any]:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is required for Pi extension runtime contract tests")

    script_path = tmp_path / "scenario.mjs"
    script_path.write_text(textwrap.dedent(script), encoding="utf-8")
    completed = subprocess.run(
        [node, str(script_path)],
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout,
        env={
            **os.environ,
            "HOME": str(tmp_path / "node-home"),
            "LARVA_PI_INITIAL_PERSONA_ID": "",
            "LARVA_PI_LAUNCHED": "0",
        },
    )
    assert completed.returncode == 0, completed.stderr
    return json.loads(completed.stdout)


def _write_list_fake_cli(tmp_path: Path) -> Path:
    fake_cli = tmp_path / "fake-larva-list-cli.mjs"
    fake_cli.write_text(
        textwrap.dedent(
            """
            import { appendFile, readFile } from "node:fs/promises";

            const [, , command, jsonFlag] = process.argv;
            await appendFile(process.env.FAKE_LARVA_INVOCATION_LOG, `${command} ${jsonFlag ?? ""}\n`);
            if (command !== "list" || jsonFlag !== "--json") process.exit(3);
            const delay = Number(process.env.FAKE_LARVA_DELAY_MS ?? "0");
            if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
            const data = JSON.parse(await readFile(process.env.FAKE_LARVA_LIST_FILE, "utf8"));
            process.stdout.write(JSON.stringify({ data }));
            """
        ),
        encoding="utf-8",
    )
    return fake_cli


def test_expected_red_persona_candidate_cache_surface_is_named_and_overridable() -> None:
    """Pin the public cache surface before implementation.

    PersonaCandidate is intentionally prompt-free and cache files live at the
    documented Pi cache path by default with an absolute test override so tests
    never touch a developer's real ``~/.pi`` tree.
    """

    source = _source()

    assert "PersonaCandidate" in source
    assert CACHE_BASENAME in source
    assert CACHE_OVERRIDE_ENV in source
    assert re.search(r"\.pi[\"']?,\s*[\"']larva[\"']?,\s*[\"']persona-candidates-cache\.json", source)


def test_persona_candidate_projection_uses_public_larva_list_json_only(tmp_path: Path) -> None:
    """Candidates come only from public ``larva list --json`` and never expose prompts."""

    source = _source()
    fetch_match = re.search(
        r"async function fetchPersonaList\(env: RuntimeEnv\): Promise<BridgeListItem\[] \| null> \{(?P<body>[\s\S]*?)\n\}",
        source,
    )
    assert fetch_match is not None
    fetch_body = fetch_match.group("body")
    assert 'runLarvaCommand(env, ["list", "--json"])' in fetch_body
    assert not re.search(r"\.larva[/\\]registry|registry\.json", source)

    fake_cli = _write_list_fake_cli(tmp_path)
    list_file = tmp_path / "list.json"
    list_file.write_text(
        json.dumps(
            [
                {
                    "id": "public-candidate",
                    "description": "Public description",
                    "model": "provider/model",
                    "spec_digest": "sha256:public",
                    "capabilities": {"shell": "read_only"},
                    "prompt": "SECRET PROMPT MUST NOT PROJECT",
                    "model_params": {"temperature": 0.7},
                    "can_spawn": True,
                    "compaction_prompt": "SECRET COMPACTION",
                    "spec_version": "0.1.0",
                }
            ]
        ),
        encoding="utf-8",
    )
    invocation_log = tmp_path / "invocations.log"
    home = tmp_path / "home"
    poisoned_registry = home / ".larva" / "registry"
    poisoned_registry.mkdir(parents=True)
    (poisoned_registry / "poison.json").write_text(
        json.dumps({"id": "poison", "prompt": "registry prompt"}),
        encoding="utf-8",
    )

    payload = _run_node(
        tmp_path,
        f"""
        const mod = await import({json.dumps(EXTENSION.as_uri())});
        mod.resetPersonaCompletionCache();
        mod.resetPersonaCompletionClock();
        const ctx = {{ env: {{
          HOME: {json.dumps(str(home))},
          LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, {json.dumps(str(fake_cli))}]),
          FAKE_LARVA_LIST_FILE: {json.dumps(str(list_file))},
          FAKE_LARVA_INVOCATION_LOG: {json.dumps(str(invocation_log))},
        }} }};
        const personas = await mod.listPersonas(ctx);
        const invocations = await (await import("node:fs/promises")).readFile({json.dumps(str(invocation_log))}, "utf8");
        console.log(JSON.stringify({{ personas, invocations: invocations.trim().split("\\n") }}));
        """,
    )

    assert payload["invocations"] == ["list --json"]
    assert payload["personas"] == [
        {
            "id": "public-candidate",
            "description": "Public description",
            "model": "provider/model",
            "spec_digest": "sha256:public",
            "capabilities": {"shell": "read_only"},
        }
    ]
    assert "prompt" not in json.dumps(payload["personas"])
    assert "SECRET" not in json.dumps(payload["personas"])


def test_expected_red_autocomplete_returns_stale_memory_without_awaiting_revalidation(tmp_path: Path) -> None:
    """Expired in-memory candidates are served immediately while CLI refresh runs."""

    fake_cli = _write_list_fake_cli(tmp_path)
    list_file = tmp_path / "list.json"
    invocation_log = tmp_path / "invocations.log"
    list_file.write_text(json.dumps([{"id": "cached", "description": "Old", "model": "provider/old"}]), encoding="utf-8")

    payload = _run_node(
        tmp_path,
        f"""
        const mod = await import({json.dumps(EXTENSION.as_uri())});
        const fs = await import("node:fs/promises");
        mod.resetPersonaCompletionCache();
        mod.setPersonaCompletionClock(() => 0);
        const ctx = {{ env: {{
          LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, {json.dumps(str(fake_cli))}]),
          FAKE_LARVA_LIST_FILE: {json.dumps(str(list_file))},
          FAKE_LARVA_INVOCATION_LOG: {json.dumps(str(invocation_log))},
          FAKE_LARVA_DELAY_MS: "0",
        }} }};
        await mod.listPersonas(ctx);
        await fs.writeFile({json.dumps(str(list_file))}, JSON.stringify([{{ id: "fresh", description: "New", model: "provider/new" }}]));
        ctx.env.FAKE_LARVA_DELAY_MS = "700";
        mod.setPersonaCompletionClock(() => 6000);
        const start = Date.now();
        const staleResult = await mod.completePersonaIds("", ctx);
        const elapsedMs = Date.now() - start;
        await new Promise((resolve) => setTimeout(resolve, 850));
        const refreshedResult = await mod.completePersonaIds("", ctx);
        const invocations = await fs.readFile({json.dumps(str(invocation_log))}, "utf8");
        console.log(JSON.stringify({{ staleResult, refreshedResult, elapsedMs, invocations: invocations.trim().split("\\n") }}));
        """,
        timeout=5,
    )

    assert payload["elapsedMs"] < 200
    assert payload["staleResult"] == [{"value": "cached", "label": "cached", "description": "Old"}]
    assert payload["refreshedResult"] == [{"value": "fresh", "label": "fresh", "description": "New"}]
    assert payload["invocations"].count("list --json") >= 2


def test_expected_red_disk_stale_cache_override_serves_without_real_home_or_prompt_leak(tmp_path: Path) -> None:
    """Disk SWR cache is prompt-free, overrideable, and non-blocking on hot paths."""

    fake_cli = _write_list_fake_cli(tmp_path)
    list_file = tmp_path / "list.json"
    invocation_log = tmp_path / "invocations.log"
    cache_file = tmp_path / "persona-candidates-cache.json"
    home = tmp_path / "home"
    list_file.write_text(
        json.dumps(
            [
                {
                    "id": "disk-fresh",
                    "description": "Disk fresh",
                    "model": "provider/fresh",
                    "spec_digest": "sha256:fresh",
                    "capabilities": {"fs": "read_write"},
                    "prompt": "SECRET PROMPT MUST NOT BE CACHED",
                }
            ]
        ),
        encoding="utf-8",
    )

    payload = _run_node(
        tmp_path,
        f"""
        const mod = await import({json.dumps(EXTENSION.as_uri())});
        const fs = await import("node:fs/promises");
        mod.resetPersonaCompletionCache();
        mod.setPersonaCompletionClock(() => 60_000);
        const ctx = {{ env: {{
          HOME: {json.dumps(str(home))},
          LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, {json.dumps(str(fake_cli))}]),
          {CACHE_OVERRIDE_ENV}: {json.dumps(str(cache_file))},
          FAKE_LARVA_LIST_FILE: {json.dumps(str(list_file))},
          FAKE_LARVA_INVOCATION_LOG: {json.dumps(str(invocation_log))},
          FAKE_LARVA_DELAY_MS: "700",
        }} }};
        await fs.writeFile({json.dumps(str(cache_file))}, JSON.stringify({{
          version: 1,
          source: "larva list --json",
          source_key: ctx.env.LARVA_CLI_ARGV_JSON,
          fetched_at_ms: 0,
          candidates: [{{
            id: "disk-stale",
            description: "Disk stale",
            model: "provider/stale",
            spec_digest: "sha256:stale",
            capabilities: {{ fs: "read_only" }},
          }}],
        }}));
        const start = Date.now();
        const result = await mod.completePersonaIds("", ctx);
        const elapsedMs = Date.now() - start;
        await new Promise((resolve) => setTimeout(resolve, 900));
        const cacheText = await fs.readFile({json.dumps(str(cache_file))}, "utf8");
        console.log(JSON.stringify({{ result, elapsedMs, cache: JSON.parse(cacheText), cacheText }}));
        """,
        timeout=5,
    )

    assert payload["elapsedMs"] < 200
    assert payload["result"] == [
        {"value": "disk-stale", "label": "disk-stale", "description": "Disk stale"}
    ]
    assert payload["cache"]["candidates"][0]["id"] == "disk-fresh"
    assert "prompt" not in payload["cacheText"]
    assert "SECRET" not in payload["cacheText"]
