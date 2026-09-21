// purpose: native Pi integration proof for larva_subagent_activity across all 9 FRs
// usage: node scripts/pi-subagent-activity-native.mjs
// effects: disposable native Pi RPC fixture, loopback HTTP server; no user config
// requires: Pi 0.85.1 and Node 26.7+
import assert from "node:assert/strict";
import { writeFile, appendFile, stat } from "node:fs/promises";
import { openSync, writeSync, closeSync } from "node:fs";
import { join } from "node:path";
import { ROOT, PACKAGE, createNativeFixture, NativeRpc } from "./pi-native-support.mjs";

const toolResults = (frames, name) =>
  frames
    .filter((f) => f.type === "tool_execution_end" && f.toolName === name)
    .map((f) => f.result);

const f = await createNativeFixture();
try {
  // --- Case 1: Package Discovery & Schema Visibility in Provider Requests (FR9) ---
  const p = new NativeRpc(f, ["--larva-persona", "ok"]);
  await p.command("get_state");

  const snapshot = await p.snapshot();
  assert.ok(
    snapshot.value.activeTools.includes("larva_subagent_activity"),
    "larva_subagent_activity must be in activeTools",
  );

  // Trigger a prompt to inspect provider tools payload
  let step1Called = false;
  f.respond = (payload) => {
    // Check that loopback provider received larva_subagent_activity with full schema
    const tools = payload.tools ?? [];
    const toolDef = tools.find((t) => t.function?.name === "larva_subagent_activity");
    assert.ok(toolDef, "Provider request payload must contain larva_subagent_activity tool schema");
    assert.ok(toolDef.function.description.includes("Read-only compact inspection"), "Tool description must match");
    const params = toolDef.function.parameters;
    assert.equal(params.type, "object");
    assert.ok(params.properties.session_path, "Schema must document session_path");
    assert.ok(params.properties.cursor, "Schema must document cursor");
    assert.ok(params.properties.limit, "Schema must document limit");
    assert.ok(params.properties.tool_call_id, "Schema must document tool_call_id");

    if (!step1Called) {
      step1Called = true;
      return { text: "Schema visibility confirmed." };
    }
    return { text: "Done." };
  };

  await p.prompt("Schema check prompt");
  console.log("FR9 (native Pi package discovery and schema visibility): PASS");

  // --- Case 2: Parallel calls, errors, and missing results (FR1) ---
  const fr1File = join(f.cwd, "native-fr1.jsonl");
  let fr1Content = JSON.stringify({ type: "session", version: 3, id: "sess-fr1", timestamp: "2026-09-21T18:00:00Z", cwd: f.cwd }) + "\n";
  fr1Content += JSON.stringify({
    type: "message",
    id: "m1",
    timestamp: "2026-09-21T18:01:00Z",
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", id: "c-ok", name: "bash", arguments: { cmd: "ls" } },
        { type: "toolCall", id: "c-err", name: "read", arguments: { file: "missing" } },
        { type: "toolCall", id: "c-no-res", name: "write", arguments: {} },
      ],
    },
  }) + "\n";
  fr1Content += JSON.stringify({
    type: "message",
    id: "r1",
    parentId: "m1",
    timestamp: "2026-09-21T18:01:05Z",
    message: { role: "toolResult", toolCallId: "c-ok", toolName: "bash", content: "file1\nfile2", isError: false },
  }) + "\n";
  fr1Content += JSON.stringify({
    type: "message",
    id: "r2",
    parentId: "m1",
    timestamp: "2026-09-21T18:01:06Z",
    message: { role: "toolResult", toolCallId: "c-err", toolName: "read", content: "not found", isError: true },
  }) + "\n";
  await writeFile(fr1File, fr1Content, "utf8");

  let fr1Called = false;
  f.respond = () => {
    if (!fr1Called) {
      fr1Called = true;
      return { tools: [{ name: "larva_subagent_activity", args: { session_path: fr1File } }] };
    }
    return { text: "FR1 inspected." };
  };

  const framesFr1 = await p.prompt("Run FR1 inspection");
  const resFr1 = toolResults(framesFr1, "larva_subagent_activity")[0];
  assert.equal(resFr1.details.status, "success");
  assert.equal(resFr1.details.items.length, 3);
  assert.equal(resFr1.details.items[0].call_id, "c-ok");
  assert.equal(resFr1.details.items[0].is_error, false);
  assert.equal(resFr1.details.items[1].call_id, "c-err");
  assert.equal(resFr1.details.items[1].is_error, true);
  assert.equal(resFr1.details.items[2].call_id, "c-no-res");
  assert.equal(resFr1.details.items[2].result_status, "none");
  assert.equal(resFr1.details.items[2].is_error, null);
  console.log("FR1 (native parallel calls, errors, missing results): PASS");

  // --- Case 3: Append new calls and late results, lossless paging (FR2) ---
  const fr2Cursor = resFr1.details.cursor;
  assert.ok(fr2Cursor, "Must have cursor from FR1");

  // Append late result for c-no-res, and new call c-new
  let fr2Append = JSON.stringify({
    type: "message",
    id: "r3",
    parentId: "m1",
    timestamp: "2026-09-21T18:02:00Z",
    message: { role: "toolResult", toolCallId: "c-no-res", toolName: "write", content: "saved", isError: false },
  }) + "\n";
  fr2Append += JSON.stringify({
    type: "message",
    id: "m2",
    timestamp: "2026-09-21T18:02:05Z",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "c-new", name: "bash", arguments: { cmd: "date" } }],
    },
  }) + "\n";
  await appendFile(fr1File, fr2Append, "utf8");

  let fr2Called = false;
  f.respond = () => {
    if (!fr2Called) {
      fr2Called = true;
      return { tools: [{ name: "larva_subagent_activity", args: { session_path: fr1File, cursor: fr2Cursor } }] };
    }
    return { text: "FR2 inspected." };
  };

  const framesFr2 = await p.prompt("Run FR2 incremental read");
  const resFr2 = toolResults(framesFr2, "larva_subagent_activity")[0];
  assert.equal(resFr2.details.status, "success");
  assert.equal(resFr2.details.items.length, 2);
  const lateRes = resFr2.details.items.find((it) => it.call_id === "c-no-res");
  assert.ok(lateRes, "Must deliver late result for older call");
  assert.equal(lateRes.update_type, "late_result");
  assert.equal(lateRes.result_status, "observed");
  const newCall = resFr2.details.items.find((it) => it.call_id === "c-new");
  assert.ok(newCall, "Must deliver new call");
  assert.equal(newCall.update_type, "new_call");
  console.log("FR2 (native incremental append and late results): PASS");

  // --- Case 4: Exact ID outside recent window (FR3) ---
  const fr3File = join(f.cwd, "native-fr3.jsonl");
  let fr3Content = JSON.stringify({ type: "session", version: 3, id: "sess-fr3", timestamp: "2026-09-21T18:00:00Z", cwd: f.cwd }) + "\n";
  for (let i = 1; i <= 10; i += 1) {
    fr3Content += JSON.stringify({
      type: "message",
      id: `m-fr3-${i}`,
      timestamp: `2026-09-21T18:0${i}:00Z`,
      message: { role: "assistant", content: [{ type: "toolCall", id: `c-fr3-${i}`, name: "tool", arguments: { i } }] },
    }) + "\n";
    fr3Content += JSON.stringify({
      type: "message",
      id: `r-fr3-${i}`,
      parentId: `m-fr3-${i}`,
      timestamp: `2026-09-21T18:0${i}:05Z`,
      message: { role: "toolResult", toolCallId: `c-fr3-${i}`, toolName: "tool", content: `out-${i}`, isError: false },
    }) + "\n";
  }
  await writeFile(fr3File, fr3Content, "utf8");

  let fr3Called = false;
  f.respond = () => {
    if (!fr3Called) {
      fr3Called = true;
      return { tools: [{ name: "larva_subagent_activity", args: { session_path: fr3File, tool_call_id: "c-fr3-1" } }] };
    }
    return { text: "FR3 inspected." };
  };

  const framesFr3 = await p.prompt("Run FR3 exact call");
  const resFr3 = toolResults(framesFr3, "larva_subagent_activity")[0];
  assert.equal(resFr3.details.status, "success");
  assert.equal(resFr3.details.call.call_id, "c-fr3-1");
  assert.equal(resFr3.details.call.result_preview, "out-1");
  console.log("FR3 (native exact ID lookup outside recent window): PASS");

  // --- Case 5: Large args/results with measured whole-response ceiling and segment reconstruction (FR4) ---
  const fr4File = join(f.cwd, "native-fr4.jsonl");
  const big10k = "Z".repeat(10000);
  let fr4Content = JSON.stringify({ type: "session", version: 3, id: "sess-fr4", timestamp: "2026-09-21T18:00:00Z", cwd: f.cwd }) + "\n";
  fr4Content += JSON.stringify({
    type: "message",
    id: "m-fr4",
    timestamp: "2026-09-21T18:00:00Z",
    message: { role: "assistant", content: [{ type: "toolCall", id: "c-fr4-big", name: "bigtool", arguments: { data: big10k } }] },
  }) + "\n";
  fr4Content += JSON.stringify({
    type: "message",
    id: "r-fr4",
    parentId: "m-fr4",
    timestamp: "2026-09-21T18:00:05Z",
    message: { role: "toolResult", toolCallId: "c-fr4-big", toolName: "bigtool", content: big10k, isError: false },
  }) + "\n";
  await writeFile(fr4File, fr4Content, "utf8");

  let fr4Called = false;
  f.respond = () => {
    if (!fr4Called) {
      fr4Called = true;
      return {
        tools: [
          {
            name: "larva_subagent_activity",
            args: { session_path: fr4File, tool_call_id: "c-fr4-big", segment_part: "result", offset: 0, length: 3000 },
          },
        ],
      };
    }
    return { text: "FR4 inspected." };
  };

  const framesFr4 = await p.prompt("Run FR4 large segment");
  const resFr4 = toolResults(framesFr4, "larva_subagent_activity")[0];
  assert.equal(resFr4.details.status, "success");
  const fr4Bytes = Buffer.byteLength(JSON.stringify(resFr4), "utf8");
  assert.ok(fr4Bytes <= 8192, `Native response must be <= 8192 bytes, was ${fr4Bytes}`);
  assert.equal(resFr4.details.call.segment.offset, 0);
  assert.equal(resFr4.details.call.segment.length, 3000);
  assert.equal(resFr4.details.call.segment.total_chars, 10000);
  assert.equal(resFr4.details.call.segment.has_more, true);
  // Single payload contract: segment text in content, not details
  assert.equal(resFr4.details.call.segment.text, undefined);
  assert.ok(resFr4.content[0].text.includes("--- BEGIN SEGMENT ---"));
  console.log("FR4 (native large payload, 8192-byte ceiling, segment range): PASS");

  // --- Case 6: Partial tail followed by completion (FR5) ---
  const fr5File = join(f.cwd, "native-fr5.jsonl");
  let fr5Content = JSON.stringify({ type: "session", version: 3, id: "sess-fr5", timestamp: "2026-09-21T18:00:00Z", cwd: f.cwd }) + "\n";
  fr5Content += JSON.stringify({
    type: "message",
    id: "m-fr5-1",
    timestamp: "2026-09-21T18:00:00Z",
    message: { role: "assistant", content: [{ type: "toolCall", id: "c-fr5-1", name: "tool", arguments: {} }] },
  }) + "\n";
  // Add unterminated line at end (no newline)
  const fr5Tail = JSON.stringify({
    type: "message",
    id: "m-fr5-tail",
    timestamp: "2026-09-21T18:00:05Z",
    message: { role: "assistant", content: [{ type: "toolCall", id: "c-fr5-tail", name: "tailtool", arguments: {} }] },
  });
  await writeFile(fr5File, fr5Content + fr5Tail, "utf8");

  let fr5Called = false;
  f.respond = () => {
    if (!fr5Called) {
      fr5Called = true;
      return { tools: [{ name: "larva_subagent_activity", args: { session_path: fr5File } }] };
    }
    return { text: "FR5 inspected." };
  };

  const framesFr5 = await p.prompt("Run FR5 partial tail");
  const resFr5 = toolResults(framesFr5, "larva_subagent_activity")[0];
  assert.equal(resFr5.details.status, "success");
  assert.equal(resFr5.details.items.length, 1);
  assert.equal(resFr5.details.items[0].call_id, "c-fr5-1");
  assert.ok(resFr5.details.diagnostics.some((d) => d.kind === "unterminated_tail"));
  console.log("FR5 (native partial tail preserved uncommitted): PASS");

  // --- Case 7: 100 broken records under budget & invalid UTF-8 (FR6) ---
  const fr6BrokenFile = join(f.cwd, "native-fr6-broken.jsonl");
  let fr6Content = JSON.stringify({ type: "session", version: 3, id: "sess-fr6", timestamp: "2026-09-21T18:00:00Z", cwd: f.cwd }) + "\n";
  for (let i = 0; i < 100; i += 1) {
    fr6Content += `{malformed line ${i}}\n`;
  }
  await writeFile(fr6BrokenFile, fr6Content, "utf8");

  let fr6Called = false;
  f.respond = () => {
    if (!fr6Called) {
      fr6Called = true;
      return { tools: [{ name: "larva_subagent_activity", args: { session_path: fr6BrokenFile } }] };
    }
    return { text: "FR6 inspected." };
  };

  const framesFr6 = await p.prompt("Run FR6 100 broken lines");
  const resFr6 = toolResults(framesFr6, "larva_subagent_activity")[0];
  assert.equal(resFr6.details.status, "success");
  const fr6Bytes = Buffer.byteLength(JSON.stringify(resFr6), "utf8");
  assert.ok(fr6Bytes <= 8192, `Response with 100 broken lines must be <= 8192 bytes, was ${fr6Bytes}`);
  assert.equal(resFr6.details.diagnostics_truncated, true);
  assert.equal(resFr6.details.total_diagnostics_count, 100);
  console.log("FR6 (native 100 broken records under budget): PASS");

  // Invalid UTF-8 bytes 0xFF
  const fr6Utf8File = join(f.cwd, "native-fr6-utf8.jsonl");
  const headBuf = Buffer.from(JSON.stringify({ type: "session", version: 3, id: "sess-utf8", timestamp: "2026-09-21T18:00:00Z", cwd: f.cwd }) + "\n", "utf8");
  const lineBuf = Buffer.concat([Buffer.from('{"type":"message","id":"m","message":{"role":"assistant","content":[{"type":"toolCall","id":"c","name":"echo","arguments":{"text":"', "utf8"), Buffer.from([0xff]), Buffer.from('"}}]}}\n', "utf8")]);
  const utf8Fd = openSync(fr6Utf8File, "w");
  writeSync(utf8Fd, Buffer.concat([headBuf, lineBuf]));
  closeSync(utf8Fd);

  let fr6Utf8Called = false;
  f.respond = () => {
    if (!fr6Utf8Called) {
      fr6Utf8Called = true;
      return { tools: [{ name: "larva_subagent_activity", args: { session_path: fr6Utf8File } }] };
    }
    return { text: "FR6 utf8 inspected." };
  };

  const framesFr6Utf8 = await p.prompt("Run FR6 invalid utf8");
  const resFr6Utf8 = toolResults(framesFr6Utf8, "larva_subagent_activity")[0];
  assert.equal(resFr6Utf8.details.status, "success");
  assert.ok(resFr6Utf8.details.diagnostics.some((d) => d.kind === "invalid_utf8"));
  console.log("FR6 (native invalid UTF-8 diagnosed without silent replacement): PASS");

  // --- Case 8: Fresh second parent process and cursor continuation without registry (FR7) ---
  // Create a historical session and read page 1 with parent 1
  const fr7File = join(f.cwd, "native-fr7-historical.jsonl");
  let fr7Content = JSON.stringify({ type: "session", version: 3, id: "sess-fr7", timestamp: "2026-09-21T18:00:00Z", cwd: f.cwd }) + "\n";
  fr7Content += JSON.stringify({
    type: "message",
    id: "m-fr7-1",
    timestamp: "2026-09-21T18:00:00Z",
    message: { role: "assistant", content: [{ type: "toolCall", id: "c-fr7-1", name: "toolA", arguments: {} }] },
  }) + "\n";
  await writeFile(fr7File, fr7Content, "utf8");

  let fr7Called1 = false;
  f.respond = () => {
    if (!fr7Called1) {
      fr7Called1 = true;
      return { tools: [{ name: "larva_subagent_activity", args: { session_path: fr7File } }] };
    }
    return { text: "Parent 1 read done." };
  };

  const framesFr7P1 = await p.prompt("Parent 1 read");
  const resFr7P1 = toolResults(framesFr7P1, "larva_subagent_activity")[0];
  const cursorP1 = resFr7P1.details.cursor;
  assert.ok(cursorP1, "Parent 1 must produce cursor");

  // Append new call
  await appendFile(fr7File, JSON.stringify({
    type: "message",
    id: "m-fr7-2",
    timestamp: "2026-09-21T18:01:00Z",
    message: { role: "assistant", content: [{ type: "toolCall", id: "c-fr7-2", name: "toolB", arguments: {} }] },
  }) + "\n", "utf8");

  // Stop parent 1!
  await p.stop();

  // Start fresh second parent process with clean environment & empty registry
  const p2 = new NativeRpc(f, ["--larva-persona", "ok"]);
  await p2.command("get_state");

  let fr7Called2 = false;
  f.respond = () => {
    if (!fr7Called2) {
      fr7Called2 = true;
      return { tools: [{ name: "larva_subagent_activity", args: { session_path: fr7File, cursor: cursorP1 } }] };
    }
    return { text: "Parent 2 continuation done." };
  };

  const framesFr7P2 = await p2.prompt("Parent 2 continue with cursor");
  const resFr7P2 = toolResults(framesFr7P2, "larva_subagent_activity")[0];
  assert.equal(resFr7P2.details.status, "success");
  assert.equal(resFr7P2.details.items.length, 1);
  assert.equal(resFr7P2.details.items[0].call_id, "c-fr7-2");
  assert.equal(resFr7P2.details.items[0].update_type, "new_call");
  console.log("FR7 (fresh second parent process continues reading via cursor without registry): PASS");

  // --- Case 9: Callback & Watchdog Neutrality (FR8) ---
  // Stat file before and after read
  const statBefore = await stat(fr7File);

  let fr8Called = false;
  f.respond = () => {
    if (!fr8Called) {
      fr8Called = true;
      return { tools: [{ name: "larva_subagent_activity", args: { session_path: fr7File } }] };
    }
    return { text: "FR8 neutral read done." };
  };

  const framesFr8 = await p2.prompt("Read activity for neutrality check");
  const resFr8 = toolResults(framesFr8, "larva_subagent_activity")[0];
  assert.equal(resFr8.details.status, "success");

  const statAfter = await stat(fr7File);
  assert.equal(statBefore.mtimeMs, statAfter.mtimeMs, "Session file mtime must be unchanged");
  assert.equal(statBefore.size, statAfter.size, "Session file size must be unchanged");

  // Verify no callback events were emitted and no child processes were spawned
  const inspectAfter = await f.inspect();
  assert.equal(inspectAfter.liveChildren.length, 0, "No child processes spawned by activity tool");

  // Check observations log to confirm no callback execution or watchdog resets
  const callbackEvents = framesFr8.filter((frame) => frame.type === "larva-subagent-result");
  assert.equal(callbackEvents.length, 0, "Activity reading must never emit subagent result callback events");

  await p2.stop();
  console.log("FR8 (pure read-only neutrality: no writes, no callback consumption, no watchdog resets): PASS");

  console.log("\nALL 9 FUNCTIONAL REQUIREMENTS PROVEN NATIVELY THROUGH REAL PI LOADER AND RPC!");
} finally {
  await f.close();
}
