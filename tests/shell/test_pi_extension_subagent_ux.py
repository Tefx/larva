"""Expected-red tests for Pi ``larva_subagent`` UX/runtime contracts.

These tests intentionally define runtime/probe behavior required by
``design/pi-coding-agent-integration.md`` before the downstream implementation
step lands.  They are limited to test harness code and do not change product
implementation logic.  At least one assertion is expected-red until the product
adds the required realtime subagent log overlay command/surface.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import textwrap
from pathlib import Path
from typing import Any, Final

import pytest


ROOT: Final = Path(__file__).resolve().parents[2]
EXTENSION: Final = ROOT / "contrib" / "pi-extension" / "larva.ts"
FAKE_CLI: Final = ROOT / "tests" / "fixtures" / "pi" / "fake-larva-cli.mjs"


def _run_node(tmp_path: Path, script: str, *, timeout: float = 8.0) -> dict[str, Any]:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is required for Pi extension expected-red runtime tests")
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


def _node_prelude(tmp_path: Path) -> str:
    return f"""
        import {{ mkdir, writeFile }} from "node:fs/promises";
        import {{ join }} from "node:path";
        const mod = await import({json.dumps(EXTENSION.as_uri())});
        const fakeCli = {json.dumps(str(FAKE_CLI))};
        const tmpRoot = {json.dumps(str(tmp_path))};
        const childRoot = join(tmpRoot, "child-sessions");
        await mkdir(childRoot, {{ recursive: true }});
        const baseEnv = (extra = {{}}) => ({{
          LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, fakeCli]),
          LARVA_PI_REAL_BIN: process.execPath,
          LARVA_PI_EXTENSION_FLAG: "-e",
          LARVA_PI_EXTENSION_ENTRY: "fake-extension-entry.ts",
          LARVA_PI_CHILD_SESSION_DIR: childRoot,
          HOME: tmpRoot,
          ...extra,
        }});
        const modelRegistry = {{ find: () => ({{ provider: "openai-codex", model: "gpt-5.5" }}) }};
        const piBase = {{
          setModel: () => true,
          getAllTools: () => ["read", "grep", "larva_subagent"],
          setActiveTools: () => true,
          on: () => undefined,
        }};
        async function writeFakeChild(path, scenario = "success") {{
          await writeFile(path, `#!/usr/bin/env node
            import {{ createInterface }} from "node:readline";
            import {{ mkdir, writeFile }} from "node:fs/promises";
            import {{ join }} from "node:path";
            const root = process.argv[process.argv.length - 1];
            await mkdir(root, {{ recursive: true }});
            const sessionFile = join(root, "child-${{Date.now()}}.jsonl");
            const rl = createInterface({{ input: process.stdin }});
            function send(value) {{ process.stdout.write(JSON.stringify(value) + "\\\\n"); }}
            rl.on("line", async (line) => {{
              const msg = JSON.parse(line);
              if (msg.type === "get_state") {{ await writeFile(sessionFile, "{{}}\\\\n"); send({{ id: msg.id, success: true, data: {{ sessionFile }} }}); }}
              else if (msg.type === "switch_session") {{ send({{ id: msg.id, success: true, data: {{ cancelled: false }} }}); }}
              else if (msg.type === "prompt") {{ send({{ id: msg.id, success: true }}); setTimeout(() => send({{ type: "agent_end" }}), 5); }}
              else if (msg.type === "get_last_assistant_text") {{
                if (${{JSON.stringify(scenario)}} === "malformed-final") send({{ id: msg.id, success: true, data: {{ text: null }} }});
                else send({{ id: msg.id, success: true, data: {{ text: "final child output" }} }});
                setTimeout(() => process.exit(0), 1);
              }}
              else if (msg.type === "abort") {{ send({{ id: msg.id, success: true }}); process.exit(0); }}
            }});
          `, {{ mode: 0o755 }});
        }}
        async function registeredTools(env = baseEnv(), extraPi = {{}}) {{
          const tools = [];
          const ctx = {{ env, modelRegistry, ui: {{ setStatus: () => undefined }} }};
          await mod.initializeExtension(ctx, {{ ...piBase, ...extraPi, registerTool: (tool) => tools.push(tool) }});
          return {{ tools, ctx }};
        }}
        function mirrorOk(result) {{
          return ["task_id", "persona_id", "status", "result_text", "error"].every((key) =>
            JSON.stringify(result[key]) === JSON.stringify(result.details?.[key])
          );
        }}
    """


def test_larva_subagent_toolresult_wrapper_footer_and_lifecycle_paths(tmp_path: Path) -> None:
    """Pin ToolResult wrapper mirrors, footer rules, and major terminal paths."""

    payload = _run_node(
        tmp_path,
        _node_prelude(tmp_path)
        + """
        const childBin = join(tmpRoot, "fake-pi-child.mjs");
        await writeFakeChild(childBin, "success");
        const { tools, ctx } = await registeredTools(baseEnv({ LARVA_PI_REAL_BIN: childBin, LARVA_PI_EXTENSION_ENTRY: childBin }));
        await mod.commitPersona("ok", ctx, piBase);
        const subagent = tools.find((tool) => tool.name === "larva_subagent");
        const success = await subagent.handler({ persona_id: "ok", task: "summarize child result" });
        const failedBeforeSession = await subagent.handler({ persona_id: "ok", task: "" });

        const malformedChild = join(tmpRoot, "fake-pi-child-malformed.mjs");
        await writeFakeChild(malformedChild, "malformed-final");
        const afterEnv = baseEnv({ LARVA_PI_REAL_BIN: malformedChild, LARVA_PI_EXTENSION_ENTRY: malformedChild });
        const after = await registeredTools(afterEnv);
        await mod.commitPersona("ok", { env: afterEnv, modelRegistry }, piBase);
        const failedAfterAllocation = await after.tools.find((tool) => tool.name === "larva_subagent").handler({ persona_id: "ok", task: "fail after allocation" });

        const resumePath = join(childRoot, "resume-known.jsonl");
        await writeFile(resumePath, "{}\\n");
        const controller = new AbortController();
        controller.abort();
        const cancelled = await subagent.execute("call-1", { persona_id: "ok", task: "resume then abort", task_id: resumePath }, controller.signal, () => undefined, ctx);

        const policyPath = join(tmpRoot, "deny-subagent-policy.json");
        await writeFile(policyPath, JSON.stringify({ personas: { ok: { deny: ["larva_subagent"] } } }));
        await mod.commitPersona("ok", { env: baseEnv({ LARVA_PI_TOOL_POLICY_FILE: policyPath }), modelRegistry }, piBase);
        const policyDenied = mod.decideToolCall("larva_subagent");

        console.log(JSON.stringify({
          toolNames: tools.map((tool) => tool.name),
          success: {
            mirrorOk: mirrorOk(success),
            isError: success.isError,
            task_id: success.task_id,
            detailsTaskId: success.details?.task_id,
            text: success.content?.[0]?.text,
            hasFooter: /Larva subagent session:[\\s\\S]*persona_id: ok[\\s\\S]*task_id: .*\\.jsonl[\\s\\S]*reuse: pass this exact task_id to larva_subagent/.test(success.content?.[0]?.text ?? ""),
          },
          failedBeforeSession: {
            mirrorOk: mirrorOk(failedBeforeSession),
            status: failedBeforeSession.status,
            isError: failedBeforeSession.isError,
            task_id: failedBeforeSession.task_id,
            noFooter: !(failedBeforeSession.content?.[0]?.text ?? "").includes("Larva subagent session:"),
          },
          failedAfterAllocation: {
            mirrorOk: mirrorOk(failedAfterAllocation),
            status: failedAfterAllocation.status,
            isError: failedAfterAllocation.isError,
            task_id: failedAfterAllocation.task_id,
            errorCode: failedAfterAllocation.error?.code,
            hasFooter: (failedAfterAllocation.content?.[0]?.text ?? "").includes("Larva subagent session:"),
          },
          cancelled: {
            mirrorOk: mirrorOk(cancelled),
            status: cancelled.status,
            isError: cancelled.isError,
            task_id: cancelled.task_id,
            errorCode: cancelled.error?.code,
            hasFooter: (cancelled.content?.[0]?.text ?? "").includes("Larva subagent session:"),
          },
          policyDenied: {
            action: policyDenied.action,
            errorCode: policyDenied.error?.code,
            noLarvaSubagentResult: !("details" in policyDenied) && !("content" in policyDenied) && !("task_id" in policyDenied),
          },
        }, null, 2));
        """,
    )

    assert "larva_subagent" in payload["toolNames"]
    assert payload["success"]["mirrorOk"] is True
    assert payload["success"]["isError"] is False
    assert payload["success"]["task_id"] == payload["success"]["detailsTaskId"]
    assert payload["success"]["hasFooter"] is True
    assert payload["failedBeforeSession"] == {
        "mirrorOk": True,
        "status": "failed",
        "isError": True,
        "task_id": None,
        "noFooter": True,
    }
    assert payload["failedAfterAllocation"]["mirrorOk"] is True
    assert payload["failedAfterAllocation"]["status"] == "failed"
    assert payload["failedAfterAllocation"]["isError"] is True
    assert payload["failedAfterAllocation"]["task_id"] is not None
    assert payload["failedAfterAllocation"]["hasFooter"] is True
    assert payload["cancelled"]["mirrorOk"] is True
    assert payload["cancelled"]["status"] == "cancelled"
    assert payload["cancelled"]["isError"] is True
    assert payload["cancelled"]["hasFooter"] is True
    assert payload["policyDenied"] == {
        "action": "deny",
        "errorCode": "LARVA_TOOL_DENIED",
        "noLarvaSubagentResult": True,
    }


def test_larva_subagent_sessions_helper_contract_limits_index_and_no_aliases(tmp_path: Path) -> None:
    """Pin optional recent-session helper shape, limits, retention, and non-goals."""

    payload = _run_node(
        tmp_path,
        _node_prelude(tmp_path)
        + """
        const childBin = join(tmpRoot, "fake-pi-child.mjs");
        await writeFakeChild(childBin, "success");
        const env = baseEnv({ LARVA_PI_REAL_BIN: childBin, LARVA_PI_EXTENSION_ENTRY: childBin });
        const { tools, ctx } = await registeredTools(env);
        await mod.commitPersona("ok", ctx, piBase);
        const subagent = tools.find((tool) => tool.name === "larva_subagent");
        const sessions = tools.find((tool) => tool.name === "larva_subagent_sessions");
        for (let index = 0; index < 27; index += 1) {
          await subagent.handler({ persona_id: "ok", task: `remember ${index}` });
        }
        const defaultResult = sessions ? await sessions.handler({}) : null;
        const maxResult = sessions ? await sessions.handler({ limit: 25 }) : null;
        const invalidResults = sessions ? await Promise.all([0, -1, 26, 1.5, "last"].map((limit) => sessions.handler({ limit }))) : [];
        console.log(JSON.stringify({
          toolNames: tools.map((tool) => tool.name),
          hasSessionsHelper: Boolean(sessions),
          defaultCount: defaultResult?.details?.sessions?.length ?? null,
          maxCount: maxResult?.details?.sessions?.length ?? null,
          newestFirst: maxResult ? maxResult.details.sessions.every((item, index, array) => index === 0 || array[index - 1].sequence > item.sequence) : false,
          evictedOldest: maxResult ? Math.min(...maxResult.details.sessions.map((item) => item.sequence)) === 3 : false,
          successShape: maxResult ? {
            status: maxResult.details.status,
            isError: maxResult.isError,
            error: maxResult.details.error,
            noTopLevelSessions: !("sessions" in maxResult),
            noAlias: maxResult.details.sessions.every((item) => item.task_id !== "last"),
          } : null,
          invalidShapes: invalidResults.map((result) => ({
            text: result.content?.[0]?.text,
            isError: result.isError,
            status: result.details?.status,
            sessions: result.details?.sessions,
            errorCode: result.details?.error?.code,
            noTopLevelSessions: !("sessions" in result),
          })),
        }, null, 2));
        """,
    )

    assert "larva_subagent_sessions" in payload["toolNames"]
    assert payload["hasSessionsHelper"] is True
    assert payload["defaultCount"] == 10
    assert payload["maxCount"] == 25
    assert payload["newestFirst"] is True
    assert payload["evictedOldest"] is True
    assert payload["successShape"] == {
        "status": "success",
        "isError": False,
        "error": None,
        "noTopLevelSessions": True,
        "noAlias": True,
    }
    assert payload["invalidShapes"] == [
        {
            "text": "LARVA_BAD_INPUT: limit must be an integer from 1 to 25.",
            "isError": True,
            "status": "failed",
            "sessions": [],
            "errorCode": "LARVA_BAD_INPUT",
            "noTopLevelSessions": True,
        }
    ] * 5


def test_larva_subagent_render_hooks_and_visible_preview_bounds(tmp_path: Path) -> None:
    """Pin row-local renderCall/onUpdate hooks and deterministic preview bounds."""

    payload = _run_node(
        tmp_path,
        _node_prelude(tmp_path)
        + """
        const { tools } = await registeredTools();
        const subagent = tools.find((tool) => tool.name === "larva_subagent");
        const cjkTask = "这是一个用于测试 subagent 功能的长时间任务。".repeat(8);
        const ansiUnicodeTask = "\\u001b[31mCafe\\u0301\\u001b[0m\\n" + "x".repeat(180) + "\\u0007tail";
        const longTaskId = join(childRoot, "nested", "segment", "with", "very", "long", "resume-session-name-that-must-be-abbreviated.jsonl");
        const callNew = subagent?.renderCall?.({ persona_id: "turing", task: ansiUnicodeTask });
        const callResume = subagent?.renderCall?.({ persona_id: "turing", task: ansiUnicodeTask, task_id: longTaskId });
        const cjkCall = subagent?.renderCall?.({ persona_id: "turing", task: cjkTask });
        const visibleWidth = (line) => Array.from(String(line)).reduce((width, char) => {
          const codePoint = char.codePointAt(0);
          if (codePoint === undefined || codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return width;
          return width + (codePoint >= 0x20 && codePoint <= 0x7e ? 1 : 2);
        }, 0);
        const cjkLines = typeof cjkCall?.render === "function" ? cjkCall.render(40) : [];
        const updates = [];
        if (subagent?.execute) {
          try {
            await subagent.execute("call-progress", { persona_id: "turing", task: ansiUnicodeTask }, undefined, (update) => updates.push(update), { env: baseEnv(), modelRegistry });
          } catch (_) {}
        }
        const previewText = String(callNew?.text ?? callNew ?? "");
        const resumeText = String(callResume?.text ?? callResume ?? "");
        const updateTexts = updates.map((update) => String(update?.text ?? update?.content ?? update));
        const updateContentSafe = updates.length > 0 && updates.every((update) => Array.isArray(update?.content) && update.content.some((item) => item?.type === "text" && typeof item.text === "string"));
        const normalized = "Café " + "x".repeat(180) + " tail";
        console.log(JSON.stringify({
          hookTypes: {
            renderCall: typeof subagent?.renderCall,
            renderResult: typeof subagent?.renderResult,
            executeHasOnUpdateArity: (subagent?.execute?.length ?? 0) >= 4,
          },
          componentShapes: {
            callNewRenderable: typeof callNew?.render === "function" && Array.isArray(callNew.render(80)),
            callResumeRenderable: typeof callResume?.render === "function" && Array.isArray(callResume.render(80)),
            cjkLinesFit: cjkLines.length > 0 && cjkLines.every((line) => visibleWidth(line) <= 40),
          },
          callNew: previewText,
          callResume: resumeText,
          updateTexts,
          newPreviewBounded: previewText.includes("Café") && !previewText.includes("\\u001b") && !previewText.includes("\\n") && previewText.length <= 120 && previewText.includes("…"),
          resumeIdBounded: /task_id: .{1,80}/.test(resumeText) && !resumeText.includes(longTaskId),
          updateBounded: updateTexts.length > 0 && updateTexts.every((text) => !text.includes("\\u001b") && !text.includes("\\n") && text.length <= 200),
          updateContentSafe,
          noFullTranscriptStreaming: updateTexts.every((text) => !text.includes(normalized)),
        }, null, 2));
        """,
    )

    assert payload["hookTypes"] == {"renderCall": "function", "renderResult": "function", "executeHasOnUpdateArity": True}
    assert payload["componentShapes"] == {"callNewRenderable": True, "callResumeRenderable": True, "cjkLinesFit": True}
    assert payload["newPreviewBounded"] is True
    assert payload["resumeIdBounded"] is True
    assert payload["updateBounded"] is True
    assert payload["updateContentSafe"] is True
    assert payload["noFullTranscriptStreaming"] is True


def test_vt46_render_result_final_views_parent_footer_and_no_dashboard(tmp_path: Path) -> None:
    """Pin VT46 collapsed/expanded final views and parent footer isolation."""

    payload = _run_node(
        tmp_path,
        _node_prelude(tmp_path)
        + """
        const statuses = [];
        const ctx = { env: baseEnv(), modelRegistry, ui: { setStatus: (key, value) => statuses.push([key, value]) } };
        const tools = [];
        await mod.initializeExtension(ctx, { ...piBase, registerTool: (tool) => tools.push(tool) });
        await mod.commitPersona("ok", ctx, piBase);
        const subagent = tools.find((tool) => tool.name === "larva_subagent");
        const finalResult = {
          task_id: join(childRoot, "known.jsonl"),
          persona_id: "turing",
          status: "failed",
          result_text: "final output body",
          error: { code: "LARVA_CHILD_PROTOCOL_FAILED", message: "boom" },
          content: [{ type: "text", text: ["LARVA_CHILD_PROTOCOL_FAILED: boom", "---", "Larva subagent session:", "persona_id: turing", "task_id: " + join(childRoot, "known.jsonl"), "reuse: pass this exact task_id to larva_subagent"].join("\\n") }],
          details: {
            task_id: join(childRoot, "known.jsonl"),
            persona_id: "turing",
            status: "failed",
            result_text: "final output body",
            error: { code: "LARVA_CHILD_PROTOCOL_FAILED", message: "boom" },
          },
          isError: true,
        };
        const call = { persona_id: "turing", task: "full task text", task_id: finalResult.task_id };
        const collapsed = subagent?.renderResult?.(finalResult, { expanded: false, input: call });
        const expanded = subagent?.renderResult?.(finalResult, { expanded: true, input: call });
        const collapsedText = String(collapsed?.text ?? collapsed ?? "");
        const expandedText = String(expanded?.text ?? expanded ?? "");
        console.log(JSON.stringify({
          componentShapes: {
            collapsedRenderable: typeof collapsed?.render === "function" && Array.isArray(collapsed.render(80)),
            expandedRenderable: typeof expanded?.render === "function" && Array.isArray(expanded.render(80)),
          },
          collapsedText,
          expandedText,
          statuses,
          collapsedHasPersonaAndTerminalState: collapsedText.includes("turing") && collapsedText.includes("failed"),
          expandedHasIndependentFields: [
            "persona_id: turing",
            "mode: resume",
            "full task text",
            finalResult.task_id,
            "status: failed",
            "LARVA_CHILD_PROTOCOL_FAILED",
            "final output body",
            "reuse: pass this exact task_id to larva_subagent",
          ].every((needle) => expandedText.includes(needle)),
          parentFooterPreserved: statuses.some(([key, value]) => key === "larva" && value === "ok"),
          noWidgetDashboard: !/dashboard|widget/i.test(`${collapsedText}\\n${expandedText}`),
        }, null, 2));
        """,
    )

    assert payload["componentShapes"] == {"collapsedRenderable": True, "expandedRenderable": True}
    assert payload["collapsedHasPersonaAndTerminalState"] is True
    assert payload["expandedHasIndependentFields"] is True
    assert payload["parentFooterPreserved"] is True
    assert payload["noWidgetDashboard"] is True


def test_runtime_probe_records_pi_package_and_hard_gate_statuses() -> None:
    """Runtime probe records Pi package/version evidence and hard-gate statuses."""

    node = shutil.which("node")
    if node is None:
        pytest.skip("node is required for Pi extension runtime smoke")
    completed = subprocess.run(
        [node, str(ROOT / "scripts" / "pi-extension-runtime-smoke.mjs"), "--scenario", "capability-gates"],
        check=False,
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert completed.returncode == 0, completed.stderr
    payload = json.loads(completed.stdout)

    assert payload["package"]["packageRoot"]
    assert "versionExitCode" in payload["package"]
    assert "commitExitCode" in payload["package"]
    assert payload["runtime"]["hardGates"]["extensionLoading"]["evidence"]["helpExitCode"] is not None
    assert payload["runtime"]["hardGates"]["rpcJsonl"]["evidence"]["commands"] == [
        "get_state",
        "prompt",
        "switch_session",
        "get_last_assistant_text",
        "abort",
    ]
    assert payload["runtime"]["hardGates"]["subagentToolRowProgress"]["supported"] is True


def test_subagent_log_overlay_command_expected_red_without_live_credentials() -> None:
    """Expose the realtime/log UI gap without depending on live Pi credentials."""

    node = shutil.which("node")
    if node is None:
        pytest.skip("node is required for Pi extension runtime smoke")
    completed = subprocess.run(
        [node, str(ROOT / "scripts" / "pi-extension-runtime-smoke.mjs"), "--scenario", "capability-gates"],
        check=False,
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert completed.returncode == 0, completed.stderr
    payload = json.loads(completed.stdout)
    gate = payload["runtime"]["hardGates"]["subagentLogOverlayCommand"]

    assert gate["evidence"]["requiredCommand"] == "larva-subagent-log"
    assert "larva-persona" in gate["evidence"]["registeredCommandNames"]
    assert gate["supported"] is True


def test_documented_external_format_fixtures_and_negative_non_goals() -> None:
    """Fixtures pin exact documented formats and reject convenience-only aliases."""

    documented_launcher_env = {
        "LARVA_PI_INITIAL_PERSONA_ID": "child",
        "LARVA_PI_REAL_BIN": "/abs/bin/pi",
        "LARVA_PI_EXTENSION_FLAG": "-e",
        "LARVA_PI_EXTENSION_ENTRY": "/abs/contrib/pi-extension/larva.ts",
        "LARVA_CLI_ARGV_JSON": ["/abs/bin/larva"],
        "LARVA_PI_INTERACTIVE_TUI": "0",
    }
    documented_rpc_commands = [
        {"id": "state-1", "type": "get_state"},
        {"id": "prompt-1", "type": "prompt", "message": "task"},
        {"id": "switch-1", "type": "switch_session", "sessionPath": "/abs/root/child.jsonl"},
        {"id": "last-1", "type": "get_last_assistant_text"},
    ]
    documented_tool_result = {
        "content": [{"type": "text", "text": "child final text"}],
        "task_id": "/abs/root/child.jsonl",
        "persona_id": "child",
        "status": "success",
        "result_text": "child final text",
        "error": None,
        "details": {
            "task_id": "/abs/root/child.jsonl",
            "persona_id": "child",
            "status": "success",
            "result_text": "child final text",
            "error": None,
        },
        "isError": False,
    }
    negative_resume_aliases = ["last", "latest", "previous"]
    negative_sidecar_names = ["child.jsonl.larva", "child.jsonl.meta", "child.sidecar.json"]

    assert set(documented_launcher_env) == {
        "LARVA_PI_INITIAL_PERSONA_ID",
        "LARVA_PI_REAL_BIN",
        "LARVA_PI_EXTENSION_FLAG",
        "LARVA_PI_EXTENSION_ENTRY",
        "LARVA_CLI_ARGV_JSON",
        "LARVA_PI_INTERACTIVE_TUI",
    }
    assert [command["type"] for command in documented_rpc_commands] == [
        "get_state",
        "prompt",
        "switch_session",
        "get_last_assistant_text",
    ]
    assert documented_tool_result["details"] == {
        key: documented_tool_result[key]
        for key in ("task_id", "persona_id", "status", "result_text", "error")
    }
    assert all(alias not in json.dumps(documented_tool_result) for alias in negative_resume_aliases)
    assert all(not name.endswith(".jsonl") for name in negative_sidecar_names)
