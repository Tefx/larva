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
  assert.equal(first.items[3].result_status, "none");
  assert.equal(first.items[2].call_location.content_index, 2);
  console.log("parallel calls: false/true/absent error markers and missing result preserved");

  // Frozen incremental pages must retain update ordering, late old calls, and
  // arrivals during paging. A result outside the original tail still appears.
  await appendFile(file, call("later", Array.from({ length: 20 }, (_, i) => `c${i}`)) + result("missing", "m", "late"));
  const update = await inspect({ session_path: file, cursor: first.cursor, limit: 2 });
  await appendFile(file, call("after-page"));
  const pages = await drain(file, update, 2);
  assert.equal(pages.items.length, 21); assert.equal(new Set(pages.items.map(x => x.key)).size, 21);
  assert.equal(pages.items.at(-1).call_id, "missing"); assert.equal(pages.items.at(-1).update_type, "late_result");
  const arrival = await inspect({ session_path: file, cursor: pages.cursor });
  assert.deepEqual(arrival.items.map(x => x.call_id), ["after-page"]);
  const mismatch = await inspect({ session_path: file, cursor: first.cursor, tool_name: "different" });
  assert.equal(mismatch.error.code, "LARVA_CURSOR_INVALID");
  const twenty = join(root, "twenty.jsonl");
  await writeFile(twenty, header("twenty") + call("parallel", Array.from({ length: 20 }, (_, i) => `c${i}`)));
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

  const partial = join(root, "partial.jsonl");
  const tail = call("tail").trimEnd();
  await writeFile(partial, header("partial") + call("prior") + tail);
  const p1 = await inspect({ session_path: partial });
  assert.equal(p1.items.length, 1); assert.equal(p1.inspection_complete, false); assert.equal(p1.items[0].result_status, "incomplete");
  const unknownTail = await inspect({ session_path: partial, tool_call_id: "tail" });
  assert.equal(unknownTail.inspection_complete, false); assert.equal(unknownTail.status, "partial");
  assert.equal(unknownTail.error.code, "LARVA_ACTIVITY_INCOMPLETE");
  const incompleteResult = await inspect({ session_path: partial, tool_call_id: "prior" });
  assert.equal(incompleteResult.call.result_status, "incomplete"); assert.equal(incompleteResult.call.segment, undefined);
  await appendFile(partial, "\n");
  assert.deepEqual((await inspect({ session_path: partial, cursor: p1.cursor })).items.map(x => x.call_id), ["tail"]);
  const broken = join(root, "broken.jsonl");
  await writeFile(broken, Buffer.concat([Buffer.from(header("broken") + "{bad}\n".repeat(100)), Buffer.from('{"x":"'), Buffer.from([255]), Buffer.from('"}\n'), Buffer.from(call("valid"))]));
  const damaged = await inspect({ session_path: broken });
  assert.equal(damaged.total_diagnostics_count, 101); assert.equal(damaged.diagnostics_truncated, true); assert.equal(damaged.items[0].result_status, "incomplete");
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
  const ambiguous = await inspect({ session_path: duplicates, tool_call_id: "same" });
  assert.equal(ambiguous.status, "ambiguous"); assert.equal(ambiguous.total_candidates_count, 2);
  for (const [index, expected] of [[0, "branch-a"], [1, "branch-b"]]) {
    const chosen = await inspect({ session_path: duplicates, tool_call_id: "same", disambiguation_index: index });
    assert.equal(JSON.parse(chosen.call.segment.text).content, expected);
  }
  assert.equal((await inspect({ session_path: duplicates })).total_calls_inspected, 2);
  await appendFile(duplicates, result("same", "a", "second-a"));
  const multi = await inspect({ session_path: duplicates, tool_call_id: "same", entry_id: "a" });
  assert.equal(multi.call.result_status, "ambiguous"); assert.equal(multi.call.result_candidates_count, 2);
  assert.equal(JSON.parse((await inspect({ session_path: duplicates, tool_call_id: "same", entry_id: "a", result_index: 1 })).call.segment.text).content, "second-a");
  assert.equal((await inspect({ session_path: duplicates, since_timestamp: "2026-09-21T18:00:00" })).error.code, "LARVA_BAD_INPUT");
  await writeFile(utf8, header("filter") + call("old", ["old"], { timestamp: "2026-09-21T17:00:00Z" }) + result("old", "old", "later"));
  assert.equal((await inspect({ session_path: utf8, since_timestamp: stamp })).items[0].matched_by, "result_timestamp");
  const unknown = join(root, "ambiguous-association.jsonl");
  await writeFile(unknown, header("unknown") + call("same-entry", ["duplicate", "duplicate"]));
  const beforeUnknown = await inspect({ session_path: unknown });
  await appendFile(unknown, result("duplicate", "same-entry", "recorded but cannot assign to one sibling"));
  const unknownUpdates = await inspect({ session_path: unknown, cursor: beforeUnknown.cursor });
  assert.equal(unknownUpdates.items.length, 2);
  assert.ok(unknownUpdates.items.every(x => x.result_status === "ambiguous" && x.result_association === "ambiguous"));
  const unknownDetail = await inspect({ session_path: unknown, tool_call_id: "duplicate", disambiguation_index: 0, result_index: 0 });
  assert.equal(unknownDetail.call.result_status, "ambiguous");
  assert.equal(JSON.parse(unknownDetail.call.segment.text).content, "recorded but cannot assign to one sibling");
  const fifo = join(root, "accidental-fifo.jsonl");
  assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
  assert.equal((await inspect({ session_path: fifo })).error.code, "LARVA_SESSION_INVALID");
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
    assert.equal(first.status, 'success'); assert.equal(first.total_calls_inspected, 100000); assert.equal(first.items.length, 5);
    const quiet = JSON.parse((await larva_subagent_activity({ session_path: ${JSON.stringify(stress)}, cursor: first.cursor })).content[0].text);
    assert.equal(quiet.status, 'success'); assert.equal(quiet.items.length, 0);
    console.log(JSON.stringify({ calls: first.total_calls_inspected, heap_limit_MiB: 64, maxRSS: process.resourceUsage().maxRSS }));
  `], { encoding: "utf8", timeout: 120000 });
  assert.equal(probe.status, 0, probe.stderr);
  console.log(`bounded retained-memory stress: ${probe.stdout.trim()}`);
  console.log(`in-flight cancellation, file neutrality, metadata/error bound; max whole response=${maxBytes}`);
} finally { await rm(root, { recursive: true, force: true }); }
