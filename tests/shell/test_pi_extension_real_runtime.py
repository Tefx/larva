from __future__ import annotations

import json
import shutil
import subprocess
import textwrap
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[2]
EXTENSION = ROOT / "contrib" / "pi-extension" / "larva.ts"
SMOKE = ROOT / "scripts" / "pi-extension-autocomplete-smoke.mjs"
RUNTIME_SMOKE = ROOT / "scripts" / "pi-extension-runtime-smoke.mjs"
AGENT_PERSONA_POLICY_SMOKE = ROOT / "scripts" / "pi-agent-persona-switch-policy-smoke.mjs"
AUTOCOMPLETE_RUNTIME = ROOT / "contrib" / "pi-extension" / "test-autocomplete-runtime.mjs"
FAKE_LARVA_CLI = ROOT / "tests" / "fixtures" / "pi" / "fake-larva-cli.mjs"


def _run_autocomplete_case(case: str, *, prefix: str | None = None) -> dict[str, Any]:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is required for Pi extension autocomplete runtime smoke")
    command = [node, str(SMOKE), "--case", case]
    if prefix is not None:
        command.extend(["--prefix", prefix])
    completed = subprocess.run(command, check=False, capture_output=True, text=True, timeout=5)
    assert completed.returncode == 0, completed.stderr
    return json.loads(completed.stdout)


def _run_autocomplete_runtime_case(case: str, *, prefix: str | None = None) -> dict[str, Any]:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is required for Pi extension autocomplete runtime smoke")
    command = [node, str(AUTOCOMPLETE_RUNTIME), "--case", case]
    if prefix is not None:
        command.extend(["--prefix", prefix])
    completed = subprocess.run(command, check=False, capture_output=True, text=True, timeout=8)
    assert completed.returncode == 0, completed.stderr
    return json.loads(completed.stdout)


def test_autocomplete_substring_case_and_prefix_first_stable_order_runtime() -> None:
    payload = _run_autocomplete_runtime_case("substring-case-ordering", prefix="DEV")

    assert payload["providerValues"] == ["DevOps", "devrel", "qa-dev", "backend-dev"]
    assert payload["providerResultIsObject"] is True
    assert payload["resultItemsIsArray"] is True
    assert payload["prefixFromProvider"] == "DEV"
    assert payload["commandValues"] == payload["providerValues"]
    assert payload["substringCaseInsensitive"] is True
    assert payload["prefixFirstStableOrder"] is True
    assert payload["forcedAndCommandSharePath"] is True


def test_autocomplete_cache_reuse_and_concurrent_inflight_dedupe_runtime() -> None:
    payload = _run_autocomplete_runtime_case("cache-inflight")

    assert payload["listInvocationCountDuringOverlap"] == 1
    assert payload["listInvocationCountAfterCacheReuse"] == 1
    assert payload["coldResultsAreNullOrObjects"] is True
    assert payload["cachedResultIsObject"] is True
    assert payload["resultItemsAreArrays"] is True
    assert payload["prefixesFromProvider"][-1] == "vectl"
    assert payload["inFlightDedupeProven"] is True
    assert payload["cacheReuseProven"] is True


def test_autocomplete_delegation_and_failure_fail_closed_runtime() -> None:
    payload = _run_autocomplete_runtime_case("delegation-failure", prefix="vectl")

    assert payload["delegated"] is True
    assert payload["calls"] == [["/not-larva vectl", "object"]]
    assert payload["delegatedItems"] == [
        {"value": "file.txt", "label": "file.txt", "description": "base file completion"}
    ]
    assert payload["failed"] is None
    assert payload["malformed"] is None
    assert payload["failClosedNoCrash"] is True


def test_autocomplete_fixture_uses_documented_list_json_shape_without_alias_fields() -> None:
    payload = _run_autocomplete_runtime_case("fixture-shape")

    assert payload["exactDocumentedShape"] == {
        "data": [
            {
                "id": "vectl-planner",
                "description": "Plan with vectl",
                "spec_digest": "sha256:vectl-planner",
                "model": "openai/gpt-5.5",
            },
            {
                "id": "vectl-reviewer",
                "description": "Review with vectl",
                "spec_digest": "sha256:vectl-reviewer",
                "model": "openai/gpt-5.5",
            },
        ]
    }
    assert payload["providerResultIsObject"] is True
    assert payload["resultItemsIsArray"] is True
    assert payload["prefixFromProvider"] == "vectl"
    assert payload["candidateKeys"] == [["description", "label", "value"], ["description", "label", "value"]]
    assert payload["noAliasFuzzyRegexWildcardFields"] is True


def test_autocomplete_installed_provider_mentions_namespace_without_vectl_filter_runtime() -> None:
    payload = _run_autocomplete_runtime_case("mention-namespace")

    expected = [
        "@persona:ok",
        "@persona:startup",
        "@persona:child",
        "@persona:vectl-planner",
        "@persona:vectl-reviewer",
        "@persona:qa-dev",
        "@persona:DevOps",
        "@persona:devrel",
        "@persona:backend-dev",
    ]
    assert payload["namespacePartialValues"] == expected
    assert payload["namespacePartialResultIsObject"] is True
    assert payload["bareNamespaceResultIsObject"] is True
    assert payload["queryResultIsObject"] is True
    assert payload["namespacePartialItemsIsArray"] is True
    assert payload["bareNamespaceItemsIsArray"] is True
    assert payload["queryItemsIsArray"] is True
    assert payload["namespacePartialPrefix"] == "@p"
    assert payload["bareNamespacePrefix"] == "@persona:"
    assert payload["queryPrefix"] == "@persona:DEV"
    assert payload["bareNamespaceValues"] == expected
    assert payload["namespacePartialReturnsAllEligible"] is True
    assert payload["bareNamespaceReturnsAllEligible"] is True
    assert payload["queryValues"] == ["@persona:DevOps", "@persona:devrel", "@persona:qa-dev", "@persona:backend-dev"]
    assert payload["rawQueryPrefix"] == "@vectl"
    assert payload["rawQueryValues"] == ["./docs/vectl.md", "@persona:vectl-planner", "@persona:vectl-reviewer"]
    assert payload["rawQueryLabels"] == ["./docs/vectl.md", "Pi duplicate wins", "@persona:vectl-reviewer"]
    assert payload["queryUsesSuffixOnly"] is True
    assert payload["rawQueryMergesFileFirst"] is True
    assert payload["rawQueryKeepsBaseDuplicateFirst"] is True
    assert payload["personaNamespaceQueryIsPersonaOnly"] is True
    assert payload["applyCompletionInsertedMention"] is True
    assert payload["rawApplyCompletionInsertedCanonicalMention"] is True


def test_autocomplete_registration_defers_to_session_context_and_dedupes_runtime() -> None:
    payload = _run_autocomplete_runtime_case("registration-lifecycle")

    assert payload["registeredName"] == "larva-persona"
    assert payload["hasSessionStart"] is True
    assert payload["afterFactory"] == 0
    assert payload["afterFirstSession"] == 1
    assert payload["afterSecondSession"] == 1


@pytest.mark.parametrize("case,force", [("tab-force", True), ("tab-regular", False)])
def test_autocomplete_tui_provider_uses_argument_prefix_for_force_modes(case: str, force: bool) -> None:
    payload = _run_autocomplete_case(case, prefix="vectl")

    assert payload["command"] == "larva-persona"
    assert payload["force"] is force
    assert payload["prefix"] == "vectl"
    assert payload["editorLine"] == "/larva-persona vectl"
    assert payload["resultIsObject"] is True
    assert payload["prefixFromProvider"] == "vectl"
    assert payload["values"] == ["vectl-planner", "vectl-reviewer"]
    assert payload["allValuesAreStrings"] is True
    assert payload["valuesEqualPersonaIds"] is True
    assert payload["provesArgumentPrefix"] is True
    assert payload["exactShape"] is True


def test_autocomplete_delegates_non_larva_persona_input_to_base_provider() -> None:
    payload = _run_autocomplete_case("delegate-other-input")

    assert payload["delegated"] is True
    assert payload["items"] == [
        {"value": "file.txt", "label": "file.txt", "description": "base file completion"}
    ]
    assert payload["calls"] == [["/not-larva vectl", "object"]]


def test_autocomplete_smoke_mentions_namespace_returns_all_eligible_personas() -> None:
    payload = _run_autocomplete_case("mention-namespace")

    assert payload["values"] == payload["expected"]
    assert payload["resultIsObject"] is True
    assert payload["resultItemsIsArray"] is True
    assert payload["prefixFromProvider"] == "@persona:"
    assert payload["allValuesAreStrings"] is True
    assert payload["allValuesArePersonaMentions"] is True
    assert payload["allEligiblePersonaMentionsReturned"] is True
    assert payload["applyCompletionInsertedMention"] is True


def test_autocomplete_smoke_mentions_raw_query_merges_files_before_personas() -> None:
    payload = _run_autocomplete_case("mention-raw-query", prefix="@vectl")

    assert payload["command"] == "larva-persona"
    assert payload["editorLine"] == "@vectl"
    assert payload["rawPrefix"] == "@vectl"
    assert payload["personaOnlyPrefix"] == "@persona:vectl"
    assert payload["rawValues"] == ["./docs/vectl.md", "@persona:vectl-planner", "@persona:vectl-reviewer"]
    assert payload["rawLabels"] == ["./docs/vectl.md", "Pi duplicate wins", "@persona:vectl-reviewer"]
    assert payload["personaOnlyValues"] == ["@persona:vectl-planner", "@persona:vectl-reviewer"]
    assert payload["rawMergesFileFirst"] is True
    assert payload["rawKeepsBaseDuplicateFirst"] is True
    assert payload["personaOnlyStaysPersonaOnly"] is True
    assert payload["appliedCanonicalMention"] is True


def test_autocomplete_list_failure_and_malformed_json_return_null_without_crash() -> None:
    payload = _run_autocomplete_case("list-failure", prefix="vectl")

    assert payload == {
        "case": "list-failure",
        "failed": None,
        "malformed": None,
        "noCrash": True,
    }


def _run_runtime_scenario_raw(
    scenario: str, *, persona: str | None = None, timeout: float = 12.0
) -> tuple[dict[str, Any], int, str, str]:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is required for Pi extension runtime smoke")
    command = [node, str(RUNTIME_SMOKE), "--scenario", scenario]
    if persona is not None:
        command.extend(["--persona", persona])
    completed = subprocess.run(
        command,
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    assert completed.stdout.strip(), completed.stderr
    return json.loads(completed.stdout), completed.returncode, completed.stdout, completed.stderr


def _run_runtime_scenario(scenario: str, *, persona: str | None = None, timeout: float = 12.0) -> dict[str, Any]:
    payload, returncode, raw_stdout, raw_stderr = _run_runtime_scenario_raw(
        scenario, persona=persona, timeout=timeout
    )
    assert returncode == 0, f"stdout:\n{raw_stdout}\nstderr:\n{raw_stderr}"
    return payload


def _run_node_inline(tmp_path: Path, script: str, *, timeout: float = 8.0) -> dict[str, Any]:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is required for Pi extension runtime artifact tests")
    script_path = tmp_path / "runtime-artifact.mjs"
    script_path.write_text(script, encoding="utf-8")
    completed = subprocess.run(
        [node, str(script_path)],
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    assert completed.returncode == 0, completed.stderr
    return json.loads(completed.stdout)



def test_async_subagent_push_uses_real_agent_session_send_custom_message_when_toolctx_lacks_send_surface(tmp_path: Path) -> None:
    """Regression: tool execution must route callbacks through Pi's real sendMessage core hook."""

    child_source = r'''#!/usr/bin/env node
import { createInterface } from "node:readline";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const root = process.argv[process.argv.length - 1];
await mkdir(root, { recursive: true });
const sessionFile = join(root, `real-send-${Date.now()}.jsonl`);
const rl = createInterface({ input: process.stdin });
function send(value) { process.stdout.write(JSON.stringify(value) + "\n"); }
rl.on("line", async (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "get_state") { await writeFile(sessionFile, "{}\n", "utf8"); send({ id: msg.id, success: true, data: { sessionFile } }); }
  else if (msg.type === "switch_session") { send({ id: msg.id, success: true, data: { cancelled: false } }); }
  else if (msg.type === "prompt") { send({ id: msg.id, success: true }); setTimeout(() => send({ type: "agent_end" }), 5); }
  else if (msg.type === "get_last_assistant_text") { send({ id: msg.id, success: true, data: { text: "real AgentSession callback output" } }); setTimeout(() => process.exit(0), 1); }
  else if (msg.type === "abort") { send({ id: msg.id, success: true }); process.exit(0); }
});
'''

    payload = _run_node_inline(
        tmp_path,
        textwrap.dedent(
            f"""
            import {{ mkdtemp, writeFile }} from "node:fs/promises";
            import {{ tmpdir }} from "node:os";
            import {{ join }} from "node:path";
            const mod = await import({json.dumps(EXTENSION.as_uri())});
            const {{ AgentSession }} = await import("file:///opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js");

            const tmpRoot = await mkdtemp(join(tmpdir(), "larva-real-send-message-"));
            const childRoot = join(tmpRoot, "child-sessions");
            const childPath = join(tmpRoot, "child.mjs");
            await writeFile(childPath, {json.dumps(child_source)}, {{ mode: 0o755 }});

            const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            async function waitFor(predicate, timeoutMs = 2000, intervalMs = 10) {{
              const start = Date.now();
              while (Date.now() - start < timeoutMs) {{
                const value = await predicate();
                if (value) return value;
                await sleep(intervalMs);
              }}
              return null;
            }}

            const modelRegistry = {{ find: () => ({{ provider: "openai-codex", model: "gpt-5.5" }}) }};
            const env = {{
              ...process.env,
              HOME: tmpRoot,
              LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, {json.dumps(str(FAKE_LARVA_CLI))}]),
              LARVA_PI_CHILD_SESSION_DIR: childRoot,
              LARVA_PI_REAL_BIN: childPath,
              LARVA_PI_EXTENSION_ENTRY: childPath,
              LARVA_PI_INITIAL_PERSONA_ID: "",
            }};
            const tools = [];
            const ctx = {{ env, modelRegistry, ui: {{ setStatus: () => undefined }} }};
            const capturedAgentPrompts = [];
            const capturedSteers = [];
            const capturedFollowUps = [];
            const hostAgent = {{
              state: {{ messages: [], isStreaming: false }},
              prompt: async (message) => {{ capturedAgentPrompts.push(message); hostAgent.state.messages.push(message); }},
              continue: async () => undefined,
              steer: (message) => capturedSteers.push(message),
              followUp: (message) => capturedFollowUps.push(message),
            }};
            const hostSession = Object.create(AgentSession.prototype);
            Object.assign(hostSession, {{
              agent: hostAgent,
              sessionManager: {{ appendCustomMessageEntry: () => undefined }},
              _pendingNextTurnMessages: [],
              _handlePostAgentRun: async () => false,
              _flushPendingBashMessages: () => undefined,
              _emit: () => undefined,
            }});
            const piRuntimeCore = {{
              setModel: () => true,
              getAllTools: () => ["read", "grep", "larva_subagent"],
              setActiveTools: () => true,
              on: () => undefined,
              registerTool: (tool) => tools.push(tool),
              sendMessage: (message, options) => hostSession.sendCustomMessage(message, options),
            }};
            await mod.initializeExtension(ctx, piRuntimeCore);
            await mod.commitPersona("ok", ctx, piRuntimeCore);

            const subagent = tools.find((tool) => tool.name === "larva_subagent");
            const statusTool = tools.find((tool) => tool.name === "larva_subagent_status");
            const realToolCtx = {{ env, modelRegistry, ui: {{ setStatus: () => undefined }} }};
            const receipt = await subagent.execute("real-agent-session-send", {{ persona_id: "child", task: "finish and push through real AgentSession" }}, undefined, undefined, realToolCtx);
            const deliveredPrompt = await waitFor(() => capturedAgentPrompts.find((message) => message?.details?.task_id === receipt.task_id));
            const statusRows = await waitFor(async () => {{
              const rows = await statusTool.execute("real-agent-session-status", {{ task_id: receipt.task_id }}, undefined, undefined, realToolCtx);
              return rows.details.runs[0]?.callback_delivery === "delivered" ? rows : null;
            }});

            console.log(JSON.stringify({{
              proofClass: "real_pi_agent_session_send_custom_message_callback_delivery",
              piRuntimeSeams: [
                "AgentSession.sendCustomMessage",
                "AgentSession._runAgentPrompt",
                "PiApi.sendMessage callback surface",
              ],
              toolCtxHasSendSurface: Boolean(realToolCtx.sendMessage || realToolCtx.sendCustomMessage || realToolCtx.sendUserMessage || realToolCtx.appendEntry),
              receiptStatus: receipt.status,
              callbackDelivery: statusRows?.details?.runs?.[0]?.callback_delivery ?? null,
              capturedPrompt: deliveredPrompt ? {{
                role: deliveredPrompt.role,
                customType: deliveredPrompt.customType,
                display: deliveredPrompt.display,
                contentIncludesBoundary: typeof deliveredPrompt.content === "string" && deliveredPrompt.content.includes("Larva subagent result — runtime event/data"),
                detailsStatus: deliveredPrompt.details?.status,
                detailsTaskId: deliveredPrompt.details?.task_id,
              }} : null,
              capturedSteers: capturedSteers.length,
              capturedFollowUps: capturedFollowUps.length,
            }}, null, 2));
            """
        ),
        timeout=8.0,
    )

    assert payload["proofClass"] == "real_pi_agent_session_send_custom_message_callback_delivery"
    assert payload["piRuntimeSeams"] == [
        "AgentSession.sendCustomMessage",
        "AgentSession._runAgentPrompt",
        "PiApi.sendMessage callback surface",
    ]
    assert payload["toolCtxHasSendSurface"] is False
    assert payload["receiptStatus"] == "accepted"
    assert payload["callbackDelivery"] == "delivered"
    assert payload["capturedPrompt"] == {
        "role": "custom",
        "customType": "larva-subagent-result",
        "display": True,
        "contentIncludesBoundary": True,
        "detailsStatus": "success",
        "detailsTaskId": payload["capturedPrompt"]["detailsTaskId"],
    }
    assert isinstance(payload["capturedPrompt"]["detailsTaskId"], str)
    assert payload["capturedSteers"] == 0
    assert payload["capturedFollowUps"] == 0

def _skip_if_pi_absent(payload: dict[str, Any]) -> None:
    pi = payload.get("pi", {})
    if pi.get("available") is not True:
        pytest.skip(f"Pi binary absent/unusable; availability evidence={json.dumps(pi, sort_keys=True)}")


def _xfail_if_rpc_surface_hidden(payload: dict[str, Any]) -> None:
    _skip_if_pi_absent(payload)
    rpc = payload.get("rpc", {})
    assert rpc.get("loadFailure") is not True, (
        "Pi binary is present but plugin/RPC startup failed; "
        f"rpc evidence={json.dumps(rpc, sort_keys=True)}"
    )
    if rpc.get("supported") is not True:
        pytest.xfail(
            "current Pi RPC did not expose extension UI/custom command surfaces; "
            f"rpc evidence={json.dumps(rpc, sort_keys=True)}"
        )


def test_rpc_skip_xfail_policy_does_not_hide_plugin_load_failure() -> None:
    payload = {
        "pi": {"available": True, "binary": "pi", "extensionFlag": "-e"},
        "rpc": {
            "supported": False,
            "loadFailure": True,
            "stderr": "failed to load contrib/pi-extension/larva.ts",
        },
    }

    with pytest.raises(AssertionError, match="plugin/RPC startup failed"):
        _xfail_if_rpc_surface_hidden(payload)


def test_runtime_smoke_help_lists_all_required_scenarios() -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is required for Pi extension runtime smoke")
    completed = subprocess.run(
        [node, str(RUNTIME_SMOKE), "--help"],
        check=False,
        capture_output=True,
        text=True,
        timeout=5,
    )

    assert completed.returncode == 0, completed.stderr
    for scenario in (
        "availability",
        "get-commands",
        "slash-status",
        "startup-status",
        "startup-fatal",
        "failure-path",
        "tool-shape",
        "tool-result-renderer-shape",
        "fresh-session-validation",
        "tool-call-block",
        "capability-gates",
        "live-child-rpc-proof",
        "async-subagent-contract",
        "persona-invocation-bus",
    ):
        assert scenario in completed.stdout


def test_agent_persona_switch_policy_smoke_outputs_complete_offline_register() -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is required for Pi agent persona switch policy smoke")
    completed = subprocess.run(
        [node, str(AGENT_PERSONA_POLICY_SMOKE), "--offline"],
        check=False,
        capture_output=True,
        text=True,
        timeout=20,
    )
    assert completed.returncode == 0, completed.stderr
    payload = json.loads(completed.stdout)
    required_refs = {
        "default_confirm_registers_request_tools",
        "confirm_request_only_autonomous_surface",
        "manual_mode_autonomous_unavailable",
        "stale_or_forged_manual_request_fail_closed",
        "explicit_user_slash_persona_success_no_lease",
        "manual_switch_active_lease_precedence",
        "restore_terminal_success",
        "restore_terminal_failure",
        "restore_terminal_cancellation",
        "restore_terminal_timeout",
        "restore_failure_state_preservation_reporting_audit_user_choice_no_fallback",
        "restore_notices_outside_assistant_chat_body",
        "pre_borrow_runtime_model_restore",
        "async_exact_handle_no_alias_constraints",
        "unsupported_live_not_required",
    }
    register = payload["behavioralProofRegister"]
    positive_statuses = {"PASS", "PROVEN"}
    rows_by_ref = {row["requirement_ref"]: row for row in register}
    observed_refs = {row["requirement_ref"] for row in register if row["status"] in positive_statuses}

    assert payload["status"] == "PASS"
    assert required_refs <= observed_refs
    runtime_model_row = rows_by_ref["pre_borrow_runtime_model_restore"]
    assert runtime_model_row["status"] in positive_statuses
    assert runtime_model_row["origin_persona_default_model"] == "provider/origin-default-model"
    assert runtime_model_row["manual_pre_borrow_runtime_model"] == "manual-provider/manual-runtime-before-borrow"
    assert runtime_model_row["borrowed_persona_or_model"] == "python/provider/borrowed-python-model"
    assert runtime_model_row["restored_runtime_model"] == runtime_model_row["manual_pre_borrow_runtime_model"]
    assert runtime_model_row["manual_pre_borrow_runtime_model"] != runtime_model_row["origin_persona_default_model"]
    assert runtime_model_row["non_equality_assertion"] == (
        "manual-provider/manual-runtime-before-borrow !== provider/origin-default-model"
    )
    restore_audit = runtime_model_row["restore_audit"]
    assert restore_audit["restored"] is True
    assert restore_audit["restored_pi_model"] is True
    assert restore_audit["lease"]["originPiModelCaptured"] is True
    assert restore_audit["lease"]["originPiModelLabel"] == runtime_model_row["manual_pre_borrow_runtime_model"]
    assert payload["liveModeDisposition"] == {
        "unsupported_live_requirement_removed_or_supported": "unsupported --live is not required; this smoke harness intentionally supports --offline only",
        "required": False,
        "supported": False,
    }
    assert all(check["status"] == "PASS" for check in payload["checks"])


def test_agent_persona_switch_auto_borrow_agent_end_restores_origin_runtime(tmp_path: Path) -> None:
    """Accepted host-runtime proof for current auto-borrow semantics.

    The current policy does not terminate the active tool result or enqueue a
    Larva-generated follow-up. Instead, auto mode creates a turn-scoped lease,
    updates the active persona envelope, and relies on the Pi ``agent_end`` hook
    to restore the origin persona on success, failure, cancellation, or timeout.
    """

    fake_cli = tmp_path / "fake-larva-followup-cli.mjs"
    fake_cli.write_text(
        textwrap.dedent(
            """
            const [, , command, arg, jsonFlag] = process.argv;
            if (command !== "resolve" || jsonFlag !== "--json") process.exit(3);
            const promptMarker = arg === "python" ? "PYTHON_RUNTIME_PROMPT_MARKER" : "ARCHITECT_RUNTIME_PROMPT_MARKER";
            process.stdout.write(JSON.stringify({
              data: {
                id: arg,
                description: `Persona ${arg}`,
                prompt: `Prompt for ${arg}\n${promptMarker}`,
                model: "provider/model",
                capabilities: {},
                spec_version: "0.1.0",
                spec_digest: `sha256:${arg}`,
                can_spawn: true
              }
            }));
            """
        ),
        encoding="utf-8",
    )

    payload = _run_node_inline(
        tmp_path,
        f"""
        const mod = await import({json.dumps(EXTENSION.as_uri())});
        const {{ AgentSession }} = await import("file:///opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js");

        const activeToolCalls = [];
        const tools = {{}};
        const handlers = {{}};
        const sessionEntries = [];
        const hostAgent = {{
          state: {{ isStreaming: true, model: {{ provider: "provider", id: "model" }}, messages: [], tools: [], systemPrompt: "base" }},
          followUp: (message) => {{ hostAgent.queuedFollowUps.push(message); }},
          steer: (message) => {{ hostAgent.queuedSteers.push(message); }},
          hasQueuedMessages: () => hostAgent.queuedFollowUps.length > 0 || hostAgent.queuedSteers.length > 0,
          clearAllQueues: () => {{ hostAgent.queuedFollowUps = []; hostAgent.queuedSteers = []; }},
          prompt: async () => undefined,
          abort: () => undefined,
          waitForIdle: async () => undefined,
          queuedFollowUps: [],
          queuedSteers: [],
        }};
        const hostSession = Object.create(AgentSession.prototype);
        Object.assign(hostSession, {{
          agent: hostAgent,
          _followUpMessages: [],
          _steeringMessages: [],
          _pendingNextTurnMessages: [],
          _pendingBashMessages: [],
          _eventListeners: [],
          _baseSystemPrompt: "base",
          _baseSystemPromptOptions: {{}},
          _extensionRunner: {{ emitInput: async () => ({{ action: "continue" }}), emit: async () => undefined }},
          sessionManager: {{ appendMessage: () => undefined }},
          settingsManager: {{}},
        }});

        const pi = {{
          getAllTools: async () => ["read", "larva_persona_switch", "larva_personas"],
          setActiveTools: async (activeTools) => {{ activeToolCalls.push(activeTools); return true; }},
          setModel: async () => true,
          registerCommand: () => undefined,
          registerTool: (tool) => {{ tools[tool.name] = tool; }},
          on: (event, handler) => {{ handlers[event] = handler; }},
        }};
        const ctx = {{
          env: {{
            LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, {json.dumps(str(fake_cli))}]),
            LARVA_PI_AGENT_PERSONA_SWITCH: "auto",
            LARVA_PI_INITIAL_PERSONA_ID: "architect",
            LARVA_PI_INTERACTIVE_TUI: "0",
          }},
          ui: {{ setStatus: async () => undefined, notify: async () => undefined }},
          modelRegistry: {{ find: async () => ({{ id: "model" }}) }},
          session: {{
            entries: sessionEntries,
            getEntries: () => sessionEntries,
            appendEntry: (customType, data) => sessionEntries.push({{ type: "custom", customType, data }}),
          }},
          sendUserMessage: hostSession.sendUserMessage.bind(hostSession),
        }};
        await mod.initializeExtension(ctx, pi);
        await handlers.session_start?.({{ reason: "startup" }}, ctx);
        const switchTool = tools["larva_persona_switch"];
        const switchResult = await switchTool.execute("call-switch", {{
          persona_id: "python",
          reason: "Python runtime proof required",
          handoff: "Continue with the Python marker",
          continue_task: true,
        }}, undefined, undefined, ctx);

        const queuedFollowUpMessages = hostSession.getFollowUpMessages();
        const queuedAgentFollowUps = hostAgent.queuedFollowUps;
        const borrowedPrompt = mod.before_agent_start({{ systemPrompt: "base prompt before next provider call" }})?.systemPrompt ?? "";
        const borrowedEnvelope = mod.getActiveEnvelope();
        await handlers.agent_end?.({{ messages: [{{ role: "assistant", stopReason: "aborted" }}] }}, ctx);
        const restoredEnvelope = mod.getActiveEnvelope();
        const restoredPrompt = mod.before_agent_start({{ systemPrompt: "base prompt after restore" }})?.systemPrompt ?? "";
        console.log(JSON.stringify({{
          proofClass: "accepted_runtime_persona_borrow_and_agent_end_restore",
          piRuntimeSeams: [
            "Pi extension larva_persona_switch tool execution",
            "Pi extension before_agent_start prompt envelope injection",
            "Pi extension agent_end terminal restore hook",
          ],
          switchResult,
          queuedFollowUpMessages,
          queuedAgentFollowUps,
          borrowedPrompt,
          restoredPrompt,
          borrowedEnvelope,
          restoredEnvelope,
          activeToolCalls,
          auditEntries: sessionEntries.filter((entry) => entry.customType === "larva-agent-persona-switch-audit"),
          assertions: {{
            oldTurnNotTerminatedByToolResult: switchResult.terminate === false,
            noGeneratedFollowUpQueued: queuedFollowUpMessages.length === 0 && queuedAgentFollowUps.length === 0,
            borrowedPromptUsesNewPersonaEnvelope: borrowedPrompt.includes("<!-- larva-spec: python@sha256:python -->"),
            borrowedPromptUsesNewPersonaPrompt: borrowedPrompt.includes("PYTHON_RUNTIME_PROMPT_MARKER") && !borrowedPrompt.includes("ARCHITECT_RUNTIME_PROMPT_MARKER"),
            cancellationAgentEndRestoredOrigin: restoredEnvelope?.persona_id === "architect",
            restoredPromptUsesOriginPersona: restoredPrompt.includes("ARCHITECT_RUNTIME_PROMPT_MARKER") && !restoredPrompt.includes("PYTHON_RUNTIME_PROMPT_MARKER"),
          }},
        }}));
        """,
    )

    assert payload["proofClass"] == "accepted_runtime_persona_borrow_and_agent_end_restore"
    assert payload["piRuntimeSeams"] == [
        "Pi extension larva_persona_switch tool execution",
        "Pi extension before_agent_start prompt envelope injection",
        "Pi extension agent_end terminal restore hook",
    ]
    assert payload["switchResult"]["status"] == "success"
    assert payload["switchResult"].get("terminate") is False
    assert payload["borrowedEnvelope"]["persona_id"] == "python"
    assert payload["restoredEnvelope"]["persona_id"] == "architect"
    assert payload["queuedFollowUpMessages"] == []
    assert payload["assertions"] == {
        "oldTurnNotTerminatedByToolResult": True,
        "noGeneratedFollowUpQueued": True,
        "borrowedPromptUsesNewPersonaEnvelope": True,
        "borrowedPromptUsesNewPersonaPrompt": True,
        "cancellationAgentEndRestoredOrigin": True,
        "restoredPromptUsesOriginPersona": True,
    }
    assert any(entry["data"].get("committed") is True for entry in payload["auditEntries"])


def test_compaction_prompt_real_runtime_envelope_focus_uses_active_state(tmp_path: Path) -> None:
    module_dir = tmp_path / "node_modules" / "@earendil-works" / "pi-tui"
    module_dir.mkdir(parents=True)
    (module_dir / "package.json").write_text(
        json.dumps({"type": "module", "main": "index.js", "exports": "./index.js"}),
        encoding="utf-8",
    )
    (module_dir / "index.js").write_text(
        textwrap.dedent(
            """
            export class Input {}
            export const Key = {};
            export class Markdown {}
            export class SelectList {}
            export function matchesKey() { return false; }
            export function truncateToWidth(value, width) { return String(value).slice(0, Math.max(0, width)); }
            export function visibleWidth(value) { return String(value).length; }
            export function wrapTextWithAnsi(value) { return [String(value)]; }
            """
        ),
        encoding="utf-8",
    )
    extension = tmp_path / "larva-pi-compaction-runtime.ts"
    extension.write_text(
        EXTENSION.read_text(encoding="utf-8") + "\nexport { activePersonaCompactionFocus };\n",
        encoding="utf-8",
    )
    fake_cli = tmp_path / "fake-larva-compaction-runtime-cli.mjs"
    fake_cli.write_text(
        textwrap.dedent(
            """
            const [, , command, personaId, jsonFlag] = process.argv;
            if (command === "resolve" && jsonFlag === "--json" && personaId === "compact") {
              process.stdout.write(JSON.stringify({
                data: {
                  id: "compact",
                  description: "Compaction runtime persona",
                  prompt: "REAL_RUNTIME_FULL_PROMPT_MUST_NOT_BE_FOCUS",
                  model: "provider/model",
                  capabilities: {},
                  spec_version: "0.1.0",
                  spec_digest: "sha256:compact-runtime",
                  compaction_prompt: "REAL_RUNTIME_COMPACTION_FOCUS",
                }
              }));
              process.exit(0);
            }
            process.exit(17);
            """
        ),
        encoding="utf-8",
    )

    payload = _run_node_inline(
        tmp_path,
        f"""
        const mod = await import({json.dumps(extension.as_uri())});
        const handlers = new Map();
        const sessionEntries = [];
        const modelCalls = [];
        const ctx = {{
          env: {{
            LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, {json.dumps(str(fake_cli))}]),
            LARVA_PI_INITIAL_PERSONA_ID: "compact",
            LARVA_PI_INTERACTIVE_TUI: "0",
          }},
          ui: {{ setStatus: async () => undefined, notify: async () => undefined }},
          modelRegistry: {{ find: async (provider, id) => ({{ provider, id }}) }},
          session: {{
            entries: sessionEntries,
            getEntries: () => sessionEntries,
            appendEntry: (customType, data) => sessionEntries.push({{ type: "custom", customType, data }}),
          }},
        }};
        const pi = {{
          getAllTools: async () => ["read"],
          setActiveTools: async () => true,
          setModel: async (model) => {{ modelCalls.push(model); ctx.model = model; return true; }},
          registerCommand: () => undefined,
          registerTool: () => undefined,
          on: (event, handler) => handlers.set(event, handler),
        }};
        await mod.initializeExtension(ctx, pi);
        await handlers.get("session_start")?.({{ reason: "startup" }}, ctx);
        const envelope = mod.getActiveEnvelope();
        const focus = mod.activePersonaCompactionFocus();
        console.log(JSON.stringify({{
          envelope,
          focus,
          modelCalls,
          runtimeModel: ctx.model,
          commitEntry: sessionEntries.find((entry) => entry.customType === "larva-active-persona-commit") ?? null,
          assertions: {{
            envelopePreservesCompactionPrompt: envelope?.compaction_prompt === "REAL_RUNTIME_COMPACTION_FOCUS",
            focusUsesCompactionPrompt: focus === "REAL_RUNTIME_COMPACTION_FOCUS",
            fullPromptNotFocus: !String(focus).includes("REAL_RUNTIME_FULL_PROMPT_MUST_NOT_BE_FOCUS"),
            modelSelectedByRuntime: modelCalls.length > 0 && ctx.model?.id === "model",
          }},
        }}));
        """,
        timeout=8,
    )

    assert payload["assertions"] == {
        "envelopePreservesCompactionPrompt": True,
        "focusUsesCompactionPrompt": True,
        "fullPromptNotFocus": True,
        "modelSelectedByRuntime": True,
    }
    assert payload["commitEntry"] is not None
    assert "prompt" not in payload["commitEntry"]["data"]
    assert "model" not in payload["commitEntry"]["data"]


def test_real_pi_availability_records_binary_and_extension_flag() -> None:
    payload = _run_runtime_scenario("availability")
    _skip_if_pi_absent(payload)

    assert payload["pi"]["binary"]
    assert payload["pi"]["extensionFlag"] == "-e"


@pytest.mark.parametrize("scenario", ["get-commands", "slash-status", "startup-status", "failure-path"])
def test_real_pi_rpc_smoke_collects_extension_ui_evidence_or_explicit_xfail(scenario: str) -> None:
    payload = _run_runtime_scenario(scenario)
    _xfail_if_rpc_surface_hidden(payload)

    assert payload["scenario"] == scenario
    assert payload["rpc"]["attempted"] is True
    assert payload["rpc"]["supported"] is True
    assert isinstance(payload["rpc"].get("events"), list)
    ui_requests = payload["rpc"].get("uiRequests", [])
    assert all(request.get("type") == "extension_ui_request" for request in ui_requests)
    if ui_requests:
        assert any(
            "statusKey" in request or "statusText" in request or "status" in request
            for request in ui_requests
        )


def test_real_pi_slash_status_commits_success_persona() -> None:
    payload = _run_runtime_scenario("slash-status", persona="ok")
    _xfail_if_rpc_surface_hidden(payload)

    ui_requests = payload["rpc"].get("uiRequests", [])
    assert any(
        request.get("method") == "setStatus"
        and request.get("statusKey") == "larva"
        and request.get("statusText") == "larva: ok"
        for request in ui_requests
    )
    assert any(
        request.get("method") == "notify"
        and request.get("message") == "Larva persona active: ok"
        and request.get("notifyType") == "info"
        for request in ui_requests
    )


def test_real_pi_startup_status_commits_startup_persona() -> None:
    payload = _run_runtime_scenario("startup-status", persona="startup")
    _xfail_if_rpc_surface_hidden(payload)

    assert any(
        request.get("method") == "setStatus"
        and request.get("statusKey") == "larva"
        and request.get("statusText") == "larva: startup"
        for request in payload["rpc"].get("uiRequests", [])
    )


def test_real_pi_initial_persona_invalid_model_fails_nonzero_before_prompt() -> None:
    payload = _run_runtime_scenario("startup-fatal")
    _skip_if_pi_absent(payload)

    fatal = payload["rpc"]["fatalStartup"]
    assert fatal["status"] == "PASS"
    assert fatal["firstPromptSent"] is False
    assert fatal["nonzeroBeforePrompt"] is True
    assert fatal["stderrHasLarvaStartupError"] is True
    assert "LARVA_MODEL_UNAVAILABLE" in fatal["stderr"]


def test_real_pi_failure_path_uses_slash_command_topology() -> None:
    payload = _run_runtime_scenario("failure-path", persona="missing")
    _xfail_if_rpc_surface_hidden(payload)

    responses = payload["rpc"].get("responses", [])
    assert [response.get("id") for response in responses] == ["prompt-missing", "prompt-unparseable"]
    messages = [request.get("message") for request in payload["rpc"].get("uiRequests", [])]
    assert "Larva persona switch failed: LARVA_PERSONA_NOT_FOUND: Unable to resolve persona missing" in messages
    assert "Larva persona switch failed: LARVA_PERSONA_NOT_FOUND: Invalid persona payload for unparseable" in messages


def test_runtime_capability_gate_rejects_mock_only_autocomplete_support() -> None:
    payload = _run_runtime_scenario("capability-gates")
    pi_tui_gate = payload["runtime"]["hardGates"]["piTuiDependency"]
    pi_tui_dependency = payload["package"]["piTuiDependency"]
    gate = payload["runtime"]["hardGates"]["uiAutocompleteProvider"]

    assert pi_tui_gate["supported"] is True
    assert pi_tui_dependency["packageJsonVersion"] == "0.78.0"
    assert pi_tui_dependency["lockfileRootDependency"] == "0.78.0"
    assert pi_tui_dependency["lockfileVersion"] == "0.78.0"
    assert pi_tui_dependency["installedVersion"] == "0.78.0"
    assert pi_tui_dependency["noHostGlobalFallback"] is True
    assert pi_tui_dependency["importOk"] is True
    assert gate["supported"] is False
    assert gate["status"] in {"unsupported", "unknown"}
    assert gate["provenance"] == "runtimeHarness.mock"
    assert gate["evidence"]["hook"]["hookType"] == "function"
    assert gate["evidence"]["hook"]["source"] == "runtimeHarness.mock"
    assert "live Pi interactive TUI runtime hook proof is missing" in gate["limitation"]
    assert "true requires non-mock Pi interactive TUI runtime/build provenance" in gate["supportRule"]


def test_runtime_object_registers_larva_subagent_parameters_and_execute() -> None:
    payload = _run_runtime_scenario("tool-shape")

    assertions = payload["runtime"]["assertions"]
    assert assertions == {
        "hasLarvaSubagent": True,
        "hasParameters": True,
        "hasExecute": True,
        "hasRenderableCall": True,
        "hasRenderableResult": True,
        "wideCallLinesFit": True,
        "wideResultLinesFit": True,
    }
    assert "larva_subagent" in payload["runtime"]["registeredToolNames"]


def test_registered_larva_subagent_results_are_renderer_safe_toolresults() -> None:
    """Pi renderer calls result.content.filter(...) on tool output.

    This invokes the registered ``larva_subagent`` handler/execute functions via
    the runtime smoke harness and requires a Pi ToolResult-style content array.
    The smoke also preserves machine-readable semantic metadata in ``details``.
    """

    payload = _run_runtime_scenario("tool-result-renderer-shape")
    cases = payload["runtime"]["toolResultCases"]
    assertions = payload["runtime"]["assertions"]

    assert cases["success"]["status"] == "accepted"
    assert cases["success"]["result_pending"] is True
    assert cases["success"]["result_text"] == ""
    assert "result_text" not in cases["success"]["details"]
    assert cases["failedBeforeSession"]["status"] == "failed"
    assert cases["failedBeforeSession"]["error"]["code"] == "LARVA_NO_ACTIVE_PERSONA"
    assert cases["failedBeforeSession"]["details"]["error"]["code"] == "LARVA_NO_ACTIVE_PERSONA"
    assert cases["cancelled"]["status"] == "cancelled"
    assert cases["failedAfterAllocation"]["status"] == "failed"
    assert cases["failedAfterAllocation"]["task_id"].endswith("allocated.jsonl")

    for case_name in ("success", "failedBeforeSession", "cancelled", "failedAfterAllocation"):
        assertion = assertions[case_name]
        case = cases[case_name]
        assert assertion["hasRendererSafeTextContent"] is True
        assert assertion["rendererSafeContent"] is True
        assert assertion["textItem"]["type"] == "text"
        assert isinstance(assertion["textItem"]["text"], str)
        if case["status"] == "accepted":
            assert assertion["detailsPreserve"] == {
                "task_id": case["task_id"],
                "persona_id": case["persona_id"],
                "status": "accepted",
                "result_pending": True,
                "error": case["error"],
                "no_terminal_result_text": True,
            }
        else:
            assert assertion["detailsPreserve"] == {
                "task_id": case["task_id"],
                "persona_id": case["persona_id"],
                "status": case["status"],
                "result_text": case["result_text"],
                "error": case["error"],
            }


def test_larva_subagent_fresh_child_sessionfile_validation_split() -> None:
    payload = _run_runtime_scenario("fresh-session-validation")
    validation = payload["runtime"]["freshSessionValidation"]
    assertions = payload["runtime"]["assertions"]

    fresh = validation["freshMissingBeforePrompt"]
    assert validation["missingBeforePrompt"] is True
    assert validation["createdDuringPrompt"] is True
    assert fresh["status"] == "accepted"
    assert fresh["result_pending"] is True
    assert fresh["result_text"] == ""
    assert fresh["task_id"].endswith("fresh-created-on-prompt.jsonl")

    missing_resume = validation["missingResume"]
    assert missing_resume["status"] == "failed"
    assert missing_resume["error"]["code"] == "LARVA_BAD_INPUT"
    assert validation["resumeSpawned"] is False

    invalid = validation["invalidFresh"]
    assert sorted(invalid) == ["danglingSymlinkEscape", "outsideRoot", "relative", "symlinkEscape", "wrongSuffix"]
    for result in invalid.values():
        assert result["status"] == "failed"
        assert result["error"]["code"] == "LARVA_CHILD_PROTOCOL_FAILED"
        assert result["error"]["message"] == "Child returned invalid sessionFile."

    assert assertions == {
        "freshMissingBeforePromptAccepted": True,
        "strictResumeMissingRejected": True,
        "invalidFreshRejected": True,
        "authorityAndToolResultPreserved": True,
    }


def test_runtime_tool_call_event_with_tool_name_blocks_with_reason() -> None:
    payload = _run_runtime_scenario("tool-call-block")

    assertions = payload["runtime"]["assertions"]
    assert assertions == {"blockTrue": True, "nonEmptyReason": True}
    result = payload["runtime"]["toolCallResult"]
    assert result["block"] is True
    assert isinstance(result["reason"], str) and result["reason"]


def test_live_child_rpc_terminal_cancel_and_orphan_cleanup_proof_passes() -> None:
    """Live Pi child RPC proof preserves accepted receipts while proving terminal cleanup."""

    payload, returncode, raw_stdout, raw_stderr = _run_runtime_scenario_raw(
        "live-child-rpc-proof", timeout=120.0
    )
    _skip_if_pi_absent(payload)
    proof = payload["runtime"]["controlledLive"]
    raw_json_evidence = {
        "command": ["node", str(RUNTIME_SMOKE), "--scenario", "live-child-rpc-proof"],
        "exit_code": returncode,
        "raw_stdout": raw_stdout,
        "raw_stderr": raw_stderr,
        "status": proof["status"],
        "traceMetadataOnly": proof.get("traceMetadataOnly"),
        "rawFrameEvents": proof.get("rawFrameEvents"),
        "B1_startup": proof["B1_startup"],
        "B2_resume": proof["B2_resume"],
        "B3_abort": proof["B3_abort"],
        "B4_orphans": proof["B4_orphans"],
        "orphanProof": proof["orphanProof"],
    }

    assert returncode == 0, json.dumps(raw_json_evidence, indent=2, sort_keys=True)
    assert proof["status"] == "PASS", json.dumps(raw_json_evidence, indent=2, sort_keys=True)
    assert proof["traceMetadataOnly"] is True
    assert proof["rawFrameEvents"] == 0
    assert proof["B1_startup"]["status"] == "PASS"
    assert proof["B1_startup"]["acceptedStatus"] == "accepted"
    assert proof["B1_startup"]["terminalStatus"] == "success"
    assert proof["B1_startup"]["agentEndObserved"] is True
    assert proof["B1_startup"]["getLastAssistantTextObserved"] is True
    assert proof["B1_startup"]["metadataOnlyTraceObserved"] is True
    assert proof["B2_resume"]["status"] == "PASS"
    assert proof["B2_resume"]["acceptedStatus"] == "accepted"
    assert proof["B2_resume"]["terminalStatus"] == "success"
    assert proof["B2_resume"]["switchSessionObserved"] is True
    assert proof["B2_resume"]["metadataOnlyTraceObserved"] is True
    assert proof["B3_abort"]["status"] == "PASS"
    assert proof["B3_abort"]["acceptedStatus"] == "accepted"
    assert proof["B3_abort"]["cancelStatus"] in {"cancelling", "cancelled"}
    assert proof["B3_abort"]["terminalStatus"] == "cancelled"
    assert proof["B3_abort"]["abortEvents"]
    assert proof["B3_abort"]["cleanupObserved"] is True
    assert proof["B3_abort"]["metadataOnlyTraceObserved"] is True
    assert proof["B4_orphans"]["status"] == "PASS"
    assert proof["B4_orphans"]["allObservedPids"]
    assert all(alive is False for alive in proof["B4_orphans"]["postCleanupPidAlive"].values())
    assert proof["B4_orphans"]["postCleanupPs"]["survivors"] == []


def test_runtime_smoke_async_subagent_background_contract_expected_red_records_json_evidence() -> None:
    """Expected-red: async accepted receipt, one callback, streaming command, non-TUI fallbacks."""

    payload, returncode, raw_stdout, raw_stderr = _run_runtime_scenario_raw(
        "async-subagent-contract", timeout=12.0
    )
    contract = payload["runtime"]["asyncSubagentContract"]
    assertion_groups = contract["assertionGroups"]
    raw_json_evidence = {
        "command": ["node", str(RUNTIME_SMOKE), "--scenario", "async-subagent-contract"],
        "exit_code": returncode,
        "raw_stdout": raw_stdout,
        "raw_stderr": raw_stderr,
        "status": contract["status"],
        "assertionGroups": assertion_groups,
        "acceptedTiming": contract["acceptedTiming"],
        "streamingCommandProbe": contract["streamingCommandProbe"],
        "modeMatrixFallbacks": contract["modeMatrixFallbacks"],
        "statusSchemaProbe": contract.get("statusSchemaProbe"),
        "deterministicOrchestrationProbe": contract.get("deterministicOrchestrationProbe"),
        "backgroundIndicatorProbe": contract.get("backgroundIndicatorProbe"),
        "cancelReasonBoundProbe": contract.get("cancelReasonBoundProbe"),
        "callbackShapeProbe": contract.get("callbackShapeProbe"),
        "idempotencyStaleProbe": contract.get("idempotencyStaleProbe"),
        "cancellationSourceRulesProbe": contract.get("cancellationSourceRulesProbe"),
        "abortGraceProbe": contract.get("abortGraceProbe"),
        "lifecycleCleanupProbe": contract.get("lifecycleCleanupProbe"),
        "docsParityProbe": contract.get("docsParityProbe"),
        "subagentConsoleRuntimeProbe": contract.get("subagentConsoleRuntimeProbe"),
        "callbackEntries": contract["callbackEntries"],
    }

    assert payload["package"]["piTuiDependency"]["hardGateStatus"] == "PASS", json.dumps(
        raw_json_evidence, indent=2, sort_keys=True
    )
    assert returncode == 0, json.dumps(raw_json_evidence, indent=2, sort_keys=True)
    assert contract["status"] == "PASS", json.dumps(raw_json_evidence, indent=2, sort_keys=True)
    assert assertion_groups == {
        "accepted_return_timing": {
            "acceptedStatus": True,
            "resultPendingTrue": True,
            "taskIdAllocated": True,
            "returnedBeforeTerminalOutput": True,
            "acceptedTextWarnsEvidencePending": True,
            "acceptedTextGuidesNoShellSleep": True,
            "noFinalOutputInAcceptedResult": True,
        },
        "callbacks": {
            "singleCallbackEvent": True,
            "callbackShape": True,
        },
        "streaming_command": {
            "hasUnifiedSlashCommand": True,
            "removedLogAliasNotRegistered": True,
            "runningEntryPresentBeforeDispatch": True,
            "invokedWhileParentStreaming": True,
            "streamingSlashCommandDispatch": True,
        },
        "mode_matrix_fallbacks": {
            "rpcListTextualNoOverlay": True,
            "rpcExactTextualNoOverlay": True,
            "printJsonExactSummary": True,
            "printJsonViewUnavailable": True,
            "printJsonCancelUnavailable": True,
            "printJsonClearUnavailable": True,
        },
        "status_schema_phase_result_pending_updated_at_error": {
            "statusToolRegistered": True,
            "activeRecordSchema": True,
            "runningRecordSchema": True,
            "terminalRecordSchema": True,
            "exactTaskIdOnly": True,
        },
        "deterministic_events_contract": {
            "eventsToolRegistered": True,
            "eventsReadObservedTask": True,
            "eventsCursorShape": True,
            "filteredCursorAdvancesWithoutFilesystemDiscovery": True,
            "retentionCursorRulesPinned": True,
            "noJoinTool": True,
        },
        "deterministic_wait_select_contract": {
            "waitToolRegistered": True,
            "selectToolRegistered": True,
            "waitAllTerminalSatisfied": True,
            "waitAnyTerminalSatisfied": True,
            "waitFirstErrorIgnoresSuccessfulCallbackDeliveryDiagnostics": True,
            "waitUnobservedExactHandleErrors": True,
            "selectMatchesWaitAnyModel": True,
        },
        "background_activity_indicator_count_only": {
            "activeCountOnlyTextObserved": True,
            "taskTextAndHandleHidden": True,
            "noControlSurfaceText": True,
            "idleOrHiddenAfterTerminal": True,
        },
        "failed_cancelled_callback_shape": {
            "failedCallbackShape": True,
            "cancelledCallbackShape": True,
        },
        "callback_idempotency_duplicate_suppression": {
            "duplicateCallbackSuppressed": True,
            "staleLateCallbackSuppressed": True,
        },
        "cancellation_source_rules_sibling_parent_non_cancel_and_callback_suppression": {
            "taskACancelled": True,
            "siblingBNotCancelled": True,
            "parentNotAborted": True,
            "modelTerminalCancelSuppressesDuplicateCallback": True,
            "userOrConsoleCancelDeliversCallback": True,
        },
        "abort_kill_grace_1500ms": {
            "expectedGraceRecorded": True,
            "sourceUses1500Grace": True,
            "noFiveSecondAbortFallback": True,
            "nonresponsiveAccepted": True,
            "nonresponsiveCancelled": True,
            "nonresponsiveElapsedWithinSingleDeadline": True,
            "nonresponsiveKillObserved": True,
            "nonresponsiveTraceDeadlineRecorded": True,
            "nonresponsiveKillAtSingleDeadline": True,
        },
        "runtime_lifecycle_stale_cleanup": {
            "reloadCleanup": True,
            "resumeCleanup": True,
            "forkCleanup": True,
            "quitCleanup": True,
        },
        "docs_parity_against_reference": {
            "authorityReviewed": True,
            "readmeNamesCanonicalSubagent": True,
            "removedLogAliasDocumented": True,
            "sourceRegistersCanonicalCommand": True,
            "sourceRegistersStatusAndCancelTools": True,
        },
        "subagent_console_runtime": {
            "consolePaneSummaryObserved": True,
            "consolePanePromptObserved": True,
            "consolePaneOutputObserved": True,
            "consolePaneTimelineObserved": True,
            "consolePaneMetadataObserved": True,
            "exactSelectedCancelRouteRegistered": True,
            "exactSelectedCancelInvokedCanonicalRoute": True,
            "exactSelectedCancelTargetsSelectedTask": True,
            "exactSelectedCancelPreservesSibling": True,
            "exactSelectedCancelPreservesParent": True,
            "rendererBoundsAllLinesFit": True,
            "rendererBoundsPromptSafe": True,
            "rendererBoundsOutputSafe": True,
            "rendererBoundsTimelineSafe": True,
            "rendererBoundsMetadataSafe": True,
            "canonicalClearRouteRegistered": True,
            "canonicalClearClearsPresentationOnly": True,
            "clearDeletesNoChildSessionFiles": True,
            "clearPreservesParentState": True,
            "legacyClearDemonstratesAdapterLocalSemanticsOnly": True,
        },
        "cancel_reason_bound_500_and_overlong_bad_input": {
            "exact500NormalizedCodePoints": True,
            "overlongNormalizedCodePoints": True,
            "exact500AcceptedForCancellation": True,
            "overlongRejectedAsBadInput": True,
        },
    }, json.dumps(raw_json_evidence, indent=2, sort_keys=True)



def test_runtime_smoke_wait_select_pending_callback_handoff_expected_red_records_gap() -> None:
    """Expected-red: terminal wait/select readiness must hand off to pending result callback."""
    payload, returncode, raw_stdout, raw_stderr = _run_runtime_scenario_raw(
        "wait-select-pending-callback-handoff", timeout=8.0
    )
    contract = payload["runtime"]["waitSelectPendingCallbackHandoff"]
    raw_json_evidence = {
        "command": ["node", str(RUNTIME_SMOKE), "--scenario", "wait-select-pending-callback-handoff"],
        "exit_code": returncode,
        "raw_stdout": raw_stdout,
        "raw_stderr": raw_stderr,
        "status": contract["status"],
        "failure_fingerprints": contract["failureFingerprints"],
        "expected_recommended_next_action": contract["expectedRecommendedNextAction"],
        "observed_recommended_next_actions": contract["observedRecommendedNextActions"],
        "assertions": contract["assertions"],
        "contract": contract,
    }

    assert returncode == 0, json.dumps(raw_json_evidence, indent=2, sort_keys=True)
    assert contract["status"] == "PASS", json.dumps(raw_json_evidence, indent=2, sort_keys=True)


def test_real_pi_persona_invocation_bus_bad_input_result_via_shared_events(tmp_path: Path) -> None:
    """Regression: trusted Pi extensions request PIINV over documented pi.events bus."""

    if shutil.which("pi") is None:
        pytest.skip("pi is required for real persona invocation event-bus regression")

    probe_path = tmp_path / "persona-invocation-probe.ts"
    probe_path.write_text(
        textwrap.dedent(
            '''
            export default function(pi: any) {
              let currentCtx: any;
              const results: any[] = [];

              pi.events?.on?.("larva:persona-invocation:result", (result: any) => {
                results.push(result);
                currentCtx?.ui?.notify?.(`PIINV_RESULT ${JSON.stringify(result)}`, "info");
              });

              pi.on?.("session_start", async (_event: unknown, ctx: any) => {
                currentCtx = ctx;
                const surface = {
                  piOn: typeof pi.on,
                  piEmit: typeof pi.emit,
                  piEventsOn: typeof pi.events?.on,
                  piEventsEmit: typeof pi.events?.emit,
                };
                ctx.ui?.notify?.(`PIINV_SURFACE ${JSON.stringify(surface)}`, "info");
                pi.events?.emit?.("larva:persona-invocation:request", {
                  request_id: "11111111-1111-4111-8111-111111111111",
                  persona_id: "",
                  prompt: "probe",
                  timeout_ms: 10,
                });
                setTimeout(() => {
                  ctx.ui?.notify?.(`PIINV_RESULTS_COUNT ${results.length}`, "info");
                }, 300);
              });
            }
            '''
        ),
        encoding="utf-8",
    )

    runner = f"""
        import {{ spawn }} from 'node:child_process';
        import {{ StringDecoder }} from 'node:string_decoder';

        const args = [
          '--mode', 'rpc',
          '--no-session',
          '--no-extensions',
          '--no-context-files',
          '--no-skills',
          '--no-prompt-templates',
          '--no-themes',
          '--offline',
          '--approve',
          '-e', {json.dumps(str(EXTENSION))},
          '-e', {json.dumps(str(probe_path))},
        ];
        const child = spawn('pi', args, {{
          cwd: {json.dumps(str(ROOT))},
          env: {{ ...process.env, PI_OFFLINE: '1', LARVA_PI_AGENT_PERSONA_SWITCH: 'manual' }},
          stdio: ['pipe', 'pipe', 'pipe'],
        }});
        const interesting = [];
        const stderr = [];
        let settled = false;
        let timeoutHandle;

        function finish(timedOut = false) {{
          if (settled) return;
          settled = true;
          if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
          child.kill('SIGTERM');
          const surface = interesting.find((event) => event.message?.startsWith('PIINV_SURFACE '));
          const result = interesting.find((event) => event.message?.startsWith('PIINV_RESULT '));
          const count = interesting.find((event) => event.message?.startsWith('PIINV_RESULTS_COUNT '));
          console.log(JSON.stringify({{
            command: ['pi', ...args],
            timedOut,
            surface: surface?.message ?? null,
            result: result?.message ?? null,
            count: count?.message ?? null,
            interesting,
            stderr: stderr.join(''),
          }}));
          process.exit(0);
        }}

        const decoder = new StringDecoder('utf8');
        let buffer = '';
        child.stdout.on('data', (chunk) => {{
          buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
          while (true) {{
            const index = buffer.indexOf('\\n');
            if (index < 0) break;
            let line = buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            if (line.endsWith('\\r')) line = line.slice(0, -1);
            try {{
              const event = JSON.parse(line);
              if (event.type === 'extension_ui_request' && event.method === 'notify') {{
                interesting.push(event);
                if (event.message?.startsWith('PIINV_RESULTS_COUNT ')) finish(false);
              }}
            }} catch (error) {{
              interesting.push({{ parseError: String(error), line }});
            }}
          }}
        }});
        child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
        child.on('exit', () => finish(false));
        timeoutHandle = setTimeout(() => finish(true), 5000);
    """
    payload = _run_node_inline(tmp_path, textwrap.dedent(runner), timeout=8.0)
    evidence = json.dumps(payload, indent=2, sort_keys=True)

    assert payload["timedOut"] is False, evidence
    assert payload["stderr"] == "", evidence
    assert payload["surface"] is not None, evidence
    assert payload["result"] is not None, evidence
    assert payload["count"] == "PIINV_RESULTS_COUNT 1", evidence

    surface = json.loads(payload["surface"].removeprefix("PIINV_SURFACE "))
    assert surface == {
        "piOn": "function",
        "piEmit": "undefined",
        "piEventsOn": "function",
        "piEventsEmit": "function",
    }, evidence

    result = json.loads(payload["result"].removeprefix("PIINV_RESULT "))
    assert result == {
        "request_id": "11111111-1111-4111-8111-111111111111",
        "status": "failed",
        "persona_id": "",
        "final_text": "",
        "error": {
            "code": "LARVA_PERSONA_INVOCATION_BAD_INPUT",
            "message": "persona_id must be a non-empty string.",
        },
    }, evidence


def test_runtime_smoke_persona_invocation_bus_records_contract_anchor_fingerprints() -> None:
    """Source-level contract anchors for extension-facing PIINV event bus stay present."""
    payload, returncode, raw_stdout, raw_stderr = _run_runtime_scenario_raw(
        "persona-invocation-bus", timeout=8.0
    )
    contract = payload["runtime"]["personaInvocationBus"]
    anchors = [row["machine_anchor"] for row in contract["checks"]]
    raw_json_evidence = {
        "command": ["node", str(RUNTIME_SMOKE), "--scenario", "persona-invocation-bus"],
        "exit_code": returncode,
        "raw_stdout": raw_stdout,
        "raw_stderr": raw_stderr,
        "status": contract["status"],
        "fingerprints": contract["fingerprints"],
        "anchors": anchors,
    }

    assert contract["forbiddenInfrastructureFingerprintsAbsent"] is True, json.dumps(
        raw_json_evidence, indent=2, sort_keys=True
    )
    assert contract["terminalRaceAnchorsPresent"] is True, json.dumps(
        raw_json_evidence, indent=2, sort_keys=True
    )
    assert returncode == 0, json.dumps(raw_json_evidence, indent=2, sort_keys=True)
    assert contract["status"] == "PASS", json.dumps(raw_json_evidence, indent=2, sort_keys=True)
