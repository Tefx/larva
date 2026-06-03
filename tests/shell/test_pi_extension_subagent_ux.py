"""Green regression tests for Pi ``larva_subagent`` UX/runtime contracts.

These tests verify runtime/probe behavior required by
``design/pi-coding-agent-integration.md`` against the implemented Pi extension.
They remain test-harness only and cover the subagent result, resume, lifecycle,
and realtime log overlay surfaces without changing product logic.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import textwrap
from pathlib import Path
from typing import Any, Final

import pytest
from wcwidth import wcswidth

ROOT: Final = Path(__file__).resolve().parents[2]
EXTENSION: Final = ROOT / "contrib" / "pi-extension" / "larva.ts"
FAKE_CLI: Final = ROOT / "tests" / "fixtures" / "pi" / "fake-larva-cli.mjs"


def _run_node(tmp_path: Path, script: str, *, timeout: float = 8.0) -> dict[str, Any]:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is required for Pi extension runtime regression tests")
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
        import {{ createRequire }} from "node:module";
        const piTuiRequire = createRequire({json.dumps(EXTENSION.as_uri())});
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
          LARVA_PI_LAUNCHED: "1",
          LARVA_PI_INITIAL_PERSONA_ID: "",
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


def test_larva_subagent_resume_task_id_path_taxonomy_prevents_launch(tmp_path: Path) -> None:
    """Pin public resume task_id validation codes before child launch."""

    payload = _run_node(
        tmp_path,
        _node_prelude(tmp_path)
        + """
        const { access, chmod, symlink } = await import("node:fs/promises");
        const marker = join(tmpRoot, "spawned.txt");
        const childBin = join(tmpRoot, "must-not-spawn.mjs");
        await writeFile(childBin, `#!/usr/bin/env node
          import { writeFile } from "node:fs/promises";
          await writeFile(process.env.LARVA_FAKE_SPAWN_MARKER, "spawned");
          setInterval(() => undefined, 1000);
        `, { mode: 0o755 });
        const outsideRoot = join(tmpRoot, "outside-root");
        const outsideFile = join(outsideRoot, "outside.jsonl");
        await mkdir(outsideRoot, { recursive: true });
        await writeFile(outsideFile, "{}\\n");
        const env = baseEnv({
          LARVA_PI_REAL_BIN: process.execPath,
          LARVA_PI_EXTENSION_FLAG: childBin,
          LARVA_PI_EXTENSION_ENTRY: "ignored-extension-entry.ts",
          LARVA_FAKE_SPAWN_MARKER: marker,
        });
        const { tools, ctx } = await registeredTools(env);
        await mod.commitPersona("ok", { env, modelRegistry }, piBase);
        const subagent = tools.find((tool) => tool.name === "larva_subagent");
        const wrongSuffix = join(childRoot, "wrong.txt");
        const missing = join(childRoot, "missing.jsonl");
        const symlinkEscape = join(childRoot, "escape.jsonl");
        const directory = join(childRoot, "directory.jsonl");
        const unreadable = join(childRoot, "unreadable.jsonl");
        await writeFile(wrongSuffix, "{}\\n");
        await symlink(outsideFile, symlinkEscape);
        await mkdir(directory, { recursive: true });
        await writeFile(unreadable, "{}\\n");
        await chmod(unreadable, 0o000);
        async function invoke(task_id) {
          const result = await subagent.handler({ persona_id: "ok", task: "resume validation", task_id });
          return { status: result.status, task_id: result.task_id, errorCode: result.error?.code ?? null };
        }
        const cases = {
          relative: await invoke("relative.jsonl"),
          outsideRoot: await invoke(outsideFile),
          wrongSuffix: await invoke(wrongSuffix),
          missing: await invoke(missing),
          realpathEscape: await invoke(symlinkEscape),
          nonRegular: await invoke(directory),
          unreadable: await invoke(unreadable),
        };
        await chmod(unreadable, 0o600);
        let spawned = false;
        try { await access(marker); spawned = true; } catch (_) { spawned = false; }
        console.log(JSON.stringify({ cases, spawned }, null, 2));
        """,
    )

    assert payload["cases"] == {
        "relative": {"status": "failed", "task_id": None, "errorCode": "LARVA_BAD_INPUT"},
        "outsideRoot": {"status": "failed", "task_id": None, "errorCode": "LARVA_BAD_INPUT"},
        "wrongSuffix": {"status": "failed", "task_id": None, "errorCode": "LARVA_SESSION_INVALID"},
        "missing": {"status": "failed", "task_id": None, "errorCode": "LARVA_SESSION_NOT_FOUND"},
        "realpathEscape": {"status": "failed", "task_id": None, "errorCode": "LARVA_BAD_INPUT"},
        "nonRegular": {"status": "failed", "task_id": None, "errorCode": "LARVA_SESSION_INVALID"},
        "unreadable": {"status": "failed", "task_id": None, "errorCode": "LARVA_SESSION_INVALID"},
    }
    assert payload["spawned"] is False


def test_larva_subagent_child_rpc_terminal_paths_reap_adapter_owned_processes(tmp_path: Path) -> None:
    """Pin child RPC lifecycle cleanup across terminal and failure paths."""

    payload = _run_node(
        tmp_path,
        _node_prelude(tmp_path)
        + """
        const childBin = join(tmpRoot, "lifecycle-child.mjs");
        await writeFile(childBin, `#!/usr/bin/env node
          import { createInterface } from "node:readline";
          import { mkdir, writeFile } from "node:fs/promises";
          import { join } from "node:path";
          const scenario = process.env.LARVA_FAKE_CHILD_SCENARIO || "success";
          const pidFile = process.env.LARVA_FAKE_CHILD_PID_FILE;
          if (pidFile) await writeFile(pidFile, String(process.pid));
          const root = process.argv[process.argv.length - 1];
          await mkdir(root, { recursive: true });
          const sessionFile = join(root, scenario + ".jsonl");
          const outsideFile = join(process.env.LARVA_FAKE_OUTSIDE_ROOT || root, "outside.jsonl");
          const keepAlive = () => setInterval(() => undefined, 1000);
          function send(value) { process.stdout.write(JSON.stringify(value) + "\\\\n"); }
          if (scenario === "startup-failure") {
            process.stderr.write("larva pi: LARVA_MODEL_UNAVAILABLE: unavailable\\\\n");
            setTimeout(() => process.exit(2), 5);
          } else if (scenario === "malformed-rpc") {
            process.stdout.write("{not json\\\\n");
            keepAlive();
          } else {
            const rl = createInterface({ input: process.stdin });
            rl.on("line", async (line) => {
              const msg = JSON.parse(line);
              if (scenario === "stdout-eof-after-prompt" && msg.type === "prompt") {
                send({ id: msg.id, success: true });
                process.stdout.end();
                keepAlive();
                return;
              }
              if (scenario === "timeout" && msg.type === "prompt") {
                keepAlive();
                return;
              }
              if (msg.type === "get_state") {
                if (scenario === "new-session-protocol-failure") send({ id: msg.id, success: true, data: { sessionFile: outsideFile } });
                else { await writeFile(sessionFile, "{}\\\\n"); send({ id: msg.id, success: true, data: { sessionFile } }); }
              } else if (msg.type === "switch_session") {
                if (scenario === "resume-failure") { send({ id: msg.id, success: false }); keepAlive(); }
                else send({ id: msg.id, success: true, data: { cancelled: false } });
              } else if (msg.type === "prompt") {
                send({ id: msg.id, success: true });
                setTimeout(() => send({ type: "agent_end" }), 5);
              } else if (msg.type === "get_last_assistant_text") {
                if (scenario === "final-text-failure") send({ id: msg.id, success: true, data: { text: null } });
                else send({ id: msg.id, success: true, data: { text: "final child output" } });
                setTimeout(() => process.exit(0), 1);
              } else if (msg.type === "abort") {
                send({ id: msg.id, success: true });
                setTimeout(() => process.exit(0), 1);
              }
            });
          }
        `, { mode: 0o755 });
        async function processExists(pidFile) {
          try {
            const pid = Number.parseInt(await (await import("node:fs/promises")).readFile(pidFile, "utf8"), 10);
            process.kill(pid, 0);
            return true;
          } catch (_) {
            return false;
          }
        }
        async function runCase(name, { resume = false, abort = false } = {}) {
          const caseRoot = join(tmpRoot, "case-" + name);
          await mkdir(caseRoot, { recursive: true });
          const pidFile = join(caseRoot, "pid.txt");
          const outsideRoot = join(caseRoot, "outside");
          await mkdir(outsideRoot, { recursive: true });
          const env = baseEnv({
            LARVA_PI_REAL_BIN: process.execPath,
            LARVA_PI_EXTENSION_FLAG: childBin,
            LARVA_PI_EXTENSION_ENTRY: "ignored-extension-entry.ts",
            LARVA_PI_CHILD_SESSION_DIR: caseRoot,
            LARVA_FAKE_CHILD_SCENARIO: name,
            LARVA_FAKE_CHILD_PID_FILE: pidFile,
            LARVA_FAKE_OUTSIDE_ROOT: outsideRoot,
          });
          const { tools, ctx } = await registeredTools(env);
          await mod.commitPersona("ok", { env, modelRegistry }, piBase);
          const subagent = tools.find((tool) => tool.name === "larva_subagent");
          const params = { persona_id: "ok", task: "exercise lifecycle" };
          if (resume) {
            params.task_id = join(caseRoot, "resume.jsonl");
            await writeFile(params.task_id, "{}\\n");
          }
          if (!abort) {
            const result = await subagent.execute("case-" + name, params, undefined, () => undefined, ctx);
            await new Promise((resolve) => setTimeout(resolve, 50));
            return { status: result.status, errorCode: result.error?.code ?? null, orphan: await processExists(pidFile) };
          }
          const controller = new AbortController();
          const promise = subagent.execute("case-abort", params, controller.signal, () => undefined, ctx);
          setTimeout(() => controller.abort(), 20);
          const result = await promise;
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { status: result.status, errorCode: result.error?.code ?? null, orphan: await processExists(pidFile) };
        }
        const cases = {
          success: await runCase("success"),
          abort: await runCase("timeout", { abort: true }),
          startupFailure: await runCase("startup-failure"),
          timeout: await runCase("timeout"),
          stdoutEof: await runCase("stdout-eof-after-prompt"),
          malformedRpc: await runCase("malformed-rpc"),
          finalTextFailure: await runCase("final-text-failure"),
          resumeFailure: await runCase("resume-failure", { resume: true }),
          newSessionProtocolFailure: await runCase("new-session-protocol-failure"),
        };
        console.log(JSON.stringify({ cases }, null, 2));
        """,
        timeout=25.0,
    )

    assert payload["cases"]["success"] == {"status": "success", "errorCode": None, "orphan": False}
    assert payload["cases"]["abort"] == {"status": "cancelled", "errorCode": "LARVA_CHILD_CANCELLED", "orphan": False}
    assert payload["cases"]["startupFailure"] == {"status": "failed", "errorCode": "LARVA_MODEL_UNAVAILABLE", "orphan": False}
    assert payload["cases"]["timeout"] == {"status": "failed", "errorCode": "LARVA_CHILD_PROTOCOL_FAILED", "orphan": False}
    assert payload["cases"]["stdoutEof"] == {"status": "failed", "errorCode": "LARVA_CHILD_PROTOCOL_FAILED", "orphan": False}
    assert payload["cases"]["malformedRpc"] == {"status": "failed", "errorCode": "LARVA_CHILD_PROTOCOL_FAILED", "orphan": False}
    assert payload["cases"]["finalTextFailure"] == {"status": "failed", "errorCode": "LARVA_CHILD_PROTOCOL_FAILED", "orphan": False}
    assert payload["cases"]["resumeFailure"] == {"status": "failed", "errorCode": "LARVA_CHILD_PROTOCOL_FAILED", "orphan": False}
    assert payload["cases"]["newSessionProtocolFailure"] == {"status": "failed", "errorCode": "LARVA_CHILD_PROTOCOL_FAILED", "orphan": False}


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


def test_larva_subagent_presentation_log_overlay_rows_details_and_reset(tmp_path: Path) -> None:
    """Pin view-only presentation overlay rows, expanded details, and reset cleanup."""

    payload = _run_node(
        tmp_path,
        _node_prelude(tmp_path)
        + """
        mod.resetSubagentPresentationStateForTests();
        mod.recordSubagentPresentationEntryForTests("/tmp/active.jsonl", "alpha", "running", { phase: "waiting_for_child", mode: "new", task_preview: "active task" });
        mod.recordSubagentPresentationEntryForTests("/tmp/final.jsonl", "beta", "success", { result_text: "final child output", phase: "success" });
        mod.recordSubagentPresentationEntryForTests("/tmp/error.jsonl", "gamma", "failed", { error: { code: "LARVA_CHILD_PROTOCOL_FAILED", message: "boom" }, phase: "failed" });
        mod.recordSubagentPresentationEntryForTests("/tmp/cancelled.jsonl", "delta", "cancelled", { error: { code: "LARVA_CHILD_CANCELLED", message: "stopped" }, phase: "cancelled" });
        const compact = mod.larva_subagent_log({ limit: 4 });
        const expanded = mod.larva_subagent_log({ expanded: true, limit: 4 });
        mod.recordSubagentPresentationEntryForTests(null, "epsilon", "running", { phase: "starting", mode: "new", task_preview: "pending fresh run" });
        const pendingNewest = mod.larva_subagent_log({ expanded: true });
        const longOverlayText = Array.from({ length: 45 }, (_, index) => `scroll proof line ${String(index).padStart(2, "0")}`).join("\\n");
        mod.recordSubagentPresentationEntryForTests("/tmp/long.jsonl", "zeta", "success", { result_text: longOverlayText, phase: "success" });
        const beforeSessions = JSON.stringify(mod.larva_subagent_sessions({ limit: 10 }).details.sessions);
        const commandNotifications = [];
        const commandCustomCalls = [];
        const commandResults = [];
        const commandUi = {
          notify: (...args) => commandNotifications.push(args),
          setStatus: () => undefined,
          custom: async (factory, options) => {
            const doneValues = [];
            let focused = false;
            const terminalWrites = [];
            options?.onHandle?.({ focus: () => { focused = true; } });
            const keybindings = {
              matches: (data, keybindingId) => ({
                "LIVE_DOWN": ["tui.select.down", "tui.editor.cursorDown"],
                "LIVE_UP": ["tui.select.up", "tui.editor.cursorUp"],
                "LIVE_PAGEDOWN": ["tui.select.pageDown", "tui.editor.pageDown"],
                "LIVE_HOME": ["tui.editor.cursorLineStart"],
                "LIVE_ESC": ["tui.select.cancel"],
              }[data] ?? []).includes(keybindingId),
            };
            const component = factory({ requestRender: () => undefined, terminal: { write: (data) => terminalWrites.push(data) } }, { fg: (_token, text) => text, bold: (text) => text }, keybindings, (value) => doneValues.push(value));
            const rendered = component.render(80);
            const longInitial = component.render(80);
            component.handleInput?.("\\x1b[<65;10;10M");
            const afterWheelDown = component.render(80);
            component.handleInput?.("\\x1b[<64;10;10M");
            const afterWheelUp = component.render(80);
            component.handleInput?.("\\x1b[B");
            const afterDown = component.render(80);
            component.handleInput?.("\\x1b[6~");
            const afterPageDown = component.render(80);
            component.handleInput?.("\\x1b[H");
            const afterHome = component.render(80);
            component.handleInput?.("LIVE_DOWN");
            const afterLiveDown = component.render(80);
            component.handleInput?.("LIVE_UP");
            const afterLiveUp = component.render(80);
            component.handleInput?.("LIVE_PAGEDOWN");
            const afterLivePageDown = component.render(80);
            component.handleInput?.("LIVE_HOME");
            const afterLiveHome = component.render(80);
            component.handleInput?.("\\r");
            const doneAfterEnter = doneValues.length;
            component.handleInput?.("LIVE_ESC");
            const doneAfterLiveEsc = doneValues.length;
            component.handleInput?.("\\x1b[27;1;27~");
            const doneAfterEsc = doneValues.length;
            component.handleInput?.("q");
            const doneAfterQ = doneValues.length;
            component.dispose?.();
            commandCustomCalls.push({ options, focused, terminalWrites, rendered, longInitial, afterWheelDown, afterWheelUp, afterDown, afterPageDown, afterHome, afterLiveDown, afterLiveUp, afterLivePageDown, afterLiveHome, doneAfterEnter, doneAfterLiveEsc, doneAfterEsc, doneAfterQ });
            return null;
          },
        };
        await mod.initializeExtension(
          { env: baseEnv(), modelRegistry, ui: { setStatus: () => undefined } },
          { ...piBase, registerTool: () => undefined, registerCommand: (name, command) => { if (name === "larva-subagent-log") commandResults.push(command.handler(undefined, { env: baseEnv(), modelRegistry, ui: commandUi })); } },
        );
        const commandResult = await commandResults[0];
        const afterSessions = JSON.stringify(mod.larva_subagent_sessions({ limit: 10 }).details.sessions);
        mod.resetSubagentPresentationStateForTests();
        console.log(JSON.stringify({
          compactText: compact.content[0].text,
          expandedText: expanded.content[0].text,
          viewOnlyShape: { ok: compact.ok, view_only: compact.view_only, isError: compact.isError, noTaskId: !("task_id" in compact), noResultText: !("result_text" in compact) },
          detailFieldsPresent: ["task_id: /tmp/final.jsonl", "persona_id: gamma", "status: failed", "result: final child output", "error: LARVA_CHILD_PROTOCOL_FAILED: boom", "progress: waiting_for_child"].every((needle) => expanded.content[0].text.includes(needle)),
          rowStatesPresent: ["active alpha", "final beta", "error gamma", "cancelled delta"].every((needle) => compact.content[0].text.includes(needle)),
          pendingNewestVisible: pendingNewest.ok === true && pendingNewest.details.selected_task_id === null && pendingNewest.content[0].text.includes("task_id: pending") && pendingNewest.content[0].text.includes("pending fresh run"),
          viewOnlyNoMutation: beforeSessions === afterSessions && commandResult.view_only === true,
          overlayRenderedLines: commandCustomCalls[0].rendered,
          overlayOpened: commandCustomCalls.length === 1 && commandCustomCalls[0].options?.overlay === true && commandCustomCalls[0].focused === true && commandCustomCalls[0].terminalWrites[0] === "\x1b[?1000h\x1b[?1006h" && commandCustomCalls[0].terminalWrites.at(-1) === "\x1b[?1006l\x1b[?1000l" && commandCustomCalls[0].rendered.some((line) => line.includes("Larva subagent presentation log")),
          overlayBoxed: commandCustomCalls[0].rendered[0].startsWith("╭─ Larva subagent presentation log") && commandCustomCalls[0].rendered.at(-1).startsWith("╰") && commandCustomCalls[0].rendered.slice(1, -1).every((line) => line.startsWith("│ ") && line.endsWith(" │") && Array.from(line).length <= 80),
          overlayCloseKeys: commandCustomCalls[0].doneAfterEnter === 0 && commandCustomCalls[0].doneAfterLiveEsc === 1 && commandCustomCalls[0].doneAfterEsc === 2 && commandCustomCalls[0].doneAfterQ === 3 && commandCustomCalls[0].rendered.some((line) => line.includes("Esc/q close")) && !commandCustomCalls[0].rendered.some((line) => line.includes("Enter")),
          overlayScrollable: commandCustomCalls[0].longInitial.length <= 22 && commandCustomCalls[0].longInitial.some((line) => line.includes("Wheel/↑↓ PgUp/PgDn Home/End")) && JSON.stringify(commandCustomCalls[0].longInitial) !== JSON.stringify(commandCustomCalls[0].afterWheelDown) && JSON.stringify(commandCustomCalls[0].afterWheelUp) === JSON.stringify(commandCustomCalls[0].longInitial) && JSON.stringify(commandCustomCalls[0].longInitial) !== JSON.stringify(commandCustomCalls[0].afterDown) && JSON.stringify(commandCustomCalls[0].afterDown) !== JSON.stringify(commandCustomCalls[0].afterPageDown) && JSON.stringify(commandCustomCalls[0].afterHome) === JSON.stringify(commandCustomCalls[0].longInitial) && JSON.stringify(commandCustomCalls[0].longInitial) !== JSON.stringify(commandCustomCalls[0].afterLiveDown) && JSON.stringify(commandCustomCalls[0].afterLiveUp) === JSON.stringify(commandCustomCalls[0].longInitial) && JSON.stringify(commandCustomCalls[0].afterLivePageDown) !== JSON.stringify(commandCustomCalls[0].longInitial) && JSON.stringify(commandCustomCalls[0].afterLiveHome) === JSON.stringify(commandCustomCalls[0].longInitial),
          noNotifyWhenOverlayAvailable: commandNotifications.length === 0,
          resetEmpty: mod.larva_subagent_sessions({ limit: 10 }).details.sessions.length === 0 && mod.larva_subagent_log({ expanded: true }).details.error?.code === "LARVA_SUBAGENT_LOG_NOT_OBSERVED",
        }, null, 2));
        """,
    )

    assert "source: in-memory presentation log" in payload["compactText"]
    assert payload["viewOnlyShape"] == {"ok": True, "view_only": True, "isError": False, "noTaskId": True, "noResultText": True}
    assert payload["rowStatesPresent"] is True
    assert payload["detailFieldsPresent"] is True
    assert payload["pendingNewestVisible"] is True
    assert payload["viewOnlyNoMutation"] is True
    assert payload["overlayOpened"] is True
    assert payload["overlayBoxed"] is True
    assert all(wcswidth(line) <= 80 for line in payload["overlayRenderedLines"])
    assert payload["overlayCloseKeys"] is True
    assert payload["overlayScrollable"] is True
    assert payload["noNotifyWhenOverlayAvailable"] is True
    assert payload["resetEmpty"] is True


def test_pi_tui_direct_imports_bordered_scroll_width_and_mouse_click_noop(tmp_path: Path) -> None:
    """Pin formal Pi TUI imports, width-safe reusable scroll component, and no click support."""

    source = EXTENSION.read_text(encoding="utf-8")
    assert 'from "@earendil-works/pi-tui"' in source
    for required in ["visibleWidth", "truncateToWidth", "wrapTextWithAnsi", "matchesKey", "Key"]:
        assert required in source
    for removed in ["createRequire", "loadPiTuiTextHelpers", "PI_TUI_TEXT_HELPERS", "terminalCharWidth"]:
        assert removed not in source
    assert "class BorderedScrollableText" in source
    assert "Mouse click/press/release SGR events are intentionally unsupported no-ops" in source

    payload = _run_node(
        tmp_path,
        _node_prelude(tmp_path)
        + """
        const piTui = await import(piTuiRequire.resolve("@earendil-works/pi-tui"));
        const mixedLines = [
          "CJK: 这是一个宽字符测试".repeat(3),
          "Emoji: 🧪🚀✨ with skin-tone-ish output".repeat(2),
          "ANSI-stripped: \\u001b[31mred text that should not leak ANSI width\\u001b[0m".repeat(2),
          "Markdown: **bold** `code` [link](https://example.invalid/very/long/path)".repeat(2),
          `task_id: ${join(childRoot, "nested", "segment", "with", "very", "long", "resume-session-name-that-must-be-width-safe.jsonl")}`,
          ...Array.from({ length: 60 }, (_, index) => `scroll line ${index} 这是 🧪 /very/long/path/${index}`),
        ].join("\\n");
        const terminalWrites = [];
        let requestRenderCount = 0;
        const doneValues = [];
        const component = new mod.BorderedScrollableText({
          text: mixedLines,
          title: "Width Proof",
          tui: { requestRender: () => { requestRenderCount += 1; }, terminal: { write: (data) => terminalWrites.push(data) } },
          keybindings: { matches: (data, keybindingId) => data === "LIVE_END" && keybindingId === "tui.editor.cursorLineEnd" },
          done: (value) => doneValues.push(value),
        });
        const widths = [3, 20, 40, 80];
        const renderedByWidth = widths.map((width) => ({ width, lines: component.render(width) }));
        const beforeClick = component.render(40);
        component.handleInput("\\x1b[<0;10;10M");
        const afterClick = component.render(40);
        component.handleInput("\\x1b[<65;10;10M");
        const afterWheel = component.render(40);
        component.handleInput("LIVE_END");
        const afterInjectedEnd = component.render(40);
        component.handleInput("\\r");
        const doneAfterEnter = doneValues.length;
        component.handleInput("q");
        const doneAfterQ = doneValues.length;
        component.dispose();
        console.log(JSON.stringify({
          directImportProbe: {
            visibleWidth: typeof piTui.visibleWidth,
            truncateToWidth: typeof piTui.truncateToWidth,
            wrapTextWithAnsi: typeof piTui.wrapTextWithAnsi,
            matchesKey: typeof piTui.matchesKey,
            keyUp: piTui.Key?.up,
          },
          widthSafe: renderedByWidth.every(({ width, lines }) => lines.every((line) => piTui.visibleWidth(line) <= width)),
          renderedByWidth,
          clickNoop: JSON.stringify(beforeClick) === JSON.stringify(afterClick),
          wheelScrolls: JSON.stringify(beforeClick) !== JSON.stringify(afterWheel),
          injectedKeyScrolls: JSON.stringify(afterWheel) !== JSON.stringify(afterInjectedEnd),
          enterNoClose: doneAfterEnter === 0,
          qCloses: doneAfterQ === 1,
          mouseLifecycle: terminalWrites[0] === "\x1b[?1000h\x1b[?1006h" && terminalWrites.at(-1) === "\x1b[?1006l\x1b[?1000l",
          requestRenderCount,
        }, null, 2));
        """,
    )

    assert payload["directImportProbe"] == {
        "visibleWidth": "function",
        "truncateToWidth": "function",
        "wrapTextWithAnsi": "function",
        "matchesKey": "function",
        "keyUp": "up",
    }
    assert payload["widthSafe"] is True
    assert payload["clickNoop"] is True
    assert payload["wheelScrolls"] is True
    assert payload["injectedKeyScrolls"] is True
    assert payload["enterNoClose"] is True
    assert payload["qCloses"] is True
    assert payload["mouseLifecycle"] is True
    assert payload["requestRenderCount"] >= 2


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
        const beforeRenderResult = JSON.stringify(finalResult);
        const collapsed = subagent?.renderResult?.(finalResult, { expanded: false, input: call });
        const expanded = subagent?.renderResult?.(finalResult, { expanded: true, input: call });
        const afterRenderResult = JSON.stringify(finalResult);
        const collapsedText = String(collapsed?.text ?? collapsed ?? "");
        const expandedText = String(expanded?.text ?? expanded ?? "");
        console.log(JSON.stringify({
          componentShapes: {
            collapsedRenderable: typeof collapsed?.render === "function" && Array.isArray(collapsed.render(80)),
            expandedRenderable: typeof expanded?.render === "function" && Array.isArray(expanded.render(80)),
            expandedMarkdownCapable: expanded?.format === "markdown" && typeof expanded?.markdown === "string" && expanded.markdown.includes("**output:**"),
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
          immutableToolResult: beforeRenderResult === afterRenderResult,
          plainTextFallbackPreserved: expandedText.includes("output: final output body"),
        }, null, 2));
        """,
    )

    assert payload["componentShapes"] == {"collapsedRenderable": True, "expandedRenderable": True, "expandedMarkdownCapable": True}
    assert payload["collapsedHasPersonaAndTerminalState"] is True
    assert payload["expandedHasIndependentFields"] is True
    assert payload["parentFooterPreserved"] is True
    assert payload["noWidgetDashboard"] is True
    assert payload["immutableToolResult"] is True
    assert payload["plainTextFallbackPreserved"] is True


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
    autocomplete_gate = payload["runtime"]["hardGates"]["uiAutocompleteProvider"]
    assert autocomplete_gate["supported"] is False
    assert autocomplete_gate["status"] in {"unsupported", "unknown"}
    assert autocomplete_gate["provenance"] != "pi.interactiveTuiRuntime"
    assert autocomplete_gate["evidence"]["hook"]["source"] == "runtimeHarness.mock"
    assert "live Pi interactive TUI runtime hook proof is missing" in autocomplete_gate["limitation"]
    assert "mock/local harness hook evidence is never sufficient" in autocomplete_gate["supportRule"]


def test_subagent_log_overlay_command_green_without_live_credentials() -> None:
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
        "LARVA_PI_LAUNCHED": "1",
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
        "LARVA_PI_LAUNCHED",
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
