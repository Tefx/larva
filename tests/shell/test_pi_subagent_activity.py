"""Regression tests for Pi ``larva_subagent_activity`` runtime contract.

These tests verify the activity reader, cursor continuation, exact segment
reconstruction, response ceiling, and lifecycle neutrality.
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


def _run_node(tmp_path: Path, script: str, *, timeout: float = 15.0) -> dict[str, Any]:
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
        cwd=str(ROOT),
    )
    assert completed.returncode == 0, f"STDOUT: {completed.stdout}\nSTDERR: {completed.stderr}"
    return json.loads(completed.stdout)


def test_activity_tool_contract(tmp_path: Path) -> None:
    """Verify larva_subagent_activity registration, schema, and basic execution."""
    result = _run_node(
        tmp_path,
        f"""
        import {{ writeFile }} from "node:fs/promises";
        import {{ join }} from "node:path";
        const mod = await import({json.dumps(EXTENSION.as_uri())});
        const tmp = {json.dumps(str(tmp_path))};

        const sessionFile = join(tmp, "contract-session.jsonl");
        const lines = [
          JSON.stringify({{ type: "session", version: 3, id: "sess-contract", timestamp: "2026-09-21T18:00:00Z", cwd: tmp }}),
          JSON.stringify({{ type: "message", id: "m1", parentId: null, timestamp: "2026-09-21T18:01:00Z", message: {{ role: "assistant", content: [{{ type: "toolCall", id: "call-1", name: "bash", arguments: {{ cmd: "pwd" }} }}] }} }}),
          JSON.stringify({{ type: "message", id: "m2", parentId: "m1", timestamp: "2026-09-21T18:01:05Z", message: {{ role: "toolResult", toolCallId: "call-1", toolName: "bash", content: "/test/dir", isError: false }} }}),
        ];
        await writeFile(sessionFile, lines.join("\\n") + "\\n", "utf8");

        const res = await mod.larva_subagent_activity({{ session_path: sessionFile }});
        process.stdout.write(JSON.stringify({{
          isError: res.isError,
          status: res.details.status,
          sessionId: res.details.session_id,
          itemCount: res.details.items?.length,
          callId: res.details.items?.[0]?.call_id,
          resultStatus: res.details.items?.[0]?.result_status,
          isCallError: res.details.items?.[0]?.is_error,
          hasCursor: typeof res.details.cursor === "string",
        }}));
        """,
    )
    assert result["isError"] is False
    assert result["status"] == "success"
    assert result["sessionId"] == "sess-contract"
    assert result["itemCount"] == 1
    assert result["callId"] == "call-1"
    assert result["resultStatus"] == "observed"
    assert result["isCallError"] is False
    assert result["hasCursor"] is True


def test_activity_segment_reconstruction_and_bounds(tmp_path: Path) -> None:
    """Verify exact toolCallId lookup, segment reconstruction, and response ceiling."""
    result = _run_node(
        tmp_path,
        f"""
        import {{ writeFile }} from "node:fs/promises";
        import {{ join }} from "node:path";
        const mod = await import({json.dumps(EXTENSION.as_uri())});
        const tmp = {json.dumps(str(tmp_path))};

        const sessionFile = join(tmp, "segment-session.jsonl");
        const payload = "X".repeat(8000);
        const lines = [
          JSON.stringify({{ type: "session", version: 3, id: "sess-seg", timestamp: "2026-09-21T18:00:00Z", cwd: tmp }}),
          JSON.stringify({{ type: "message", id: "m1", parentId: null, timestamp: "2026-09-21T18:01:00Z", message: {{ role: "assistant", content: [{{ type: "toolCall", id: "c-big", name: "reader", arguments: {{}} }}] }} }}),
          JSON.stringify({{ type: "message", id: "m2", parentId: "m1", timestamp: "2026-09-21T18:01:05Z", message: {{ role: "toolResult", toolCallId: "c-big", toolName: "reader", content: payload, isError: false }} }}),
        ];
        await writeFile(sessionFile, lines.join("\\n") + "\\n", "utf8");

        const chunk1 = await mod.larva_subagent_activity({{ session_path: sessionFile, tool_call_id: "c-big", segment_part: "result", offset: 0, length: 3000 }});
        const chunk2 = await mod.larva_subagent_activity({{ session_path: sessionFile, tool_call_id: "c-big", segment_part: "result", offset: 3000, length: 3000 }});
        const chunk3 = await mod.larva_subagent_activity({{ session_path: sessionFile, tool_call_id: "c-big", segment_part: "result", offset: 6000, length: 3000 }});

        const byte1 = Buffer.byteLength(JSON.stringify(chunk1), "utf8");
        const byte2 = Buffer.byteLength(JSON.stringify(chunk2), "utf8");
        const byte3 = Buffer.byteLength(JSON.stringify(chunk3), "utf8");

        const seg1 = chunk1.details.call.segment;
        const seg2 = chunk2.details.call.segment;
        const seg3 = chunk3.details.call.segment;

        const reconstructed = seg1.text + seg2.text + seg3.text;

        process.stdout.write(JSON.stringify({{
          byte1,
          byte2,
          byte3,
          reconstructedLength: reconstructed.length,
          matches: reconstructed === payload,
          hasMore1: seg1.has_more,
          hasMore2: seg2.has_more,
          hasMore3: seg3.has_more,
        }}));
        """,
    )
    assert result["byte1"] <= 8192
    assert result["byte2"] <= 8192
    assert result["byte3"] <= 8192
    assert result["matches"] is True
    assert result["hasMore1"] is True
    assert result["hasMore2"] is True
    assert result["hasMore3"] is False


def test_activity_lifecycle_neutrality(tmp_path: Path) -> None:
    """Verify pure read-only behavior leaves target file stat unchanged."""
    result = _run_node(
        tmp_path,
        f"""
        import {{ writeFile, stat }} from "node:fs/promises";
        import {{ join }} from "node:path";
        const mod = await import({json.dumps(EXTENSION.as_uri())});
        const tmp = {json.dumps(str(tmp_path))};

        const sessionFile = join(tmp, "neutral-session.jsonl");
        const lines = [
          JSON.stringify({{ type: "session", version: 3, id: "sess-neutral", timestamp: "2026-09-21T18:00:00Z", cwd: tmp }}),
          JSON.stringify({{ type: "message", id: "m1", parentId: null, timestamp: "2026-09-21T18:01:00Z", message: {{ role: "assistant", content: [{{ type: "toolCall", id: "c1", name: "tool", arguments: {{}} }}] }} }}),
        ];
        await writeFile(sessionFile, lines.join("\\n") + "\\n", "utf8");

        const statBefore = await stat(sessionFile);
        const res = await mod.larva_subagent_activity({{ session_path: sessionFile }});
        const statAfter = await stat(sessionFile);

        process.stdout.write(JSON.stringify({{
          status: res.details.status,
          mtimeUnchanged: statBefore.mtimeMs === statAfter.mtimeMs,
          sizeUnchanged: statBefore.size === statAfter.size,
        }}));
        """,
    )
    assert result["status"] == "success"
    assert result["mtimeUnchanged"] is True
    assert result["sizeUnchanged"] is True
