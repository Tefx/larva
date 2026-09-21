// purpose: native Pi integration proof for larva_subagent_activity (FR9)
// usage: node scripts/pi-subagent-activity-native.mjs
// effects: disposable native Pi RPC fixture, loopback HTTP server; no user config
// requires: Pi 0.85.1 and Node 26.7+
import assert from "node:assert/strict";
import { writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ROOT, PACKAGE, createNativeFixture, NativeRpc } from "./pi-native-support.mjs";

const toolResults = (frames, name) =>
  frames
    .filter((f) => f.type === "tool_execution_end" && f.toolName === name)
    .map((f) => f.result);

const f = await createNativeFixture();
try {
  // Create a synthetic historical session file in the fixture's project dir
  const sessionFile = join(f.cwd, "native-history-session.jsonl");
  const header = JSON.stringify({
    type: "session",
    version: 3,
    id: "native-session-uuid-001",
    timestamp: "2026-09-21T18:00:00.000Z",
    cwd: f.cwd,
  }) + "\n";
  const call1 = JSON.stringify({
    type: "message",
    id: "msg-native-1",
    parentId: null,
    timestamp: "2026-09-21T18:01:00.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", id: "native-call-alpha", name: "bash", arguments: { command: "echo hello-native" } },
        { type: "toolCall", id: "native-call-beta", name: "read", arguments: { path: "README.md" } },
      ],
      provider: "native-loopback",
      model: "origin",
    },
  }) + "\n";
  const res1 = JSON.stringify({
    type: "message",
    id: "res-native-1",
    parentId: "msg-native-1",
    timestamp: "2026-09-21T18:01:05.000Z",
    message: {
      role: "toolResult",
      toolCallId: "native-call-alpha",
      toolName: "bash",
      content: "hello-native\n",
      isError: false,
    },
  }) + "\n";
  const res2 = JSON.stringify({
    type: "message",
    id: "res-native-2",
    parentId: "msg-native-1",
    timestamp: "2026-09-21T18:01:06.000Z",
    message: {
      role: "toolResult",
      toolCallId: "native-call-beta",
      toolName: "read",
      content: "Error: file not found",
      isError: true,
    },
  }) + "\n";

  await writeFile(sessionFile, header + call1 + res1 + res2, "utf8");
  const sessionStatBefore = await stat(sessionFile);

  const p = new NativeRpc(f, ["--larva-persona", "ok"]);
  await p.command("get_state");

  // Verify tool registration and schema visibility through native Pi snapshot
  const snapshot = await p.snapshot();
  assert.ok(snapshot.value.activeTools.includes("larva_subagent_activity"), "larva_subagent_activity must be registered and active");

  // Step 1: Execute recent activity tool call through loopback provider
  let turn = 0;
  f.respond = () => {
    turn += 1;
    if (turn === 1) {
      return {
        tools: [
          {
            name: "larva_subagent_activity",
            args: { session_path: sessionFile, limit: 5 },
          },
        ],
      };
    }
    return { text: "Inspected native session activity successfully." };
  };

  const frames1 = await p.prompt("Please check session activity for native session.");
  const results1 = toolResults(frames1, "larva_subagent_activity");
  assert.equal(results1.length, 1, "Must execute larva_subagent_activity via native provider");

  const exec1 = results1[0];
  assert.equal(exec1.isError, false, "Execution must succeed");
  assert.ok(Array.isArray(exec1.content), "content must be array");
  assert.ok(exec1.content[0].text.includes("native-session-uuid-001"), "Model-visible text must contain session info");
  assert.ok(exec1.content[0].text.includes("native-call-alpha"), "Model-visible text must contain call ID");
  assert.equal(exec1.details.status, "success");
  assert.equal(exec1.details.session_id, "native-session-uuid-001");
  assert.equal(exec1.details.items.length, 2);
  assert.equal(exec1.details.items[0].call_id, "native-call-alpha");
  assert.equal(exec1.details.items[0].is_error, false);
  assert.equal(exec1.details.items[1].call_id, "native-call-beta");
  assert.equal(exec1.details.items[1].is_error, true);
  const cursor = exec1.details.cursor;
  assert.ok(cursor, "Must produce cursor");

  // Step 2: Execute exact tool_call_id lookup and segment reconstruction through loopback provider
  let turn2 = 0;
  f.respond = () => {
    turn2 += 1;
    if (turn2 === 1) {
      return {
        tools: [
          {
            name: "larva_subagent_activity",
            args: {
              session_path: sessionFile,
              tool_call_id: "native-call-alpha",
              segment_part: "result",
              offset: 0,
              length: 100,
            },
          },
        ],
      };
    }
    return { text: "Inspected exact tool call." };
  };

  const frames2 = await p.prompt("Look up exact call native-call-alpha.");
  const results2 = toolResults(frames2, "larva_subagent_activity");
  assert.equal(results2.length, 1);
  const exec2 = results2[0];
  assert.equal(exec2.details.status, "success");
  assert.equal(exec2.details.call.call_id, "native-call-alpha");
  assert.equal(exec2.details.call.segment.part, "result");
  assert.equal(exec2.details.call.segment.text, "hello-native\n");
  assert.ok(exec2.content[0].text.includes("hello-native"), "Model-visible content must include segment");

  // Step 3: Verify lifecycle neutrality: session file was untouched, no extra processes
  const sessionStatAfter = await stat(sessionFile);
  assert.equal(sessionStatBefore.mtimeMs, sessionStatAfter.mtimeMs, "Session file mtime must be unchanged");
  assert.equal(sessionStatBefore.size, sessionStatAfter.size, "Session file size must be unchanged");

  const inspect = await f.inspect();
  assert.equal(inspect.liveChildren.length, 0, "No child processes spawned by activity reader");

  await p.stop();
  console.log("FR9 (native Pi discovery, schema visibility, execution, model-visible output): PASS");
} finally {
  await f.close();
}
