// purpose: verify larva_subagent_activity runtime contract and functional requirements FR1-FR8
// usage: node contrib/pi-extension/test-subagent-activity-runtime.mjs
// effects: disposable scratch directories only; no global configuration changes
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, stat, appendFile, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Quarantine ambient subagent / Pi variables
for (const key of Object.keys(process.env)) {
  if (/^(LARVA_|PI_)/.test(key) && !key.startsWith("LARVA_TEST_")) delete process.env[key];
}

const root = await mkdtemp(join(tmpdir(), "larva-activity-runtime-"));

try {
  const extensionPath = new URL("./larva.ts", import.meta.url).pathname;
  const mod = await import(pathToFileURL(extensionPath).href);

  // Helper to create a synthetic session file
  function makeSessionHeader(sessionId = "test-session-001") {
    return JSON.stringify({
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: "2026-09-21T18:00:00.000Z",
      cwd: "/test/project",
    }) + "\n";
  }

  function makeAssistantToolCallEntry(id, parentId, timestamp, toolCalls) {
    return JSON.stringify({
      type: "message",
      id,
      parentId,
      timestamp,
      message: {
        role: "assistant",
        content: toolCalls.map((tc) => ({
          type: "toolCall",
          id: tc.id,
          name: tc.name,
          arguments: tc.args,
        })),
        provider: "mock",
        model: "mock-model",
      },
    }) + "\n";
  }

  function makeToolResultEntry(id, parentId, timestamp, toolCallId, toolName, content, isError) {
    const msg = {
      role: "toolResult",
      toolCallId,
      toolName,
      content,
    };
    if (isError !== undefined) msg.isError = isError;
    return JSON.stringify({
      type: "message",
      id,
      parentId,
      timestamp,
      message: msg,
    }) + "\n";
  }

  // --- Scenario 1: Multiple/parallel calls with errors and missing results (FR1) ---
  {
    const sessionFile = join(root, "fr1-parallel-calls.jsonl");
    let content = makeSessionHeader("fr1-session");
    // Assistant message with 4 parallel calls
    content += makeAssistantToolCallEntry("msg-1", null, "2026-09-21T18:01:00.000Z", [
      { id: "call-1", name: "bash", args: { command: "echo ok" } },
      { id: "call-2", name: "read", args: { path: "file.txt" } },
      { id: "call-3", name: "write", args: { path: "out.txt" } },
      { id: "call-4", name: "calc", args: { expr: "1+1" } },
    ]);
    // Result for call-1: isError: false
    content += makeToolResultEntry("res-1", "msg-1", "2026-09-21T18:01:05.000Z", "call-1", "bash", "ok", false);
    // Result for call-2: isError: true
    content += makeToolResultEntry("res-2", "msg-1", "2026-09-21T18:01:06.000Z", "call-2", "read", "file not found", true);
    // Result for call-3: isError omitted (absent / null)
    content += makeToolResultEntry("res-3", "msg-1", "2026-09-21T18:01:07.000Z", "call-3", "write", "written", undefined);
    // call-4 has NO result entry (missing result)

    await writeFile(sessionFile, content, "utf8");

    const res = await mod.larva_subagent_activity({ session_path: sessionFile, limit: 10 });
    assert.equal(res.isError, false);
    assert.equal(res.details.status, "success");
    assert.equal(res.details.items?.length, 4);

    const items = res.details.items;
    // Call 1
    assert.equal(items[0].call_id, "call-1");
    assert.equal(items[0].tool_name, "bash");
    assert.equal(items[0].result_status, "observed");
    assert.equal(items[0].is_error, false);
    assert.equal(items[0].call_location.content_index, 0);

    // Call 2
    assert.equal(items[1].call_id, "call-2");
    assert.equal(items[1].tool_name, "read");
    assert.equal(items[1].result_status, "observed");
    assert.equal(items[1].is_error, true);
    assert.equal(items[1].call_location.content_index, 1);

    // Call 3
    assert.equal(items[2].call_id, "call-3");
    assert.equal(items[2].tool_name, "write");
    assert.equal(items[2].result_status, "observed");
    assert.equal(items[2].is_error, null); // Preserved as absent
    assert.equal(items[2].call_location.content_index, 2);

    // Call 4
    assert.equal(items[3].call_id, "call-4");
    assert.equal(items[3].tool_name, "calc");
    assert.equal(items[3].result_status, "none");
    assert.equal(items[3].is_error, null);
    assert.equal(items[3].call_location.content_index, 3);

    console.log("FR1 (multiple/parallel calls with errors and missing results): PASS");
  }

  // --- Scenario 2: Append new calls and late results for old calls, with lossless paging (FR2) ---
  {
    const sessionFile = join(root, "fr2-append-paging.jsonl");
    let content = makeSessionHeader("fr2-session");
    // Call 1 with result
    content += makeAssistantToolCallEntry("msg-1", null, "2026-09-21T18:01:00.000Z", [
      { id: "c-old-1", name: "toolA", args: { x: 1 } },
    ]);
    content += makeToolResultEntry("res-1", "msg-1", "2026-09-21T18:01:02.000Z", "c-old-1", "toolA", "resA", false);
    // Call 2 WITHOUT result
    content += makeAssistantToolCallEntry("msg-2", "res-1", "2026-09-21T18:01:10.000Z", [
      { id: "c-old-2", name: "toolB", args: { x: 2 } },
    ]);
    await writeFile(sessionFile, content, "utf8");

    // First read: returns c-old-1 and c-old-2
    const read1 = await mod.larva_subagent_activity({ session_path: sessionFile, limit: 5 });
    assert.equal(read1.details.status, "success");
    assert.equal(read1.details.items?.length, 2);
    const cursor1 = read1.details.cursor;
    assert.ok(cursor1, "Must emit cursor");

    // Now append: late result for c-old-2, plus new call c-new-3 and c-new-4
    let append = makeToolResultEntry("res-2", "msg-2", "2026-09-21T18:02:00.000Z", "c-old-2", "toolB", "late result B", false);
    append += makeAssistantToolCallEntry("msg-3", "res-2", "2026-09-21T18:02:10.000Z", [
      { id: "c-new-3", name: "toolC", args: { x: 3 } },
      { id: "c-new-4", name: "toolD", args: { x: 4 } },
    ]);
    append += makeToolResultEntry("res-3", "msg-3", "2026-09-21T18:02:15.000Z", "c-new-3", "toolC", "resC", false);
    await appendFile(sessionFile, append, "utf8");

    // Second read using cursor1 with limit: 2 (testing paging!)
    const read2 = await mod.larva_subagent_activity({ session_path: sessionFile, cursor: cursor1, limit: 2 });
    assert.equal(read2.details.status, "success");
    assert.equal(read2.details.items?.length, 2);
    assert.equal(read2.details.has_more, true);

    // Items in read2 should include late result for c-old-2, and c-new-3
    const idsRead2 = read2.details.items.map((it) => it.call_id);
    assert.ok(idsRead2.includes("c-old-2"), "Must deliver late result for old call");
    const old2 = read2.details.items.find((it) => it.call_id === "c-old-2");
    assert.equal(old2.update_type, "late_result");
    assert.equal(old2.result_status, "observed");
    assert.equal(old2.result_preview, "late result B");

    // Next page using cursor from read2
    const cursor2 = read2.details.cursor;
    const read3 = await mod.larva_subagent_activity({ session_path: sessionFile, cursor: cursor2, limit: 2 });
    assert.equal(read3.details.status, "success");
    assert.equal(read3.details.items?.length, 1);
    assert.equal(read3.details.items[0].call_id, "c-new-4");
    assert.equal(read3.details.items[0].update_type, "new_call");
    assert.equal(read3.details.has_more, false);

    // Next read: no more updates
    const cursor3 = read3.details.cursor;
    const read4 = await mod.larva_subagent_activity({ session_path: sessionFile, cursor: cursor3, limit: 5 });
    assert.equal(read4.details.status, "success");
    assert.equal(read4.details.items?.length, 0);
    assert.equal(read4.details.has_more, false);

    console.log("FR2 (append new calls and late results for old calls, with lossless paging): PASS");
  }

  // --- Scenario 3: Exact ID outside the recent window (FR3) ---
  {
    const sessionFile = join(root, "fr3-exact-lookup.jsonl");
    let content = makeSessionHeader("fr3-session");
    // Generate 12 tool calls
    for (let i = 1; i <= 12; i += 1) {
      content += makeAssistantToolCallEntry(`msg-${i}`, null, `2026-09-21T18:0${i}:00.000Z`, [
        { id: `call-exact-${i}`, name: `tool_${i}`, args: { index: i, detail: `args for call ${i}` } },
      ]);
      content += makeToolResultEntry(`res-${i}`, `msg-${i}`, `2026-09-21T18:0${i}:05.000Z`, `call-exact-${i}`, `tool_${i}`, `result for call ${i}`, false);
    }
    await writeFile(sessionFile, content, "utf8");

    // Recent mode with default limit: 5 returns calls 8..12
    const recent = await mod.larva_subagent_activity({ session_path: sessionFile });
    assert.equal(recent.details.items?.length, 5);
    const recentIds = recent.details.items.map((it) => it.call_id);
    assert.deepEqual(recentIds, ["call-exact-8", "call-exact-9", "call-exact-10", "call-exact-11", "call-exact-12"]);

    // Lookup call-exact-2 (way outside recent window)
    const exact = await mod.larva_subagent_activity({ session_path: sessionFile, tool_call_id: "call-exact-2" });
    assert.equal(exact.details.status, "success");
    assert.equal(exact.details.mode, "call_lookup");
    assert.equal(exact.details.call?.call_id, "call-exact-2");
    assert.equal(exact.details.call?.tool_name, "tool_2");
    assert.equal(exact.details.call?.result_status, "observed");
    assert.equal(exact.details.call?.result_preview, "result for call 2");

    // Lookup non-existent ID
    const notFound = await mod.larva_subagent_activity({ session_path: sessionFile, tool_call_id: "nonexistent-call-999" });
    assert.equal(notFound.details.status, "not_found");
    assert.match(notFound.details.error?.message, /not found in session after complete inspection/);

    console.log("FR3 (exact ID outside recent window): PASS");
  }

  // --- Scenario 4: Large args/results with measured entire-response bounds and reconstructable segments (FR4) ---
  {
    const sessionFile = join(root, "fr4-large-segments.jsonl");
    let content = makeSessionHeader("fr4-session");
    // Generate large argument string (10,000 chars) and large result string (12,000 chars)
    const bigArgs = "A".repeat(10000);
    const bigResult = "R".repeat(12000);
    content += makeAssistantToolCallEntry("msg-large", null, "2026-09-21T18:01:00.000Z", [
      { id: "call-large", name: "heavy_tool", args: { payload: bigArgs } },
    ]);
    content += makeToolResultEntry("res-large", "msg-large", "2026-09-21T18:01:05.000Z", "call-large", "heavy_tool", bigResult, false);
    await writeFile(sessionFile, content, "utf8");

    // 1. Recent mode check: previews must be truncated and entire response <= 8192 bytes
    const recent = await mod.larva_subagent_activity({ session_path: sessionFile });
    assert.equal(recent.details.status, "success");
    const item = recent.details.items[0];
    assert.equal(item.args_truncated, true);
    assert.equal(item.result_truncated, true);
    assert.equal(item.args_preview.length, 200);
    assert.equal(item.result_preview.length, 500);

    const recentByteLength = Buffer.byteLength(JSON.stringify(recent), "utf8");
    assert.ok(recentByteLength <= 8192, `Recent response must be <= 8192 bytes, was ${recentByteLength}`);

    // 2. Exact segment reading: reconstruct bigResult in chunks of 4000
    let reconstructedResult = "";
    let offset = 0;
    const chunkLength = 4000;
    let iterations = 0;
    let lastSourceVersion = null;

    while (iterations < 10) {
      iterations += 1;
      const segRes = await mod.larva_subagent_activity({
        session_path: sessionFile,
        tool_call_id: "call-large",
        segment_part: "result",
        offset,
        length: chunkLength,
        source_version: lastSourceVersion ?? undefined,
      });

      assert.equal(segRes.details.status, "success");
      const respBytes = Buffer.byteLength(JSON.stringify(segRes), "utf8");
      assert.ok(respBytes <= 8192, `Segment response must be <= 8192 bytes, was ${respBytes}`);

      const segment = segRes.details.call.segment;
      assert.ok(segment, "Must have segment");
      assert.equal(segment.offset, offset);
      assert.equal(segment.total_chars, 12000);
      reconstructedResult += segment.text;
      lastSourceVersion = segment.source_version;

      if (!segment.has_more) break;
      offset = segment.continuation_offset;
    }

    assert.equal(reconstructedResult, bigResult, "Reconstructed result must match original 12,000 char string byte-for-byte");

    // 3. Reconstruct bigArgs (which is inside JSON-stringified args)
    const exactCall = await mod.larva_subagent_activity({ session_path: sessionFile, tool_call_id: "call-large", segment_part: "args", offset: 0, length: 4000 });
    assert.equal(exactCall.details.call.segment.part, "args");
    assert.ok(exactCall.details.call.segment.total_chars >= 10000);

    console.log("FR4 (large args/results with measured entire-response bounds and reconstructable segments): PASS");
  }

  // --- Scenario 5: Partial tail followed by completion while prior records remain available (FR5) ---
  {
    const sessionFile = join(root, "fr5-partial-tail.jsonl");
    let content = makeSessionHeader("fr5-session");
    content += makeAssistantToolCallEntry("msg-1", null, "2026-09-21T18:01:00.000Z", [
      { id: "call-term-1", name: "toolA", args: { v: 1 } },
    ]);
    content += makeToolResultEntry("res-1", "msg-1", "2026-09-21T18:01:02.000Z", "call-term-1", "toolA", "res1", false);

    // Unterminated line at end (no newline!)
    const unterminatedTail = JSON.stringify({
      type: "message",
      id: "msg-unterminated",
      parentId: "res-1",
      timestamp: "2026-09-21T18:02:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-pending", name: "toolPending", arguments: {} }],
      },
    }); // NOTE: NO newline!

    await writeFile(sessionFile, content + unterminatedTail, "utf8");

    // Read 1: prior records must be readable, pending tail preserved uncommitted
    const read1 = await mod.larva_subagent_activity({ session_path: sessionFile });
    assert.equal(read1.details.status, "success");
    assert.equal(read1.details.items?.length, 1);
    assert.equal(read1.details.items[0].call_id, "call-term-1");
    // Diagnostics should indicate unterminated tail
    assert.ok(read1.details.diagnostics?.some((d) => d.kind === "unterminated_tail"));

    const cursor1 = read1.details.cursor;

    // Now writer completes the unterminated line by writing the newline!
    await appendFile(sessionFile, "\n", "utf8");

    // Read 2 using cursor1: now the completed line is committed and returned as new_call!
    const read2 = await mod.larva_subagent_activity({ session_path: sessionFile, cursor: cursor1 });
    assert.equal(read2.details.status, "success");
    assert.equal(read2.details.items?.length, 1);
    assert.equal(read2.details.items[0].call_id, "call-pending");
    assert.equal(read2.details.items[0].update_type, "new_call");

    console.log("FR5 (partial tail followed by completion while prior records remain available): PASS");
  }

  // --- Scenario 6: Missing/damaged input, invalid cursor, replacement, shrink and shrink/regrowth (FR6) ---
  {
    // 1. Missing file
    const missingRes = await mod.larva_subagent_activity({ session_path: join(root, "nonexistent.jsonl") });
    assert.equal(missingRes.isError, true);
    assert.equal(missingRes.details.error?.code, "LARVA_SESSION_NOT_FOUND");

    // 2. Non-session file (missing session header)
    const nonSessionFile = join(root, "not-a-session.jsonl");
    await writeFile(nonSessionFile, JSON.stringify({ type: "random", data: 123 }) + "\n", "utf8");
    const nonSessionRes = await mod.larva_subagent_activity({ session_path: nonSessionFile });
    assert.equal(nonSessionRes.isError, true);
    assert.equal(nonSessionRes.details.error?.code, "LARVA_BAD_INPUT");
    assert.match(nonSessionRes.details.error?.message, /missing session header/);

    // 3. Interior malformed JSON: valid session with 1 corrupted line
    const malformedFile = join(root, "interior-malformed.jsonl");
    let malformedContent = makeSessionHeader("malformed-session");
    malformedContent += makeAssistantToolCallEntry("msg-ok1", null, "2026-09-21T18:01:00.000Z", [
      { id: "call-good-1", name: "toolOk", args: {} },
    ]);
    malformedContent += "CORRUPTED_LINE_NOT_JSON{{{}}\n";
    malformedContent += makeAssistantToolCallEntry("msg-ok2", null, "2026-09-21T18:01:05.000Z", [
      { id: "call-good-2", name: "toolOk", args: {} },
    ]);
    await writeFile(malformedFile, malformedContent, "utf8");

    const malformedRes = await mod.larva_subagent_activity({ session_path: malformedFile });
    assert.equal(malformedRes.details.status, "success");
    assert.equal(malformedRes.details.items?.length, 2);
    assert.ok(malformedRes.details.diagnostics?.some((d) => d.kind === "malformed_json" && d.line_number === 3));

    // 4. Invalid cursor (garbage)
    const invalidCursorRes = await mod.larva_subagent_activity({ session_path: malformedFile, cursor: "not-a-base64-cursor!!!" });
    assert.equal(invalidCursorRes.isError, true);
    assert.equal(invalidCursorRes.details.error?.code, "LARVA_CURSOR_INVALID");

    // 5. Mismatched cursor (cursor for another file)
    const normalFileA = join(root, "fileA.jsonl");
    const normalFileB = join(root, "fileB.jsonl");
    await writeFile(normalFileA, makeSessionHeader("sessA"), "utf8");
    await writeFile(normalFileB, makeSessionHeader("sessB"), "utf8");
    const resA = await mod.larva_subagent_activity({ session_path: normalFileA });
    const cursorA = resA.details.cursor;

    const mismatchedRes = await mod.larva_subagent_activity({ session_path: normalFileB, cursor: cursorA });
    assert.equal(mismatchedRes.isError, true);
    assert.equal(mismatchedRes.details.error?.code, "LARVA_CURSOR_INVALID");
    assert.match(mismatchedRes.details.error?.message, /does not match/);

    // 6. File truncated (file size shrunk)
    const shrinkFile = join(root, "shrink.jsonl");
    let shrinkContent = makeSessionHeader("shrink-sess");
    shrinkContent += makeAssistantToolCallEntry("msg-1", null, "2026-09-21T18:01:00.000Z", [{ id: "c1", name: "t1", args: {} }]);
    shrinkContent += makeAssistantToolCallEntry("msg-2", null, "2026-09-21T18:02:00.000Z", [{ id: "c2", name: "t2", args: {} }]);
    await writeFile(shrinkFile, shrinkContent, "utf8");

    const shrinkRead1 = await mod.larva_subagent_activity({ session_path: shrinkFile });
    const shrinkCursor = shrinkRead1.details.cursor;

    // Truncate file to half
    await truncate(shrinkFile, 60);
    const shrinkRead2 = await mod.larva_subagent_activity({ session_path: shrinkFile, cursor: shrinkCursor });
    assert.equal(shrinkRead2.isError, true);
    assert.equal(shrinkRead2.details.error?.code, "LARVA_CURSOR_STALE");
    assert.match(shrinkRead2.details.error?.message, /truncated/);

    // 7. File replaced (same path, new session header)
    const replaceFile = join(root, "replace.jsonl");
    await writeFile(replaceFile, makeSessionHeader("replace-old") + makeAssistantToolCallEntry("m1", null, "2026-09-21T18:00:00Z", [{ id: "c", name: "t", args: {} }]), "utf8");
    const replaceRead1 = await mod.larva_subagent_activity({ session_path: replaceFile });
    const replaceCursor = replaceRead1.details.cursor;

    // Overwrite with brand new session
    await writeFile(replaceFile, makeSessionHeader("replace-NEW") + makeAssistantToolCallEntry("m1", null, "2026-09-21T18:00:00Z", [{ id: "c", name: "t", args: {} }]), "utf8");
    const replaceRead2 = await mod.larva_subagent_activity({ session_path: replaceFile, cursor: replaceCursor });
    assert.equal(replaceRead2.isError, true);
    assert.equal(replaceRead2.details.error?.code, "LARVA_CURSOR_STALE");
    assert.match(replaceRead2.details.error?.message, /replaced/);

    // 8. Truncated and regrown with changed contents
    const regrowFile = join(root, "regrow.jsonl");
    const regrowHeader = makeSessionHeader("regrow-sess");
    const regrowLine1 = makeAssistantToolCallEntry("m1", null, "2026-09-21T18:00:00Z", [{ id: "c1", name: "t1", args: {} }]);
    await writeFile(regrowFile, regrowHeader + regrowLine1, "utf8");
    const regrowRead1 = await mod.larva_subagent_activity({ session_path: regrowFile });
    const regrowCursor = regrowRead1.details.cursor;

    // Replace line 1 with different content of greater length (so size >= cursor.off)
    const regrowLineDifferent = makeAssistantToolCallEntry("mX", null, "2026-09-21T18:99:99Z", [{ id: "cX", name: "tX_different", args: { diff: true, pad: "X".repeat(500) } }]);
    await writeFile(regrowFile, regrowHeader + regrowLineDifferent, "utf8");
    const regrowRead2 = await mod.larva_subagent_activity({ session_path: regrowFile, cursor: regrowCursor });
    assert.equal(regrowRead2.isError, true);
    assert.equal(regrowRead2.details.error?.code, "LARVA_CURSOR_STALE");
    assert.match(regrowRead2.details.error?.message, /prior contents changed/);

    console.log("FR6 (missing/damaged input, invalid cursor, replacement, shrink and shrink/regrowth): PASS");
  }

  // --- Scenario 7: History read and cursor continuation from a new parent without registry (FR7) ---
  {
    const histFile = join(root, "fr7-history.jsonl");
    let content = makeSessionHeader("fr7-historical-session");
    content += makeAssistantToolCallEntry("msg-1", null, "2026-09-21T18:01:00.000Z", [{ id: "h1", name: "toolA", args: {} }]);
    await writeFile(histFile, content, "utf8");

    // Process A: reads without any registry or active subagents
    const resA = await mod.larva_subagent_activity({ session_path: histFile });
    assert.equal(resA.details.status, "success");
    const cursor = resA.details.cursor;

    // Simulate process B: completely fresh import or isolated context
    await appendFile(histFile, makeAssistantToolCallEntry("msg-2", "msg-1", "2026-09-21T18:02:00.000Z", [{ id: "h2", name: "toolB", args: {} }]), "utf8");
    const resB = await mod.larva_subagent_activity({ session_path: histFile, cursor }, { env: { HOME: "/nowhere" } });
    assert.equal(resB.details.status, "success");
    assert.equal(resB.details.items?.length, 1);
    assert.equal(resB.details.items[0].call_id, "h2");

    console.log("FR7 (history read and cursor continuation without registry): PASS");
  }

  // --- Scenario 8: No target writes, callback consumption or reader-induced lifecycle/watchdog changes (FR8) ---
  {
    const testFile = join(root, "fr8-pure-readonly.jsonl");
    await writeFile(testFile, makeSessionHeader("fr8-session") + makeAssistantToolCallEntry("m1", null, "2026-09-21T18:00:00Z", [{ id: "c1", name: "t1", args: {} }]), "utf8");

    const statBefore = await stat(testFile);

    const read = await mod.larva_subagent_activity({ session_path: testFile });
    assert.equal(read.details.status, "success");

    const statAfter = await stat(testFile);
    assert.equal(statBefore.mtimeMs, statAfter.mtimeMs, "mtime must not change");
    assert.equal(statBefore.size, statAfter.size, "file size must not change");

    console.log("FR8 (no target writes, callback consumption or lifecycle changes): PASS");
  }

  // --- Filters, Duplicates & Compaction Deduplication ---
  {
    const filterFile = join(root, "filter-dup-compaction.jsonl");
    let content = makeSessionHeader("filter-session");
    // Message 1: tool "alpha", timestamp 2026-09-21T18:01:00Z
    content += makeAssistantToolCallEntry("m1", null, "2026-09-21T18:01:00.000Z", [{ id: "c-dup", name: "alpha", args: { v: 1 } }]);
    // Message 2: tool "beta", timestamp 2026-09-21T18:05:00Z
    content += makeAssistantToolCallEntry("m2", "m1", "2026-09-21T18:05:00.000Z", [{ id: "c-beta", name: "beta", args: { v: 2 } }]);
    // Compaction entry with retainedTail (must NOT be counted)
    content += JSON.stringify({
      type: "compaction",
      id: "comp-1",
      parentId: "m2",
      timestamp: "2026-09-21T18:06:00.000Z",
      summary: "compacted",
      retainedTail: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "c-dup", name: "alpha", arguments: { v: 1 } }],
        },
      ],
    }) + "\n";
    // Message 3: duplicate ID "c-dup" with tool "gamma", timestamp 2026-09-21T18:10:00Z
    content += makeAssistantToolCallEntry("m3", "comp-1", "2026-09-21T18:10:00.000Z", [{ id: "c-dup", name: "gamma", args: { v: 3 } }]);

    await writeFile(filterFile, content, "utf8");

    // 1. Tool name filter
    const filterAlpha = await mod.larva_subagent_activity({ session_path: filterFile, tool_name: "alpha" });
    assert.equal(filterAlpha.details.items?.length, 1);
    assert.equal(filterAlpha.details.items[0].tool_name, "alpha");

    // 2. Timestamp filter
    const filterTime = await mod.larva_subagent_activity({ session_path: filterFile, since_timestamp: "2026-09-21T18:04:00.000Z" });
    assert.equal(filterTime.details.items?.length, 2);
    assert.deepEqual(filterTime.details.items.map((it) => it.tool_name), ["beta", "gamma"]);

    // 3. Compaction check: total calls inspected should be 3 (not 4)
    assert.equal(filterAlpha.details.total_calls_inspected, 3);

    // 4. Duplicate ID lookup: ambiguous status
    const dupRes = await mod.larva_subagent_activity({ session_path: filterFile, tool_call_id: "c-dup" });
    assert.equal(dupRes.details.status, "ambiguous");
    assert.equal(dupRes.details.candidates?.length, 2);
    assert.equal(dupRes.details.candidates[0].entry_id, "m1");
    assert.equal(dupRes.details.candidates[1].entry_id, "m3");

    // Disambiguate by disambiguation_index: 1
    const disambigRes = await mod.larva_subagent_activity({ session_path: filterFile, tool_call_id: "c-dup", disambiguation_index: 1 });
    assert.equal(disambigRes.details.status, "success");
    assert.equal(disambigRes.details.call?.call_location.entry_id, "m3");
    assert.equal(disambigRes.details.call?.tool_name, "gamma");

    console.log("Filters, Duplicates & Compaction deduplication: PASS");
  }

  console.log("\ntest-subagent-activity-runtime: ALL TESTS PASSED");
} finally {
  await rm(root, { recursive: true, force: true });
}
