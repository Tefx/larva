// purpose: verify larva_subagent_activity runtime contracts and complete counterexamples
// usage: node contrib/pi-extension/test-subagent-activity-runtime.mjs
// effects: disposable scratch directories only; no global configuration changes
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, stat, appendFile, truncate } from "node:fs/promises";
import { openSync, writeSync, closeSync } from "node:fs";
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
    const entry = {
      type: "message",
      id,
      parentId,
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
    };
    if (timestamp) entry.timestamp = timestamp;
    return JSON.stringify(entry) + "\n";
  }

  function makeToolResultEntry(id, parentId, timestamp, toolCallId, toolName, content, isError) {
    const msg = {
      role: "toolResult",
      toolCallId,
      toolName,
      content,
    };
    if (isError !== undefined) msg.isError = isError;
    const entry = {
      type: "message",
      id,
      parentId,
      message: msg,
    };
    if (timestamp) entry.timestamp = timestamp;
    return JSON.stringify(entry) + "\n";
  }

  // --- Scenario 1: Multiple/parallel calls with errors and missing results (FR1) ---
  {
    const sessionFile = join(root, "fr1-parallel-calls.jsonl");
    let content = makeSessionHeader("fr1-session");
    content += makeAssistantToolCallEntry("msg-1", null, "2026-09-21T18:01:00.000Z", [
      { id: "call-1", name: "bash", args: { command: "echo ok" } },
      { id: "call-2", name: "read", args: { path: "file.txt" } },
      { id: "call-3", name: "write", args: { path: "out.txt" } },
      { id: "call-4", name: "calc", args: { expr: "1+1" } },
    ]);
    content += makeToolResultEntry("res-1", "msg-1", "2026-09-21T18:01:05.000Z", "call-1", "bash", "ok", false);
    content += makeToolResultEntry("res-2", "msg-1", "2026-09-21T18:01:06.000Z", "call-2", "read", "file not found", true);
    content += makeToolResultEntry("res-3", "msg-1", "2026-09-21T18:01:07.000Z", "call-3", "write", "written", undefined);

    await writeFile(sessionFile, content, "utf8");

    const res = await mod.larva_subagent_activity({ session_path: sessionFile, limit: 10 });
    assert.equal(res.isError, false);
    assert.equal(res.details.status, "success");
    assert.equal(res.details.items?.length, 4);

    const items = res.details.items;
    assert.equal(items[0].call_id, "call-1");
    assert.equal(items[0].result_status, "observed");
    assert.equal(items[0].is_error, false);
    assert.equal(items[0].call_location.content_index, 0);

    assert.equal(items[1].call_id, "call-2");
    assert.equal(items[1].result_status, "observed");
    assert.equal(items[1].is_error, true);
    assert.equal(items[1].call_location.content_index, 1);

    assert.equal(items[2].call_id, "call-3");
    assert.equal(items[2].result_status, "observed");
    assert.equal(items[2].is_error, null);
    assert.equal(items[2].call_location.content_index, 2);

    assert.equal(items[3].call_id, "call-4");
    assert.equal(items[3].result_status, "none");
    assert.equal(items[3].is_error, null);
    assert.equal(items[3].call_location.content_index, 3);

    console.log("FR1 (multiple/parallel calls with errors and missing results): PASS");
  }

  // --- Scenario 2: Lossless Paging & 20-call budget shrink (FR2 + Counterexample 1) ---
  {
    const sessionFile = join(root, "fr2-20-calls-lossless.jsonl");
    let content = makeSessionHeader("fr2-parent-proof");
    // One assistant message with 20 calls: c0..c19
    const calls20 = [];
    for (let i = 0; i < 20; i += 1) {
      calls20.push({ id: `c${i}`, name: "bash", args: { command: `echo ${i}` } });
    }
    content += makeAssistantToolCallEntry("entry-20", null, "2026-09-21T00:01:00.000Z", calls20);
    // Add results for some calls
    for (let i = 0; i < 20; i += 2) {
      content += makeToolResultEntry(`res-${i}`, "entry-20", `2026-09-21T00:01:0${Math.floor(i / 2)}.000Z`, `c${i}`, "bash", `output ${i}`, false);
    }
    await writeFile(sessionFile, content, "utf8");

    // Page 1: limit 20
    const page1 = await mod.larva_subagent_activity({ session_path: sessionFile, limit: 20 });
    assert.equal(page1.details.status, "success");
    const byteLen1 = Buffer.byteLength(JSON.stringify(page1), "utf8");
    assert.ok(byteLen1 <= 8192, `Page 1 size must be <= 8192 bytes, was ${byteLen1}`);

    const deliveredPage1 = page1.details.items ?? [];
    assert.ok(deliveredPage1.length > 0 && deliveredPage1.length < 20, "Should deliver subset of 20 calls under 8192 bytes");
    assert.equal(page1.details.has_more, true, "Must indicate has_more when budget shrank delivery");
    assert.ok(page1.details.cursor, "Must provide cursor");

    // Page 2: with returned cursor, limit 20
    const page2 = await mod.larva_subagent_activity({ session_path: sessionFile, cursor: page1.details.cursor, limit: 20 });
    assert.equal(page2.details.status, "success");
    const byteLen2 = Buffer.byteLength(JSON.stringify(page2), "utf8");
    assert.ok(byteLen2 <= 8192, `Page 2 size must be <= 8192 bytes, was ${byteLen2}`);

    const deliveredPage2 = page2.details.items ?? [];
    assert.ok(deliveredPage2.length > 0, "Page 2 must return the remaining items, NOT []");

    const allDelivered = [...deliveredPage1, ...deliveredPage2].map((it) => it.call_id);
    assert.equal(allDelivered.length, 20, "Must deliver exactly 20 calls across pages without loss");
    for (let i = 0; i < 20; i += 1) {
      assert.ok(allDelivered.includes(`c${i}`), `Call c${i} must be delivered`);
    }

    // Filter mismatch check on cursor:
    const mismatchedCursorRes = await mod.larva_subagent_activity({
      session_path: sessionFile,
      cursor: page1.details.cursor,
      tool_name: "read", // different filter than page 1 (which had no filter)
    });
    assert.equal(mismatchedCursorRes.isError, true);
    assert.equal(mismatchedCursorRes.details.error?.code, "LARVA_CURSOR_INVALID");

    console.log("FR2 (append new calls and late results, lossless paging): PASS");
  }

  // --- Scenario 3: Exact ID outside the recent window (FR3) ---
  {
    const sessionFile = join(root, "fr3-exact-lookup.jsonl");
    let content = makeSessionHeader("fr3-session");
    for (let i = 1; i <= 15; i += 1) {
      content += makeAssistantToolCallEntry(`msg-${i}`, null, `2026-09-21T18:0${i}:00.000Z`, [
        { id: `call-exact-${i}`, name: `tool_${i}`, args: { index: i, detail: `args for call ${i}` } },
      ]);
      content += makeToolResultEntry(`res-${i}`, `msg-${i}`, `2026-09-21T18:0${i}:05.000Z`, `call-exact-${i}`, `tool_${i}`, `result for call ${i}`, false);
    }
    await writeFile(sessionFile, content, "utf8");

    const exact = await mod.larva_subagent_activity({ session_path: sessionFile, tool_call_id: "call-exact-2" });
    assert.equal(exact.details.status, "success");
    assert.equal(exact.details.mode, "call_lookup");
    assert.equal(exact.details.call?.call_id, "call-exact-2");
    assert.equal(exact.details.call?.result_status, "observed");

    const notFound = await mod.larva_subagent_activity({ session_path: sessionFile, tool_call_id: "nonexistent-call-999" });
    assert.equal(notFound.details.status, "not_found");
    assert.equal(notFound.details.inspection_complete, true);
    assert.match(notFound.details.error?.message, /not found in session after complete inspection/);

    console.log("FR3 (exact ID outside recent window): PASS");
  }

  // --- Scenario 4: Large args/results with measured whole-response ceiling and reconstructable segments (FR4) ---
  {
    const sessionFile = join(root, "fr4-large-segments.jsonl");
    let content = makeSessionHeader("fr4-session");
    const bigArgs = "A".repeat(10000);
    const bigResult = "R".repeat(12000);
    content += makeAssistantToolCallEntry("msg-large", null, "2026-09-21T18:01:00.000Z", [
      { id: "call-large", name: "heavy_tool", args: { payload: bigArgs } },
    ]);
    content += makeToolResultEntry("res-large", "msg-large", "2026-09-21T18:01:05.000Z", "call-large", "heavy_tool", bigResult, false);
    await writeFile(sessionFile, content, "utf8");

    // 1. Recent mode
    const recent = await mod.larva_subagent_activity({ session_path: sessionFile });
    assert.equal(recent.details.status, "success");
    const recentBytes = Buffer.byteLength(JSON.stringify(recent), "utf8");
    assert.ok(recentBytes <= 8192, `Recent response must be <= 8192 bytes, was ${recentBytes}`);

    // Verify recent content includes exact record location
    assert.ok(recent.content[0].text.includes("Location: entry msg-large#0"), "Model-visible content must include original entry location");

    // 2. Segment reconstruction
    let reconstructedResult = "";
    let offset = 0;
    const chunkLength = 3000;
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

      // Contract: segment text is in content, NOT duplicated in details!
      assert.equal(segRes.details.call.segment.text, undefined, "segment.text must NOT be duplicated in details");
      const match = segRes.content[0].text.match(/--- BEGIN SEGMENT ---\n([\s\S]*?)\n--- END SEGMENT ---/);
      assert.ok(match, "Segment text must be present in content delimiter block");
      const segmentText = match[1];

      assert.equal(segmentText.length, segRes.details.call.segment.length);
      reconstructedResult += segmentText;
      lastSourceVersion = segRes.details.call.segment.source_version;

      if (!segRes.details.call.segment.has_more) break;
      offset = segRes.details.call.segment.continuation_offset;
    }

    assert.equal(reconstructedResult, bigResult, "Reconstructed result must match original 12,000 char string byte-for-byte");

    console.log("FR4 (large args/results with measured entire-response bounds and reconstructable segments): PASS");
  }

  // --- Scenario 5: Partial tail followed by completion (FR5) ---
  {
    const sessionFile = join(root, "fr5-partial-tail.jsonl");
    let content = makeSessionHeader("fr5-session");
    content += makeAssistantToolCallEntry("msg-1", null, "2026-09-21T18:01:00.000Z", [
      { id: "call-term-1", name: "toolA", args: { v: 1 } },
    ]);
    content += makeToolResultEntry("res-1", "msg-1", "2026-09-21T18:01:02.000Z", "call-term-1", "toolA", "res1", false);

    const unterminatedTail = JSON.stringify({
      type: "message",
      id: "msg-unterminated",
      parentId: "res-1",
      timestamp: "2026-09-21T18:02:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-pending", name: "toolPending", arguments: {} }],
      },
    });

    await writeFile(sessionFile, content + unterminatedTail, "utf8");

    const read1 = await mod.larva_subagent_activity({ session_path: sessionFile });
    assert.equal(read1.details.status, "success");
    assert.equal(read1.details.items?.length, 1);
    assert.ok(read1.details.diagnostics?.some((d) => d.kind === "unterminated_tail"));

    // Exact not-found with partial tail must report incomplete inspection!
    const notFoundPending = await mod.larva_subagent_activity({ session_path: sessionFile, tool_call_id: "missing-xyz" });
    assert.equal(notFoundPending.details.status, "not_found");
    assert.equal(notFoundPending.details.inspection_complete, false);
    assert.match(notFoundPending.details.error?.message, /inspection incomplete/);

    await appendFile(sessionFile, "\n", "utf8");
    const read2 = await mod.larva_subagent_activity({ session_path: sessionFile, cursor: read1.details.cursor });
    assert.equal(read2.details.status, "success");
    assert.equal(read2.details.items?.length, 1);
    assert.equal(read2.details.items[0].call_id, "call-pending");

    console.log("FR5 (partial tail followed by completion while prior records remain available): PASS");
  }

  // --- Scenario 6: Missing/damaged input, 100 broken lines under budget, invalid UTF-8, replacement & regrowth (FR6 + Counterexamples 2 & 3) ---
  {
    // 1. Missing file
    const missingRes = await mod.larva_subagent_activity({ session_path: join(root, "nonexistent.jsonl") });
    assert.equal(missingRes.isError, true);
    assert.equal(missingRes.details.error?.code, "LARVA_SESSION_NOT_FOUND");

    // 2. 100 broken records under 8192 bytes (Counterexample 2)
    const broken100File = join(root, "broken-100.jsonl");
    let brokenContent = makeSessionHeader("broken-100-sess");
    for (let i = 0; i < 100; i += 1) {
      brokenContent += "{broken line not json " + i + "}\n";
    }
    await writeFile(broken100File, brokenContent, "utf8");
    const brokenRes = await mod.larva_subagent_activity({ session_path: broken100File });
    assert.equal(brokenRes.details.status, "success");
    const brokenBytes = Buffer.byteLength(JSON.stringify(brokenRes), "utf8");
    assert.ok(brokenBytes <= 8192, `Response with 100 broken lines must be <= 8192 bytes, was ${brokenBytes}`);
    assert.equal(brokenRes.details.diagnostics_truncated, true);
    assert.equal(brokenRes.details.total_diagnostics_count, 100);
    assert.ok(brokenRes.details.diagnostics.length <= 5);

    // 3. Invalid UTF-8 0xFF byte in JSON string (Counterexample 3)
    const invalidUtf8File = join(root, "invalid-utf8.jsonl");
    const validHeaderBuf = Buffer.from(makeSessionHeader("utf8-sess"), "utf8");
    const msgPrefixBuf = Buffer.from(
      JSON.stringify({
        type: "message",
        id: "m-utf8",
        timestamp: "2026-09-21T18:00:00Z",
        message: { role: "assistant", content: [{ type: "toolCall", id: "c-bad", name: "echo", arguments: { command: "echo " } }] },
      }).slice(0, -5),
      "utf8",
    );
    // Insert 0xFF byte
    const badByteBuf = Buffer.from([0xff]);
    const msgSuffixBuf = Buffer.from('"} ] } }\n', "utf8");
    const combinedBuf = Buffer.concat([validHeaderBuf, msgPrefixBuf, badByteBuf, msgSuffixBuf]);
    const fd = openSync(invalidUtf8File, "w");
    writeSync(fd, combinedBuf);
    closeSync(fd);

    const utf8Res = await mod.larva_subagent_activity({ session_path: invalidUtf8File });
    assert.equal(utf8Res.details.status, "success");
    assert.ok(utf8Res.details.diagnostics.some((d) => d.kind === "invalid_utf8"), "Must report invalid_utf8 diagnostic on 0xFF byte");

    // 4. Header validation: missing version or id
    const badHeaderFile = join(root, "bad-header.jsonl");
    await writeFile(badHeaderFile, JSON.stringify({ type: "session" }) + "\n", "utf8");
    const badHeaderRes = await mod.larva_subagent_activity({ session_path: badHeaderFile });
    assert.equal(badHeaderRes.isError, true);
    assert.equal(badHeaderRes.details.error?.code, "LARVA_BAD_INPUT");
    assert.match(badHeaderRes.details.error?.message, /missing required id or version/);

    // 5. Shrink & Truncate
    const shrinkFile = join(root, "shrink.jsonl");
    await writeFile(shrinkFile, makeSessionHeader("shrink") + makeAssistantToolCallEntry("m1", null, "2026-09-21T18:00:00Z", [{ id: "c1", name: "t1", args: {} }]), "utf8");
    const shrink1 = await mod.larva_subagent_activity({ session_path: shrinkFile });
    await truncate(shrinkFile, 50);
    const shrink2 = await mod.larva_subagent_activity({ session_path: shrinkFile, cursor: shrink1.details.cursor });
    assert.equal(shrink2.isError, true);
    assert.equal(shrink2.details.error?.code, "LARVA_CURSOR_STALE");
    assert.match(shrink2.details.error?.message, /truncated/);

    // 6. Replacement with same size & header (File Identity check)
    const replaceFile = join(root, "replace-same-id.jsonl");
    const origContent = makeSessionHeader("ident-same") + makeAssistantToolCallEntry("m1", null, "2026-09-21T18:00:00Z", [{ id: "c1", name: "t1", args: { v: 1 } }]);
    await writeFile(replaceFile, origContent, "utf8");
    const rep1 = await mod.larva_subagent_activity({ session_path: replaceFile });

    // Delete and recreate file at same path (changes inode)
    await rm(replaceFile);
    await writeFile(replaceFile, origContent, "utf8");
    const rep2 = await mod.larva_subagent_activity({ session_path: replaceFile, cursor: rep1.details.cursor });
    assert.equal(rep2.isError, true);
    assert.equal(rep2.details.error?.code, "LARVA_CURSOR_STALE");
    assert.match(rep2.details.error?.message, /replaced/);

    console.log("FR6 (missing/damaged input, invalid cursor, replacement, shrink and shrink/regrowth): PASS");
  }

  // --- Scenario 7: History read and cursor continuation from a new parent without registry (FR7) ---
  {
    const histFile = join(root, "fr7-history.jsonl");
    await writeFile(histFile, makeSessionHeader("fr7-historical-session") + makeAssistantToolCallEntry("m1", null, "2026-09-21T18:01:00.000Z", [{ id: "h1", name: "toolA", args: {} }]), "utf8");

    const resA = await mod.larva_subagent_activity({ session_path: histFile });
    assert.equal(resA.details.status, "success");
    const cursor = resA.details.cursor;

    await appendFile(histFile, makeAssistantToolCallEntry("msg-2", "m1", "2026-09-21T18:02:00.000Z", [{ id: "h2", name: "toolB", args: {} }]), "utf8");
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
    assert.equal(statBefore.mtimeMs, statAfter.mtimeMs);
    assert.equal(statBefore.size, statAfter.size);

    console.log("FR8 (no target writes, callback consumption or lifecycle changes): PASS");
  }

  // --- Scenario 9: Duplicate call provenance and Timezone-filter matching by result timestamp ---
  {
    const filterFile = join(root, "filter-provenance.jsonl");
    let content = makeSessionHeader("filter-prov-session");
    // Call 1 at 18:01:00Z (before window)
    content += makeAssistantToolCallEntry("m1", null, "2026-09-21T18:01:00.000Z", [{ id: "c-old", name: "long_job", args: {} }]);
    // Result 1 at 18:06:00Z (IN window: 18:05..18:10)
    content += makeToolResultEntry("r1", "m1", "2026-09-21T18:06:00.000Z", "c-old", "long_job", "job complete", false);

    await writeFile(filterFile, content, "utf8");

    // Query with since_timestamp 18:05:00Z: should match c-old because its RESULT completed in the window!
    const resTimeFilter = await mod.larva_subagent_activity({
      session_path: filterFile,
      since_timestamp: "2026-09-21T18:05:00.000Z",
    });
    assert.equal(resTimeFilter.details.status, "success");
    assert.equal(resTimeFilter.details.items?.length, 1);
    assert.equal(resTimeFilter.details.items[0].call_id, "c-old");
    assert.equal(resTimeFilter.details.items[0].matched_by, "result_timestamp");

    console.log("Correlation, Provenance & Result-timestamp filtering: PASS");
  }

  console.log("\ntest-subagent-activity-runtime: ALL TESTS PASSED");
} finally {
  await rm(root, { recursive: true, force: true });
}
