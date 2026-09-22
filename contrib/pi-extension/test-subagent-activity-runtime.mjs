// purpose: behavioral regression checks for file-only activity inspection
// usage: node contrib/pi-extension/test-subagent-activity-runtime.mjs
// effects: disposable fixture files only
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, appendFile, stat, rename, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import { larva_subagent_activity } from "./larva.ts";
const root = await mkdtemp(join(tmpdir(), "larva-activity-runtime-"));
const stamp = "2026-09-21T18:00:00Z";
const line = x => JSON.stringify(x) + "\n";
const header = id => line({ type: "session", version: 3, id, timestamp: stamp });
const call = (id, ids = [id], extra = {}) => line({ type: "message", id, parentId: null, timestamp: stamp, message: { role: "assistant", content: ids.map(id => ({ type: "toolCall", id, name: "tool", arguments: { value: id } })) }, ...extra });
const result = (id, parentId, content, extra = {}) => line({ type: "message", id: `r-${id}`, parentId, timestamp: stamp, message: { role: "toolResult", toolCallId: id, toolName: "tool", content, ...extra } });
let maxBytes = 0;
async function inspect(args, ctx) {
  const raw = await larva_subagent_activity(args, ctx);
  const size = Buffer.byteLength(JSON.stringify(raw)); maxBytes = Math.max(maxBytes, size);
  assert.ok(size <= 8192, `whole response ${size}`);
  assert.deepEqual(Object.keys(raw.details), ["status"], "payload exists only in model-visible content");
  return JSON.parse(raw.content[0].text);
}
async function drain(file, initial, limit = 20) {
  const items = [...initial.items]; let page = initial;
  for (let i = 0; page.has_more; i++) {
    assert.ok(i < 40, "paging must make progress");
    page = await inspect({ session_path: file, cursor: page.cursor, limit });
    assert.equal(page.status, "success"); assert.ok(page.items.length > 0);
    items.push(...page.items);
  }
  return { items, cursor: page.cursor };
}
try {
  const file = join(root, "history.jsonl");
  await writeFile(file, header("history") + call("m", ["ok", "error", "absent", "missing"]) + result("ok", "m", "ok", { isError: false }) + result("error", "m", "bad", { isError: true }) + result("absent", "m", "recorded"));
  const first = await inspect({ session_path: file });
  assert.equal(first.items.length, 4);
  assert.equal(first.items[0].is_error, false); assert.equal(first.items[1].is_error, true);
  assert.equal(Object.hasOwn(first.items[2], "is_error"), false);
  assert.equal(first.items[3].result_state, "not_observed");
  assert.equal(Object.hasOwn(first.items[3], "result"), false);
  assert.equal(Object.hasOwn(first.items[0], "result_state"), false);
  assert.deepEqual(Object.keys(first.items[0]), ["call_id", "action", "result", "is_error"]);
  assert.equal(first.items[0].action, 'tool {"value":"ok"}');
  assert.equal(first.items[0].result, "ok");
  assert.deepEqual(Object.keys(first), ["status", "items", "has_more", "cursor"]);
  assert.equal(Object.hasOwn(first.items[2], "call_location"), false);
  assert.equal(Object.hasOwn(first.items[2], "key"), false);
  const detail = await inspect({ session_path: file, tool_call_id: "absent" });
  assert.equal(detail.call.call_location.content_index, 2);
  assert.equal(detail.call.tool_name, "tool");
  assert.equal(detail.session_id, "history");
  console.log("compact default shape, false/true/absent error markers, unobserved result state, and exact detail reachability verified");

  // Frozen incremental pages must retain update ordering, late old calls, and
  // arrivals during paging. A result outside the original tail still appears.
  await appendFile(file, call("later", Array.from({ length: 20 }, (_, i) => `c${i}`)) + result("missing", "m", "late"));
  const update = await inspect({ session_path: file, cursor: first.cursor, limit: 2 });
  await appendFile(file, call("after-page"));
  const pages = await drain(file, update, 2);
  assert.equal(pages.items.length, 21); assert.equal(new Set(pages.items.map(x => x.call_id)).size, 21);
  assert.equal(Object.hasOwn(pages.items[0], "key"), false);
  assert.equal(Object.hasOwn(pages.items[0], "update_type"), false);
  assert.equal(pages.items.at(-1).call_id, "missing"); assert.equal(pages.items.at(-1).update_type, "late_result");
  const arrival = await inspect({ session_path: file, cursor: pages.cursor });
  assert.deepEqual(arrival.items.map(x => x.call_id), ["after-page"]);
  const mismatch = await inspect({ session_path: file, cursor: first.cursor, tool_name: "different" });
  assert.equal(mismatch.error.code, "LARVA_CURSOR_INVALID");
  const twenty = join(root, "twenty.jsonl");
  const callIds = Array.from({ length: 20 }, (_, i) => `c${i}`);
  const paddedResults = callIds.map(id => result(id, "parallel", "r".repeat(450))).join("");
  await writeFile(twenty, header("twenty") + call("parallel", callIds) + paddedResults);
  const shrunk = await inspect({ session_path: twenty, limit: 20 });
  assert.ok(shrunk.items.length < 20); assert.equal(shrunk.has_more, true);
  const invalidPosition = JSON.parse(Buffer.from(shrunk.cursor, "base64url"));
  invalidPosition.after[1] = 99999;
  assert.equal((await inspect({ session_path: twenty, cursor: Buffer.from(JSON.stringify(invalidPosition)).toString("base64url") })).error.code, "LARVA_CURSOR_INVALID");
  assert.deepEqual((await drain(twenty, shrunk)).items.map(x => x.call_id), Array.from({ length: 20 }, (_, i) => `c${i}`));
  console.log("same-record budget paging, late updates, append-between-pages, query binding: lossless");

  const exact = await inspect({ session_path: file, tool_call_id: "ok" });
  assert.equal(JSON.parse(exact.call.segment.text).content, "ok");
  const huge = join(root, "large.jsonl");
  const text = '漢😀\\\"\n--- END SEGMENT ---'.repeat(1600);
  const args = { text }, saved = { role: "toolResult", toolCallId: "big", toolName: "tool", content: [{ type: "text", text }, { type: "image", data: "abcd", mimeType: "image/png" }], details: { nested: { n: 42 }, truncation: { truncated: true }, fullOutputPath: "/must/not/follow" }, isError: false, timestamp: 0 };
  await writeFile(huge, header("large") + call("big", ["big"], { message: { role: "assistant", content: [{ type: "toolCall", id: "big", name: "tool", arguments: args }] } }) + line({ type: "message", id: "r", parentId: "big", timestamp: stamp, message: saved }));
  for (const part of ["args", "result"]) {
    let text = "", offset = 0, version;
    for (let i = 0; i < 200; i++) {
      const page = await inspect({ session_path: huge, tool_call_id: "big", segment_part: part, offset, length: 4000, ...(version ? { source_version: version } : {}) });
      assert.equal(page.status, "success"); const seg = page.call.segment;
      assert.equal(seg.offset, offset); assert.equal(seg.length, seg.text.length); assert.ok(seg.length > 0);
      text += seg.text; version = seg.source_version;
      if (!seg.has_more) break;
      assert.equal(seg.continuation_offset, offset + seg.length); offset = seg.continuation_offset;
    }
    assert.equal(text, JSON.stringify(part === "args" ? args : saved));
    // Append is allowed: a source token freezes the inspected prefix.
    await appendFile(huge, call(`append-${part}`));
    const stable = await inspect({ session_path: huge, tool_call_id: "big", segment_part: part, source_version: version });
    assert.equal(stable.status, "success");
    const wrong = await inspect({ session_path: huge, tool_call_id: "big", segment_part: part === "args" ? "result" : "args", source_version: version });
    assert.equal(wrong.error.code, "LARVA_CURSOR_INVALID");
  }
  for (const flag of [false, true, undefined]) {
    const markers = join(root, `truncation-${flag}.jsonl`);
    await writeFile(markers, header("flags") + call("cut") + result("cut", "cut", "recorded", { details: { truncation: flag === undefined ? {} : { truncated: flag }, fullOutputPath: "/must-not-be-followed" } }));
    const observed = await inspect({ session_path: markers, tool_call_id: "cut" });
    assert.equal(observed.call.upstream_truncated, flag);
    assert.equal(observed.call.segment.upstream_truncated, flag);
  }
  console.log("complete Unicode/escaping args and structured result reconstruction; explicit truncation flags preserved; frozen selection-bound chunks");

  const projFile = join(root, "projections.jsonl");
  const longActionArg = { data: "a".repeat(300) };
  const longResultText = "r".repeat(700);
  await writeFile(projFile, header("projections")
    + line({ type: "message", id: "p1", parentId: null, timestamp: stamp, message: { role: "assistant", content: [
        { type: "toolCall", id: "empty-res", name: "tool", arguments: { op: "empty" } },
        { type: "toolCall", id: "multi-res", name: "tool", arguments: { op: "multi" } },
        { type: "toolCall", id: "img-res", name: "tool", arguments: { op: "img" } },
        { type: "toolCall", id: "mixed-res", name: "tool", arguments: { op: "mixed" } },
        { type: "toolCall", id: "struct-res", name: "tool", arguments: { op: "struct" } },
        { type: "toolCall", id: "struct-arr", name: "tool", arguments: { op: "arr" } },
        { type: "toolCall", id: "struct-str", name: "tool", arguments: { op: "str" } },
        { type: "toolCall", id: "struct-num", name: "tool", arguments: { op: "num" } },
        { type: "toolCall", id: "struct-trunc-extra", name: "tool", arguments: { op: "trunc-extra" } },
        { type: "toolCall", id: "details-only-path", name: "tool", arguments: { op: "path-only" } },
        { type: "toolCall", id: "details-empty-obj", name: "tool", arguments: { op: "empty-obj" } },
        { type: "toolCall", id: "details-null", name: "tool", arguments: { op: "null" } },
        { type: "toolCall", id: "long-act", name: "tool", arguments: longActionArg },
        { type: "toolCall", id: "long-res", name: "tool", arguments: { op: "long" } },
      ] } })
    + line({ type: "message", id: "r-empty", parentId: "p1", timestamp: stamp, message: { role: "toolResult", toolCallId: "empty-res", toolName: "tool", content: "" } })
    + line({ type: "message", id: "r-multi", parentId: "p1", timestamp: stamp, message: { role: "toolResult", toolCallId: "multi-res", toolName: "tool", content: [{ type: "text", text: "part 1" }, { type: "text", text: "part 2" }] } })
    + line({ type: "message", id: "r-img", parentId: "p1", timestamp: stamp, message: { role: "toolResult", toolCallId: "img-res", toolName: "tool", content: [{ type: "image", data: "abcd", mimeType: "image/png" }] } })
    + line({ type: "message", id: "r-mixed", parentId: "p1", timestamp: stamp, message: { role: "toolResult", toolCallId: "mixed-res", toolName: "tool", content: [{ type: "text", text: "caption" }, { type: "image", data: "abcd", mimeType: "image/png" }] } })
    + line({ type: "message", id: "r-struct", parentId: "p1", timestamp: stamp, message: { role: "toolResult", toolCallId: "struct-res", toolName: "tool", content: "", details: { count: 42, flag: true } } })
    + line({ type: "message", id: "r-struct-arr", parentId: "p1", timestamp: stamp, message: { role: "toolResult", toolCallId: "struct-arr", toolName: "tool", content: [], details: [{ count: 42 }] } })
    + line({ type: "message", id: "r-struct-str", parentId: "p1", timestamp: stamp, message: { role: "toolResult", toolCallId: "struct-str", toolName: "tool", content: [], details: "diagnostic string" } })
    + line({ type: "message", id: "r-struct-num", parentId: "p1", timestamp: stamp, message: { role: "toolResult", toolCallId: "struct-num", toolName: "tool", content: [], details: 42 } })
    + line({ type: "message", id: "r-struct-trunc", parentId: "p1", timestamp: stamp, message: { role: "toolResult", toolCallId: "struct-trunc-extra", toolName: "tool", content: [], details: { truncation: { truncated: true, reason: "limit" } } } })
    + line({ type: "message", id: "r-details-path", parentId: "p1", timestamp: stamp, message: { role: "toolResult", toolCallId: "details-only-path", toolName: "tool", content: "", details: { fullOutputPath: "/must-not-be-read" } } })
    + line({ type: "message", id: "r-details-empty", parentId: "p1", timestamp: stamp, message: { role: "toolResult", toolCallId: "details-empty-obj", toolName: "tool", content: "", details: {} } })
    + line({ type: "message", id: "r-details-null", parentId: "p1", timestamp: stamp, message: { role: "toolResult", toolCallId: "details-null", toolName: "tool", content: "", details: null } })
    + line({ type: "message", id: "r-long-act", parentId: "p1", timestamp: stamp, message: { role: "toolResult", toolCallId: "long-act", toolName: "tool", content: "ok" } })
    + line({ type: "message", id: "r-long-res", parentId: "p1", timestamp: stamp, message: { role: "toolResult", toolCallId: "long-res", toolName: "tool", content: longResultText } })
  );
  const projRecent = await inspect({ session_path: projFile, limit: 20 });
  const byId = Object.fromEntries(projRecent.items.map(x => [x.call_id, x]));

  assert.equal(byId["empty-res"].result, "");
  assert.equal(Object.hasOwn(byId["empty-res"], "result_truncated"), false);
  assert.equal(Object.hasOwn(byId["empty-res"], "has_image"), false);
  assert.equal(Object.hasOwn(byId["empty-res"], "has_details"), false);

  assert.equal(byId["multi-res"].result, "part 1\npart 2");
  assert.equal(Object.hasOwn(byId["multi-res"], "result_truncated"), false);

  assert.equal(byId["img-res"].result, "");
  assert.equal(byId["img-res"].has_image, true);
  assert.equal(byId["img-res"].result_truncated, true);

  assert.equal(byId["mixed-res"].result, "caption");
  assert.equal(byId["mixed-res"].has_image, true);
  assert.equal(byId["mixed-res"].result_truncated, true);

  assert.equal(byId["struct-res"].result, "");
  assert.equal(byId["struct-res"].has_details, true);
  assert.equal(byId["struct-res"].result_truncated, true);

  assert.equal(byId["struct-arr"].result, "");
  assert.equal(byId["struct-arr"].has_details, true);
  assert.equal(byId["struct-arr"].result_truncated, true);
  const exactArr = await inspect({ session_path: projFile, tool_call_id: "struct-arr" });
  assert.deepEqual(JSON.parse(exactArr.call.segment.text).details, [{ count: 42 }]);

  assert.equal(byId["struct-str"].result, "");
  assert.equal(byId["struct-str"].has_details, true);
  assert.equal(byId["struct-str"].result_truncated, true);

  assert.equal(byId["struct-num"].result, "");
  assert.equal(byId["struct-num"].has_details, true);
  assert.equal(byId["struct-num"].result_truncated, true);

  assert.equal(byId["struct-trunc-extra"].result, "");
  assert.equal(byId["struct-trunc-extra"].has_details, true);
  assert.equal(byId["struct-trunc-extra"].result_truncated, true);

  assert.equal(byId["details-only-path"].result, "");
  assert.equal(Object.hasOwn(byId["details-only-path"], "has_details"), false);
  assert.equal(Object.hasOwn(byId["details-only-path"], "result_truncated"), false);

  assert.equal(byId["details-empty-obj"].result, "");
  assert.equal(Object.hasOwn(byId["details-empty-obj"], "has_details"), false);
  assert.equal(Object.hasOwn(byId["details-empty-obj"], "result_truncated"), false);

  assert.equal(byId["details-null"].result, "");
  assert.equal(Object.hasOwn(byId["details-null"], "has_details"), false);
  assert.equal(Object.hasOwn(byId["details-null"], "result_truncated"), false);

  assert.equal(byId["long-act"].action.length, 200);
  assert.equal(byId["long-act"].action_truncated, true);
  assert.equal(Object.hasOwn(byId["empty-res"], "action_truncated"), false);

  assert.equal(byId["long-res"].result.length, 500);
  assert.equal(byId["long-res"].result_truncated, true);
  console.log("content projections: empty, multi-text, image-only, mixed, structured-only, action/result truncation verified");

  const partial = join(root, "partial.jsonl");
  const tail = call("tail").trimEnd();
  await writeFile(partial, header("partial") + call("prior") + tail);
  const p1 = await inspect({ session_path: partial });
  assert.equal(p1.items.length, 1); assert.equal(p1.inspection_complete, false); assert.equal(p1.items[0].result_state, "incomplete");
  const unknownTail = await inspect({ session_path: partial, tool_call_id: "tail" });
  assert.equal(unknownTail.inspection_complete, false); assert.equal(unknownTail.status, "partial");
  assert.equal(unknownTail.error.code, "LARVA_ACTIVITY_INCOMPLETE");
  const incompleteResult = await inspect({ session_path: partial, tool_call_id: "prior" });
  assert.equal(incompleteResult.call.result_state, "incomplete"); assert.equal(incompleteResult.call.segment, undefined);
  await appendFile(partial, "\n");
  assert.deepEqual((await inspect({ session_path: partial, cursor: p1.cursor })).items.map(x => x.call_id), ["tail"]);
  const broken = join(root, "broken.jsonl");
  await writeFile(broken, Buffer.concat([Buffer.from(header("broken") + "{bad}\n".repeat(100)), Buffer.from('{"x":"'), Buffer.from([255]), Buffer.from('"}\n'), Buffer.from(call("valid"))]));
  const damaged = await inspect({ session_path: broken });
  assert.equal(damaged.total_diagnostics_count, 101); assert.equal(damaged.diagnostics_truncated, true); assert.equal(damaged.items[0].result_state, "incomplete");
  const utf8 = join(root, "utf8.jsonl");
  await writeFile(utf8, Buffer.concat([Buffer.from(header("u")), Buffer.from('{"x":"'), Buffer.from([255]), Buffer.from('"}\n')]));
  assert.equal((await inspect({ session_path: utf8 })).diagnostics[0].kind, "invalid_utf8");
  for (const version of [1, 4, -1]) { await writeFile(utf8, line({ type: "session", version, id: "u" })); assert.equal((await inspect({ session_path: utf8 })).error.code, "LARVA_SESSION_INVALID"); }
  assert.equal((await inspect({ session_path: join(root, "missing.jsonl") })).error.code, "LARVA_SESSION_NOT_FOUND");
  assert.equal((await inspect({ session_path: file, cursor: "garbage" })).error.code, "LARVA_CURSOR_INVALID");
  for (const operation of ["replacement", "shrink", "regrowth"]) {
    await writeFile(utf8, header("identity") + call("original"));
    const before = await inspect({ session_path: utf8 });
    if (operation === "replacement") { await rename(utf8, `${utf8}.old`); await writeFile(utf8, header("identity") + call("original")); }
    else if (operation === "shrink") await truncate(utf8, 5);
    else { await truncate(utf8, 0); await appendFile(utf8, header("identity") + call("different-and-longer")); }
    assert.equal((await inspect({ session_path: utf8, cursor: before.cursor })).error.code, "LARVA_CURSOR_STALE");
  }
  console.log("partial tail completion, diagnostic sampling, invalid UTF-8/header/token, missing/replaced/shrunk/regrown source");

  const duplicates = join(root, "duplicates.jsonl");
  await writeFile(duplicates, header("branches") + call("a", ["same"]) + call("b", ["same"]) + result("same", "a", "branch-a") + result("same", "b", "branch-b") + line({ type: "compaction", retainedTail: [{ role: "assistant", content: [{ type: "toolCall", id: "copied", name: "tool", arguments: {} }] }] }));
  const dupRecent = await inspect({ session_path: duplicates });
  assert.equal(dupRecent.items.length, 2);
  assert.deepEqual(dupRecent.items.map(x => x.call_id), ["same", "same"]);
  assert.ok(!dupRecent.items.some(x => x.call_id === "copied"), "compaction retainedTail copies must not be counted or emitted as activity calls");
  assert.equal(dupRecent.items[0].disambiguation_index, 0);
  assert.equal(dupRecent.items[1].disambiguation_index, 1);
  const ambiguous = await inspect({ session_path: duplicates, tool_call_id: "same" });
  assert.equal(ambiguous.status, "ambiguous"); assert.equal(ambiguous.total_candidates_count, 2);
  for (const [index, expected, expEntry] of [[0, "branch-a", "a"], [1, "branch-b", "b"]]) {
    const chosen = await inspect({ session_path: duplicates, tool_call_id: "same", disambiguation_index: index });
    assert.equal(JSON.parse(chosen.call.segment.text).content, expected);
    assert.equal(chosen.call.call_location.entry_id, expEntry);
  }
  await appendFile(duplicates, result("same", "a", "second-a"));
  const multi = await inspect({ session_path: duplicates, tool_call_id: "same", entry_id: "a" });
  assert.equal(multi.call.result_state, "ambiguous"); assert.equal(multi.call.result_candidates_count, 2);
  assert.equal(multi.call.segment, undefined);
  const disambiguated = await inspect({ session_path: duplicates, tool_call_id: "same", entry_id: "a", result_index: 1 });
  assert.equal(Object.hasOwn(disambiguated.call, "result_state"), false);
  assert.equal(disambiguated.call.selected_result_index, 1);
  assert.equal(JSON.parse(disambiguated.call.segment.text).content, "second-a");
  assert.equal((await inspect({ session_path: duplicates, since_timestamp: "2026-09-21T18:00:00" })).error.code, "LARVA_BAD_INPUT");
  await writeFile(utf8, header("filter") + call("old", ["old"], { timestamp: "2026-09-21T17:00:00Z" }) + result("old", "old", "later"));
  assert.equal((await inspect({ session_path: utf8, since_timestamp: stamp })).items[0].matched_by, "result_timestamp");
  const unknown = join(root, "ambiguous-association.jsonl");
  await writeFile(unknown, header("unknown") + call("same-entry", ["duplicate", "duplicate"]));
  const beforeUnknown = await inspect({ session_path: unknown });
  await appendFile(unknown, result("duplicate", "same-entry", "recorded but cannot assign to one sibling"));
  const unknownUpdates = await inspect({ session_path: unknown, cursor: beforeUnknown.cursor });
  assert.equal(unknownUpdates.items.length, 2);
  assert.ok(unknownUpdates.items.every(x => x.result_state === "ambiguous" && x.result_association === "ambiguous"));
  const unknownDetail = await inspect({ session_path: unknown, tool_call_id: "duplicate", disambiguation_index: 0, result_index: 0 });
  assert.equal(unknownDetail.call.result_state, "ambiguous");
  assert.equal(unknownDetail.call.result_association, "ambiguous");
  assert.equal(JSON.parse(unknownDetail.call.segment.text).content, "recorded but cannot assign to one sibling");
  const fifo = join(root, "accidental-fifo.jsonl");
  assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
  assert.equal((await inspect({ session_path: fifo })).error.code, "LARVA_SESSION_INVALID");

  // Traceability of duplicate call IDs across entries, tools, and siblings
  const traceFile = join(root, "traceability.jsonl");
  await writeFile(traceFile, header("traceability")
    + line({ type: "message", id: "m-uniq", parentId: null, timestamp: "2026-09-21T10:00:00Z", message: { role: "assistant", content: [{ type: "toolCall", id: "unique-call", name: "tool", arguments: { op: "u" } }] } })
    + line({ type: "message", id: "m-dup1", parentId: null, timestamp: "2026-09-21T11:00:00Z", message: { role: "assistant", content: [{ type: "toolCall", id: "cross-entry", name: "bash", arguments: { cmd: "first" } }] } })
    + line({ type: "message", id: "m-dup2", parentId: null, timestamp: "2026-09-21T12:00:00Z", message: { role: "assistant", content: [{ type: "toolCall", id: "cross-entry", name: "read", arguments: { path: "second" } }] } })
    + line({ type: "message", id: "m-sib", parentId: null, timestamp: "2026-09-21T13:00:00Z", message: { role: "assistant", content: [
        { type: "toolCall", id: "sibling", name: "tool", arguments: { idx: 0 } },
        { type: "toolCall", id: "sibling", name: "tool", arguments: { idx: 1 } },
      ] } })
    + result("unique-call", "m-uniq", "uniq-res")
    + result("cross-entry", "m-dup1", "res-dup1")
    + result("cross-entry", "m-dup2", "res-dup2")
    + result("sibling", "m-sib", "res-sib0")
  );
  const traceAll = await inspect({ session_path: traceFile, limit: 10 });
  const uItem = traceAll.items.find(x => x.call_id === "unique-call");
  assert.equal(Object.hasOwn(uItem, "disambiguation_index"), false);

  const tail1 = await inspect({ session_path: traceFile, limit: 1 });
  assert.equal(tail1.items[0].call_id, "sibling");
  assert.equal(tail1.items[0].disambiguation_index, 1);
  const expTail = await inspect({ session_path: traceFile, tool_call_id: "sibling", disambiguation_index: 1, segment_part: "args" });
  assert.deepEqual(JSON.parse(expTail.call.segment.text), { idx: 1 });

  const filt1 = await inspect({ session_path: traceFile, until_timestamp: "2026-09-21T11:30:00Z" });
  const dupFilt = filt1.items.find(x => x.call_id === "cross-entry");
  assert.equal(dupFilt.disambiguation_index, 0);
  const expFilt = await inspect({ session_path: traceFile, tool_call_id: "cross-entry", disambiguation_index: 0, segment_part: "args" });
  assert.deepEqual(JSON.parse(expFilt.call.segment.text), { cmd: "first" });

  const dup0 = traceAll.items.find(x => x.call_id === "cross-entry" && x.action.startsWith("bash"));
  const dup1 = traceAll.items.find(x => x.call_id === "cross-entry" && x.action.startsWith("read"));
  assert.equal(dup0.disambiguation_index, 0);
  assert.equal(dup1.disambiguation_index, 1);
  const expDup0 = await inspect({ session_path: traceFile, tool_call_id: "cross-entry", disambiguation_index: 0, segment_part: "args" });
  assert.deepEqual(JSON.parse(expDup0.call.segment.text), { cmd: "first" });
  const expDup1 = await inspect({ session_path: traceFile, tool_call_id: "cross-entry", disambiguation_index: 1, segment_part: "args" });
  assert.deepEqual(JSON.parse(expDup1.call.segment.text), { path: "second" });

  const sib0 = traceAll.items.find(x => x.call_id === "sibling" && x.action.includes('"idx":0'));
  const sib1 = traceAll.items.find(x => x.call_id === "sibling" && x.action.includes('"idx":1'));
  assert.equal(sib0.disambiguation_index, 0);
  assert.equal(sib1.disambiguation_index, 1);
  const expSib0 = await inspect({ session_path: traceFile, tool_call_id: "sibling", disambiguation_index: 0, segment_part: "args" });
  assert.deepEqual(JSON.parse(expSib0.call.segment.text), { idx: 0 });
  const expSib1 = await inspect({ session_path: traceFile, tool_call_id: "sibling", disambiguation_index: 1, segment_part: "args" });
  assert.deepEqual(JSON.parse(expSib1.call.segment.text), { idx: 1 });
  console.log("traceability: unique omits selector, single in tail, single filtered, cross-tool and siblings directly expandable");
  console.log("duplicate branches and unresolved association updates, multiple result disambiguation, compaction copies, timestamp filters and FIFO rejection");

  // Explicit in-flight cancellation, finite snapshot during append, descriptor
  // cleanup and absence of file writes. Largest-record storage, not session cache.
  const big = join(root, "cancel.jsonl");
  await writeFile(big, header("cancel") + (line({ type: "custom", data: "x".repeat(1000) })).repeat(20000));
  const controller = new AbortController();
  const pending = inspect({ session_path: big }, { abortSignal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 1);
  assert.equal((await pending).error.code, "LARVA_CHILD_CANCELLED"); clearTimeout(timer);
  const before = await stat(file); await inspect({ session_path: file }); const after = await stat(file);
  assert.equal(before.mtimeMs, after.mtimeMs); assert.equal(before.size, after.size);
  // Metadata and error paths are also bounded, including huge candidate IDs.
  await writeFile(utf8, header("s".repeat(12000)) + call("huge"));
  assert.equal((await inspect({ session_path: utf8 })).error.code, "LARVA_ACTIVITY_METADATA_TOO_LARGE");
  // Inject only the filesystem boundary around real reads. Every opened handle
  // is still the actual target descriptor and must close on each error/race.
  const originalOpen = fsPromises.open;
  for (const fault of ["append", "read-error", "replace", "shrink", "cancel", "access"]) {
    await writeFile(utf8, header("race") + call("race"));
    let opened = 0, closed = 0, fired = false;
    const abort = new AbortController();
    fsPromises.open = async (...argv) => {
      if (fault === "access") throw Object.assign(new Error("fixture access failure"), { code: "EACCES" });
      const handle = await originalOpen(...argv); opened++;
      const read = handle.read.bind(handle), close = handle.close.bind(handle);
      handle.close = async () => { closed++; return close(); };
      handle.read = async (...args) => {
        const value = await read(...args);
        if (!fired) {
          fired = true;
          if (fault === "read-error") throw Object.assign(new Error("fixture EIO"), { code: "EIO" });
          if (fault === "append") await appendFile(utf8, call("post-snapshot"));
          if (fault === "replace") { await rename(utf8, `${utf8}.race`); await writeFile(utf8, header("race") + call("race")); }
          if (fault === "shrink") await truncate(utf8, 0);
          if (fault === "cancel") abort.abort();
        }
        return value;
      };
      return handle;
    };
    syncBuiltinESMExports();
    try {
      const out = await inspect({ session_path: utf8 }, { abortSignal: abort.signal });
      if (fault === "append") { assert.equal(out.status, "success"); assert.deepEqual(out.items.map(x => x.call_id), ["race"]); }
      else assert.equal(out.error.code, fault === "read-error" ? "LARVA_SESSION_READ_FAILED" : fault === "access" ? "LARVA_SESSION_ACCESS_DENIED" : fault === "cancel" ? "LARVA_CHILD_CANCELLED" : "LARVA_CURSOR_STALE");
      assert.equal(closed, opened, `${fault}: every descriptor must close`);
    } finally { fsPromises.open = originalOpen; syncBuiltinESMExports(); }
  }
  console.log("finite snapshot append, injected EIO/EACCES, replacement/shrink/cancellation: all descriptors closed");

  const largeStress = join(root, "large-payload-stress.jsonl");
  await writeFile(largeStress, header("large-payloads"));
  const bigArg = { data: "x".repeat(40000) };
  for (let i = 0; i < 20; i++) {
    const callId = `lp-${i}`;
    const callLine = line({ type: "message", id: `m-${i}`, parentId: null, timestamp: stamp, message: { role: "assistant", content: [{ type: "toolCall", id: callId, name: "tool", arguments: bigArg }] } });
    const resLine = line({ type: "message", id: `r-${i}`, parentId: `m-${i}`, timestamp: stamp, message: { role: "toolResult", toolCallId: callId, toolName: "tool", content: "y".repeat(40000) } });
    await appendFile(largeStress, callLine + resLine);
  }
  const probeLarge = spawnSync(process.execPath, ["--max-old-space-size=32", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { larva_subagent_activity } from ${JSON.stringify(new URL('./larva.ts', import.meta.url).href)};
    const out = JSON.parse((await larva_subagent_activity({ session_path: ${JSON.stringify(largeStress)}, limit: 5 })).content[0].text);
    assert.equal(out.status, 'success');
    assert.equal(out.items.length, 5);
    assert.equal(out.items[0].action_truncated, true);
    assert.equal(out.items[0].result_truncated, true);
    assert.equal(out.items[0].action.length, 200);
    assert.equal(out.items[0].result.length, 500);
  `], { encoding: "utf8", timeout: 60000 });
  assert.equal(probeLarge.status, 0, probeLarge.stderr);
  console.log("bounded memory with large arguments/results in 32MB heap: PASS");

  const stress = join(root, "bounded-memory.jsonl");
  await writeFile(stress, header("stress"));
  for (let batch = 0; batch < 100; batch++) {
    let records = "";
    for (let i = 0; i < 1000; i++) records += call(`call-${batch * 1000 + i}`);
    await appendFile(stress, records);
  }
  const probe = spawnSync(process.execPath, ["--max-old-space-size=64", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { larva_subagent_activity } from ${JSON.stringify(new URL('./larva.ts', import.meta.url).href)};
    const first = JSON.parse((await larva_subagent_activity({ session_path: ${JSON.stringify(stress)} })).content[0].text);
    assert.equal(first.status, 'success');
    assert.equal(first.items.length, 5);
    assert.deepEqual(first.items.map(x => x.call_id), ['call-99995', 'call-99996', 'call-99997', 'call-99998', 'call-99999']);
    const quiet = JSON.parse((await larva_subagent_activity({ session_path: ${JSON.stringify(stress)}, cursor: first.cursor })).content[0].text);
    assert.equal(quiet.status, 'success'); assert.equal(quiet.items.length, 0);
    console.log(JSON.stringify({ tail_calls: first.items.map(x => x.call_id), heap_limit_MiB: 64, maxRSS: process.resourceUsage().maxRSS }));
  `], { encoding: "utf8", timeout: 120000 });
  assert.equal(probe.status, 0, probe.stderr);
  console.log(`bounded retained-memory stress: ${probe.stdout.trim()}`);
  console.log(`in-flight cancellation, file neutrality, metadata/error bound; max whole response=${maxBytes}`);
} finally { await rm(root, { recursive: true, force: true }); }
