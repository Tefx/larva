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


def test_thinking_policy_drives_explicit_persona_child_startup(tmp_path: Path) -> None:
    """Child startup resolves strict adapter policy and passes explicit thinking."""
    source = EXTENSION.read_text(encoding="utf-8")
    start_child = source.split("async function startChild", 1)[1].split(
        "function parseStartupError", 1
    )[0]

    assert "LARVA_PI_THINKING_POLICY_FILE" in source
    assert "schema_version" in source and "requested_thinking" in source
    assert '"--thinking"' in start_child
    assert "childThinkingArgument" in start_child

    fake_cli = tmp_path / "thinking-policy-cli.mjs"
    fake_cli.write_text(
        """
        const [, , command, personaId, jsonFlag] = process.argv;
        if (command !== "resolve" || jsonFlag !== "--json") process.exit(3);
        process.stdout.write(JSON.stringify({ data: {
          id: personaId, description: "thinking", prompt: "prompt", model: "provider/model-a",
          capabilities: {}, spec_version: "0.1.0", spec_digest: "sha256:" + "a".repeat(64)
        } }));
        """,
        encoding="utf-8",
    )
    policy = tmp_path / "thinking-policy.json"
    payload = _run_node(
        tmp_path,
        f"""
        const fs = await import("node:fs/promises");
        const mod = await import({json.dumps(EXTENSION.as_uri())});
        const calls = [];
        let thinking = "off";
        const env = {{ HOME: {json.dumps(str(tmp_path))}, LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, {json.dumps(str(fake_cli))}]), LARVA_PI_THINKING_POLICY_FILE: {json.dumps(str(policy))} }};
        const ctx = {{ env, modelRegistry: {{ find: async (provider, id) => ({{ provider, id }}) }}, ui: {{ setStatus: () => undefined }} }};
        const pi = {{
          getAllTools: async () => [], setActiveTools: async () => true, setModel: async () => true,
          getThinkingLevel: () => thinking,
          setThinkingLevel: (level) => {{ calls.push(level); thinking = level === "xhigh" ? "high" : level; }},
        }};
        await fs.rm({json.dumps(str(policy))}, {{ force: true }});
        const missing = await mod.commitPersona("worker", ctx, pi);
        await fs.writeFile({json.dumps(str(policy))}, JSON.stringify({{ schema_version: 1, default: "low", personas: {{ worker: "xhigh" }} }}));
        const override = await mod.commitPersona("worker", ctx, pi);
        await fs.writeFile({json.dumps(str(policy))}, JSON.stringify({{ schema_version: 1, default: "medium", personas: {{}}, extra: true }}));
        const invalid = await mod.commitPersona("worker", ctx, pi);
        console.log(JSON.stringify({{ missing, override, invalid, calls, thinking }}));
        """,
    )
    assert payload["missing"]["ok"] is True
    assert payload["calls"][0] == "medium"
    assert payload["override"]["ok"] is True
    assert payload["calls"][1] == "xhigh"
    assert payload["thinking"] == "high"
    assert payload["invalid"] == {
        "ok": False,
        "error": {
            "code": "LARVA_POLICY_INVALID",
            "message": "Thinking policy must contain exactly schema_version 1, default, and personas.",
        },
    }


def test_process_local_model_map_profile_is_inherited_by_new_child_process(
    tmp_path: Path,
) -> None:
    """A post-switch child validates the same profile snapshot used for ``--model``."""

    agent_dir = tmp_path / "agent"
    config_dir = tmp_path / ".pi" / "larva"
    child_sessions = tmp_path / "child-sessions"
    agent_dir.mkdir()
    config_dir.mkdir(parents=True)
    child_sessions.mkdir()
    canonical_map = config_dir / "model-map.json"
    profile_map = config_dir / "model-map.openrouter.json"
    canonical_map.write_text(
        json.dumps(
            {
                "models": {
                    "logical/parent": {"provider": "canonical", "model_id": "parent"},
                    "logical/child": {"provider": "canonical", "model_id": "child"},
                },
                "prefix_rules": [],
            }
        ),
        encoding="utf-8",
    )
    profile_map.write_text(
        json.dumps(
            {
                "models": {
                    "logical/parent": {"provider": "alternate", "model_id": "parent"},
                    "logical/child": {"provider": "alternate", "model_id": "child"},
                },
                "prefix_rules": [],
            }
        ),
        encoding="utf-8",
    )
    (config_dir / "model-map.codex.json").write_text(
        canonical_map.read_text(encoding="utf-8"), encoding="utf-8"
    )

    fake_cli = tmp_path / "profile-larva-cli.mjs"
    fake_cli.write_text(
        """
        const [, , command, personaId, jsonFlag] = process.argv;
        if (command !== "resolve" || jsonFlag !== "--json") process.exit(3);
        if (personaId === "child") await new Promise((resolve) => setTimeout(resolve, 50));
        const model = personaId === "parent" ? "logical/parent" : "logical/child";
        process.stdout.write(JSON.stringify({ data: {
          id: personaId, description: personaId, prompt: "prompt", model,
          capabilities: {}, spec_version: "0.1.0", spec_digest: "sha256:" + "a".repeat(64),
          can_spawn: true
        } }));
        """,
        encoding="utf-8",
    )
    observed_env = tmp_path / "observed-profile-path.txt"
    fake_pi = tmp_path / "fake-pi.mjs"
    fake_pi.write_text(
        textwrap.dedent(
            f"""\
            #!/usr/bin/env node
            import {{ appendFileSync, mkdirSync, readFileSync, writeFileSync }} from "node:fs";
            import {{ join }} from "node:path";
            import {{ createInterface }} from "node:readline";
            const args = process.argv.slice(2);
            const arg = (name) => args[args.indexOf(name) + 1];
            const persona = process.env.LARVA_PI_INITIAL_PERSONA_ID;
            const selectedMap = process.env.LARVA_PI_MODEL_MAP_FILE || join(process.env.HOME, ".pi", "larva", "model-map.json");
            const config = JSON.parse(readFileSync(selectedMap, "utf8"));
            const route = config.models["logical/child"];
            let currentProvider = route.provider;
            let currentModelId = route.model_id;
            const expected = currentProvider + "/" + currentModelId;
            const actual = arg("--model");
            appendFileSync({json.dumps(str(observed_env))}, selectedMap + "\\n", "utf8");
            if (actual !== expected) {{
              process.stderr.write("larva pi: LARVA_MODEL_UNAVAILABLE: initial persona 'child' route mismatch cli=" + actual + " profile=" + expected + "\\n");
              process.exit(2);
            }}
            if (persona === "startup-fail") {{
              process.stderr.write("larva pi: LARVA_MODEL_UNAVAILABLE: Initial persona route mismatch for startup-fail: cli=" + actual + " profile=missing/startup active=unavailable\\n");
              process.exit(2);
            }}
            const root = arg("--session-dir");
            mkdirSync(root, {{ recursive: true }});
            const sessionFile = join(root, "profile-child-" + process.pid + ".jsonl");
            writeFileSync(sessionFile, "", "utf8");
            const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
            createInterface({{ input: process.stdin }}).on("line", (line) => {{
              const message = JSON.parse(line);
              if (persona === "cleanup" && message.type === "get_state" && String(message.id).startsWith("model-map-previous-")) {{
                process.exit(0);
              }} else if (message.type === "set_model") {{
                currentProvider = message.provider;
                currentModelId = message.modelId;
                send({{ id: message.id, success: true, data: {{}} }});
              }} else if (message.type === "get_state") send({{ id: message.id, success: true, data: {{ sessionFile, model: {{ provider: currentProvider, id: currentModelId }}, thinkingLevel: arg("--thinking") }} }});
              else if (message.type === "prompt") {{
                send({{ id: message.id, success: true, data: {{}} }});
                if (persona !== "cleanup") setTimeout(() => send({{ type: "agent_end" }}), 5);
              }} else if (message.type === "get_last_assistant_text") {{
                send({{ id: message.id, success: true, data: {{ text: "PROFILE_CHILD_OK" }} }});
                setTimeout(() => process.exit(0), 5);
              }} else send({{ id: message.id, success: true, data: {{}} }});
            }});
            """
        ),
        encoding="utf-8",
    )
    fake_pi.chmod(0o755)

    payload = _run_node(
        tmp_path,
        f"""
        const mod = await import({json.dumps(EXTENSION.as_uri())});
        let thinking = "medium";
        const env = {{
          HOME: {json.dumps(str(tmp_path))},
          PI_CODING_AGENT_DIR: {json.dumps(str(agent_dir))},
          LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, {json.dumps(str(fake_cli))}]),
          LARVA_PI_LAUNCHED: "1",
          LARVA_PI_REAL_BIN: {json.dumps(str(fake_pi))},
          LARVA_PI_EXTENSION_FLAG: "-e",
          LARVA_PI_EXTENSION_ENTRY: {json.dumps(str(EXTENSION))},
          LARVA_PI_CHILD_SESSION_DIR: {json.dumps(str(child_sessions))},
        }};
        const ctx = {{ env, modelRegistry: {{ find: async (provider, modelId) => ({{ provider, modelId }}) }}, ui: {{ setStatus: () => undefined, notify: () => undefined }} }};
        const pi = {{
          getAllTools: async () => [], setActiveTools: async () => true,
          setModel: async () => true, getThinkingLevel: () => thinking,
          setThinkingLevel: (level) => {{ thinking = level; }},
        }};
        const parent = await mod.commitPersona("parent", ctx, pi);
        const switched = await mod.switchModelMapProfile("openrouter", ctx, pi);
        const child = await mod.larva_subagent({{ persona_id: "child", task: "return ok" }}, ctx);
        const racedChildPromise = mod.larva_subagent({{ persona_id: "child", task: "race switch against admission" }}, ctx);
        await new Promise((resolve) => setTimeout(resolve, 10));
        const codexSwitchPromise = mod.switchModelMapProfile("codex", ctx, pi);
        const [racedChild, codexSwitch] = await Promise.all([racedChildPromise, codexSwitchPromise]);
        const cleanupChild = await mod.larva_subagent({{ persona_id: "cleanup", task: "exit during profile switch" }}, ctx);
        const cleanupSwitch = await mod.switchModelMapProfile("openrouter", ctx, pi);
        const startupFailure = await mod.larva_subagent({{ persona_id: "startup-fail", task: "fail before RPC" }}, {{ ...ctx, presentationCallId: "startup-call-1" }});
        const startupStatus = await mod.larva_subagent_status({{ limit: 25 }}, ctx);
        const startupEvents = mod.larva_subagent_events({{ since_sequence: 0, limit: 100 }}, ctx);
        const startupId = startupStatus.details.startup_failures[0].startup_id;
        const exactTaskStatus = await mod.larva_subagent_status({{ task_id: child.task_id }}, ctx);
        const filteredTaskEvents = mod.larva_subagent_events({{ since_sequence: 0, task_ids: [child.task_id], limit: 100 }}, ctx);
        const provisionalStatus = await mod.larva_subagent_status({{ task_id: startupId }}, ctx);
        const provisionalCancel = await mod.larva_subagent_cancel({{ task_id: startupId, reason: "must not control provisional startup" }}, ctx);
        await new Promise((resolve) => setTimeout(resolve, 50));
        console.log(JSON.stringify({{ parent, switched, child, racedChild, codexSwitch, cleanupChild, cleanupSwitch, startupFailure, startupStatus, startupEvents, exactTaskStatus, filteredTaskEvents, provisionalStatus, provisionalCancel }}));
        """,
    )

    assert payload["parent"]["ok"] is True  # type: ignore[index]
    assert payload["switched"]["status"] == "success"  # type: ignore[index]
    assert payload["child"]["status"] == "accepted"  # type: ignore[index]
    assert payload["racedChild"]["status"] == "accepted"  # type: ignore[index]
    assert payload["codexSwitch"]["status"] == "success"  # type: ignore[index]
    assert payload["cleanupChild"]["status"] == "accepted"  # type: ignore[index]
    cleanup_rows = payload["cleanupSwitch"]["children"]  # type: ignore[index]
    assert any(row["persona_id"] == "cleanup" and row["state"] == "ended_during_switch" for row in cleanup_rows)
    assert payload["startupFailure"]["status"] == "failed"  # type: ignore[index]
    assert payload["startupFailure"]["task_id"] is None  # type: ignore[index]
    status_failures = payload["startupStatus"]["details"]["startup_failures"]  # type: ignore[index]
    event_failures = payload["startupEvents"]["details"]["startup_failures"]  # type: ignore[index]
    assert len(status_failures) == 1
    assert len(event_failures) == 1
    assert status_failures[0]["startup_id"].startswith("startup:")
    assert status_failures[0]["call_id"] == "startup-call-1"
    assert status_failures[0]["persona_id"] == "startup-fail"
    assert status_failures[0]["phase"] == "startup_failed"
    assert status_failures[0]["error"]["code"] == "LARVA_MODEL_UNAVAILABLE"
    assert event_failures[0] == status_failures[0]
    assert payload["exactTaskStatus"]["details"]["startup_failures"] == []  # type: ignore[index]
    assert payload["filteredTaskEvents"]["details"]["startup_failures"] == []  # type: ignore[index]
    assert payload["provisionalStatus"]["details"]["error"]["code"] == "LARVA_BAD_INPUT"  # type: ignore[index]
    assert payload["provisionalCancel"]["details"]["error"]["code"] == "LARVA_BAD_INPUT"  # type: ignore[index]
    assert str(payload["child"]["task_id"]).startswith(str(child_sessions.resolve()))  # type: ignore[index]
    assert str(payload["racedChild"]["task_id"]).startswith(str(child_sessions.resolve()))  # type: ignore[index]
    assert observed_env.read_text(encoding="utf-8").splitlines() == [
        str(profile_map),
        str(profile_map),
        str(config_dir / "model-map.codex.json"),
        str(profile_map),
    ]


def test_startup_error_diagnostic_is_bounded_sanitized_and_route_specific(tmp_path: Path) -> None:
    payload = _run_node(
        tmp_path,
        f"""
        const mod = await import({json.dumps(EXTENSION.as_uri())});
        const stderr = "\\u001b[31mlarva pi: LARVA_MODEL_UNAVAILABLE: Initial persona route mismatch for child: cli=alternate/child profile=canonical/child active=alternate/child api_key=super-secret Bearer abcdefghijklmnopqrstuvwxyz Basic dXNlcjpwYXNz Authorization: API-Key api-key-secret " + "x".repeat(1000) + "\\u0000\\u001b[0m\\nignored stderr";
        const jsonCredentials = '{{"api_key":"json-secret-123","password":"json-password-456","authorization":"Basic json-basic-789"}}';
        console.log(JSON.stringify({{ parsed: mod.parseStartupErrorForTests(stderr), tracePreview: mod.sanitizeChildDiagnosticForTests(stderr), jsonTracePreview: mod.sanitizeChildDiagnosticForTests(jsonCredentials) }}));
        """,
    )

    assert payload["parsed"]["code"] == "LARVA_MODEL_UNAVAILABLE"  # type: ignore[index]
    message = str(payload["parsed"]["message"])  # type: ignore[index]
    assert "child" in message
    assert "cli=alternate/child" in message
    assert "profile=canonical/child" in message
    assert "super-secret" not in message
    assert "abcdefghijklmnopqrstuvwxyz" not in message
    assert "dXNlcjpwYXNz" not in message
    assert "api-key-secret" not in message
    assert "\x00" not in message and "\x1b" not in message
    assert len(message) <= 230
    trace_preview = str(payload["tracePreview"])
    assert "super-secret" not in trace_preview
    assert "abcdefghijklmnopqrstuvwxyz" not in trace_preview
    assert "dXNlcjpwYXNz" not in trace_preview
    assert "api-key-secret" not in trace_preview
    assert "\x00" not in trace_preview and "\x1b" not in trace_preview
    assert len(trace_preview) <= 200
    json_trace_preview = str(payload["jsonTracePreview"])
    assert "json-secret-123" not in json_trace_preview
    assert "json-password-456" not in json_trace_preview
    assert "json-basic-789" not in json_trace_preview
    assert json_trace_preview.count("[REDACTED]") == 3
    rpc_client = EXTENSION.read_text(encoding="utf-8").split("class RpcClient", 1)[1]
    assert rpc_client.count("line_preview: sanitizedStartupDiagnostic(line)") == 2
    assert "line_preview: boundedTracePreview(line)" not in rpc_client


def test_thinking_profile_route_switches_and_verifies_model_and_thinking() -> None:
    """The existing model-map generation must transition both route dimensions."""
    source = EXTENSION.read_text(encoding="utf-8")
    switch = source.split("async function switchModelMapProfileUnlocked", 1)[1].split(
        "export async function switchModelMapProfile", 1
    )[0]

    assert "set_thinking_level" in switch
    assert "get_state" in switch
    assert "previousThinking" in switch
    assert "requested_thinking" in switch


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
        assert "--thinking" in text, document
        assert "LARVA_PI_INITIAL_PERSONA_MODEL_FROM_CLI" in text, document
        assert "LARVA_PI_BASE_AGENT_DIR" in text, document
        assert "PI_CODING_AGENT_DIR" in text, document
        assert "pi.setModel()" in text, document
        assert "thinkingLevel" in text, document
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
