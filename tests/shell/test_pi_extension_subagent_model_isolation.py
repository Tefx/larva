"""Regression proofs for child Pi model isolation from shared settings."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import textwrap
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
EXTENSION = ROOT / "contrib" / "pi-extension" / "larva.ts"
SMOKE = ROOT / "scripts" / "pi-subagent-model-isolation-smoke.mjs"


def _run_node(tmp_path: Path, source: str, *, timeout: int = 15) -> dict[str, object]:
    script = tmp_path / "model-isolation-contract.mjs"
    script.write_text(source, encoding="utf-8")
    completed = subprocess.run(
        ["node", str(script)],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout,
        env={**os.environ, "LARVA_PI_INITIAL_PERSONA_ID": "", "LARVA_PI_LAUNCHED": "0"},
    )
    assert completed.returncode == 0, completed.stderr
    return json.loads(completed.stdout)


def test_cli_selected_child_startup_commits_prompt_and_tools_without_set_model(
    tmp_path: Path,
) -> None:
    """A child whose model came from Pi ``--model`` must not call persistent ``pi.setModel``."""

    fake_cli = tmp_path / "fake-larva-cli.mjs"
    fake_cli.write_text(
        textwrap.dedent(
            """
            const [, , command, personaId, jsonFlag] = process.argv;
            if (command !== "resolve" || jsonFlag !== "--json") process.exit(3);
            process.stdout.write(JSON.stringify({ data: {
              id: personaId,
              description: "CLI-selected child",
              prompt: "Child prompt",
              model: "provider/model-a",
              capabilities: {},
              spec_version: "0.1.0",
              spec_digest: "sha256:" + "a".repeat(64),
              can_spawn: true
            } }));
            """
        ),
        encoding="utf-8",
    )
    payload = _run_node(
        tmp_path,
        f"""
        const mod = await import({json.dumps(EXTENSION.as_uri())});
        const modelCalls = [];
        const activeToolCalls = [];
        const ctx = {{
          env: {{
            HOME: {json.dumps(str(tmp_path))},
            LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, {json.dumps(str(fake_cli))}]),
            LARVA_PI_INITIAL_PERSONA_ID: "child",
            LARVA_PI_INITIAL_PERSONA_MODEL_FROM_CLI: "provider/model-a",
            LARVA_PI_LAUNCHED: "1",
          }},
          model: {{ provider: "provider", id: "model-a" }},
          modelRegistry: {{ find: async (provider, id) => ({{ provider, id }}) }},
          ui: {{ setStatus: () => undefined, notify: () => undefined }},
        }};
        const pi = {{
          getAllTools: async () => ["read", "larva_subagent"],
          setActiveTools: async (tools) => {{ activeToolCalls.push(tools); return true; }},
          setModel: async (model) => {{ modelCalls.push(model); return true; }},
          registerTool: () => undefined,
          registerCommand: () => undefined,
          on: () => undefined,
        }};
        await mod.initializeExtension(ctx, pi);
        console.log(JSON.stringify({{
          envelope: mod.getActiveEnvelope(),
          modelCalls,
          activeToolCalls,
          prompt: mod.before_agent_start({{ systemPrompt: "base" }})?.systemPrompt ?? "",
        }}));
        """,
    )

    assert payload["envelope"]["persona_id"] == "child"  # type: ignore[index]
    assert payload["modelCalls"] == []
    assert payload["activeToolCalls"]
    assert "Child prompt" in payload["prompt"]


def test_child_model_isolation_documentation_stays_in_sync() -> None:
    """Operator, design, and async references describe the same isolation mechanism."""

    documents = (
        ROOT / "README.md",
        ROOT / "contrib" / "pi-extension" / "README.md",
        ROOT / "design" / "pi-coding-agent-integration.md",
        ROOT / "docs" / "reference" / "PI_EXTENSION_ASYNC_SUBAGENTS.md",
    )
    for document in documents:
        text = document.read_text(encoding="utf-8")
        assert "--model" in text, document
        assert "LARVA_PI_INITIAL_PERSONA_MODEL_FROM_CLI" in text, document
        assert "pi.setModel()" in text, document
        assert "settings" in text.lower(), document


def test_real_pi_child_models_never_mutate_shared_settings() -> None:
    """Real Pi proves concurrent, cancellation, failure, and parent-isolation behavior."""

    pi_binary = shutil.which("pi")
    if pi_binary is None:
        pytest.skip("real Pi binary is unavailable")
    completed = subprocess.run(
        ["node", str(SMOKE)],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
        timeout=60,
        env={**os.environ, "LARVA_TEST_PI_BIN": pi_binary},
    )
    assert completed.returncode == 0, completed.stderr
    evidence = json.loads(completed.stdout)
    assert evidence["observedHashes"] == [evidence["baselineHash"]]
    assert evidence["finalHash"] == evidence["baselineHash"]
    assert evidence["settingsEvents"] == []
    assert evidence["singleUsedModelA"] is True
    assert evidence["concurrentAssignedModels"] == {
        "alphaUsedModelA": True,
        "betaUsedModelB": True,
    }
    assert evidence["resumeUsedModelA"] is True
    assert evidence["cancelStatus"] == "cancelled"
    assert evidence["startupFailure"]["status"] == "failed"
    assert evidence["parentUnchanged"] is True
