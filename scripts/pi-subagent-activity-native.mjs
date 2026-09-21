// purpose: exercise activity FR1-9 through the installed-package native Pi loader
// usage: node scripts/pi-subagent-activity-native.mjs
// effects: owned Pi processes, sessions and loopback provider; fixture cleanup
// requires: local locked Pi 0.85.1, Node 26.7+
import assert from "node:assert/strict";
import { writeFile, appendFile, stat, rename, truncate } from "node:fs/promises";
import { join } from "node:path";
import { createNativeFixture, NativeRpc } from "./pi-native-support.mjs";
const f = await createNativeFixture();
const stamp = "2026-09-21T18:00:00Z";
const line = x => JSON.stringify(x) + "\n";
const header = id => line({ type: "session", version: 3, id, timestamp: stamp });
const call = (entry, ids, args = {}, timestamp = stamp) => line({ type: "message", id: entry, parentId: null, timestamp, message: { role: "assistant", content: ids.map(id => ({ type: "toolCall", id, name: "tool", arguments: args })) } });
const result = (id, parentId, content, extra = {}, timestamp = stamp) => line({ type: "message", id: `r-${id}`, parentId, timestamp, message: { role: "toolResult", toolCallId: id, toolName: "tool", content, ...extra } });
let maxBytes = 0, executions = 0, p;
let childHold = false, childRequests = 0;
let childReady;
const childHeld = new Promise(resolve => { childReady = resolve; });
const isChild = payload => JSON.stringify(payload).includes("HOLD_ACTIVITY_NEUTRALITY") && !JSON.stringify(payload).includes("native activity driver");
async function invoke(name, args) {
  let emitted = false;
  const from = f.requests.length;
  f.respond = payload => {
    if (childHold && isChild(payload)) {
      childRequests++;
      if (childRequests === 1) return { tools: [{ name: "bash", args: { command: "printf activity-child" } }] };
      childReady(); return { hold: true };
    }
    if (!emitted) { emitted = true; return { tools: [{ name, args }] }; }
    return { text: "Tool observation finished." };
  };
  const frames = await p.prompt("native activity driver", 30000);
  const end = frames.find(x => x.type === "tool_execution_end" && x.toolName === name);
  assert.ok(end, `native execution missing: ${name}`);
  if (name !== "larva_subagent_activity") return end.result.details;
  executions++;
  const bytes = Buffer.byteLength(JSON.stringify(end.result)); maxBytes = Math.max(maxBytes, bytes);
  assert.ok(bytes <= 8192, `complete native tool result ${bytes} bytes`);
  assert.deepEqual(Object.keys(end.result.details), ["status"]);
  const payload = JSON.parse(end.result.content[0].text);
  // Check the next actual provider request, not only SDK details or the event.
  const delivered = f.requests.slice(from).flatMap(x => x.payload.messages ?? []).filter(x => x.role === "tool");
  assert.ok(delivered.some(x => typeof x.content === "string" && x.content === end.result.content[0].text), "complete activity metadata and segments must reach model context");
  return payload;
}
const activity = args => invoke("larva_subagent_activity", args);
async function drain(path, page, limit = 20) {
  const items = [...page.items];
  for (let i = 0; page.has_more; i++) {
    assert.ok(i < 30, "paging progress");
    page = await activity({ session_path: path, cursor: page.cursor, limit });
    assert.equal(page.status, "success"); assert.ok(page.items.length); items.push(...page.items);
  }
  return { items, cursor: page.cursor };
}
try {
  p = new NativeRpc(f, ["--larva-persona", "ok"]);
  await p.command("get_state");
  assert.ok((await p.snapshot()).value.activeTools.includes("larva_subagent_activity"));
  const path = join(f.cwd, "history.jsonl");
  await writeFile(path, header("native") + call("parallel", ["ok", "error", "absent", "missing"]) + result("ok", "parallel", "ok", { isError: false }) + result("error", "parallel", "error", { isError: true }) + result("absent", "parallel", "no marker"));
  const initial = await activity({ session_path: path });
  assert.equal(initial.items.length, 4); assert.equal(initial.items[0].is_error, false); assert.equal(initial.items[1].is_error, true);
  assert.equal(Object.hasOwn(initial.items[2], "is_error"), false); assert.equal(initial.items[3].result_status, "none");
  assert.equal(initial.items[3].call_location.content_index, 3);
  const schema = f.requests[0].payload.tools.find(x => x.function?.name === "larva_subagent_activity").function.parameters;
  assert.ok(schema.properties.source_version); assert.ok(schema.properties.result_index);
  console.log("FR1/FR9: native registration/schema/execution and model-visible provenance/error/absence");

  await appendFile(path, call("twenty", Array.from({ length: 20 }, (_, i) => `c${i}`)) + result("missing", "parallel", "late outside tail"));
  const updates = await activity({ session_path: path, cursor: initial.cursor, limit: 2 });
  await appendFile(path, call("later", ["between-pages"]));
  const incremental = await drain(path, updates, 2);
  assert.equal(incremental.items.length, 21); assert.equal(new Set(incremental.items.map(x => x.key)).size, 21);
  assert.equal(incremental.items.at(-1).update_type, "late_result");
  assert.deepEqual((await activity({ session_path: path, cursor: incremental.cursor })).items.map(x => x.call_id), ["between-pages"]);
  const recent = await activity({ session_path: path, limit: 20 });
  const recentPages = await drain(path, recent);
  assert.equal(recentPages.items.length, 20); assert.equal(new Set(recentPages.items.map(x => x.key)).size, 20);
  const exact = await activity({ session_path: path, tool_call_id: "ok" });
  assert.equal(JSON.parse(exact.call.segment.text).content, "ok");
  console.log("FR2/FR3: same-record pages, late result outside tail, append-between-pages, exact old ID");

  const large = join(f.cwd, "large.jsonl");
  const big = '漢😀\\\"\n'.repeat(1800), args = { big };
  const saved = { role: "toolResult", toolCallId: "big", toolName: "tool", content: [{ type: "text", text: big }], details: { nested: { n: 73 }, truncated: true, fullOutputPath: "/not-followed" }, isError: false };
  await writeFile(large, header("large") + call("large-call", ["big"], args) + line({ type: "message", id: "large-result", parentId: "large-call", timestamp: stamp, message: saved }));
  for (const part of ["args", "result"]) {
    let rebuilt = "", offset = 0, version;
    for (let i = 0; i < 100; i++) {
      const out = await activity({ session_path: large, tool_call_id: "big", segment_part: part, offset, length: 4000, ...(version ? { source_version: version } : {}) });
      assert.equal(out.status, "success"); const s = out.call.segment;
      assert.equal(s.offset, offset); assert.equal(s.length, s.text.length); assert.ok(s.length > 0);
      rebuilt += s.text; version = s.source_version;
      if (!s.has_more) break;
      assert.equal(s.continuation_offset, offset + s.length); offset = s.continuation_offset;
    }
    assert.equal(rebuilt, JSON.stringify(part === "args" ? args : saved));
  }
  console.log("FR4: entire saved args and structured result reconstructed; Unicode/escaping and source token delivered to provider");

  const partial = join(f.cwd, "partial.jsonl"), tail = call("tail", ["tail"]).trimEnd();
  await writeFile(partial, header("partial") + call("prior", ["prior"]) + tail);
  const pending = await activity({ session_path: partial });
  assert.equal(pending.inspection_complete, false); assert.equal(pending.items.length, 1); assert.equal(pending.items[0].result_status, "incomplete");
  await appendFile(partial, "\n");
  assert.deepEqual((await activity({ session_path: partial, cursor: pending.cursor })).items.map(x => x.call_id), ["tail"]);
  console.log("FR5: complete JSON without newline remained pending; newline completion delivered once");

  const faults = join(f.cwd, "faults.jsonl");
  await writeFile(faults, header("faults") + "{bad}\n".repeat(100));
  const damaged = await activity({ session_path: faults });
  assert.equal(damaged.total_diagnostics_count, 100); assert.equal(damaged.inspection_complete, false); assert.equal(damaged.diagnostics_truncated, true);
  await writeFile(faults, Buffer.concat([Buffer.from(header("utf8") + '{"x":"'), Buffer.from([255]), Buffer.from('"}\n')]));
  assert.equal((await activity({ session_path: faults })).diagnostics[0].kind, "invalid_utf8");
  assert.equal((await activity({ session_path: join(f.cwd, "missing.jsonl") })).error.code, "LARVA_SESSION_NOT_FOUND");
  assert.equal((await activity({ session_path: path, cursor: "bad" })).error.code, "LARVA_CURSOR_INVALID");
  assert.equal((await activity({ session_path: path, cursor: initial.cursor, tool_name: "other" })).error.code, "LARVA_CURSOR_INVALID");
  for (const fault of ["replacement", "shrink", "regrowth"]) {
    await writeFile(faults, header("identity") + call("original", ["original"])); const before = await activity({ session_path: faults });
    if (fault === "replacement") { await rename(faults, `${faults}.old`); await writeFile(faults, header("identity") + call("original", ["original"])); }
    else if (fault === "shrink") await truncate(faults, 5);
    else { await truncate(faults, 0); await appendFile(faults, header("identity") + call("regrown-longer", ["regrown-longer"])); }
    assert.equal((await activity({ session_path: faults, cursor: before.cursor })).error.code, "LARVA_CURSOR_STALE");
  }
  await writeFile(faults, line({ type: "session", version: 99, id: "future" }));
  assert.equal((await activity({ session_path: faults })).error.code, "LARVA_SESSION_INVALID");
  console.log("FR6: bounded diagnostics/UTF-8, missing/invalid/filter-mismatched cursor, replacement/shrink/regrowth/unsupported version");

  const branches = join(f.cwd, "branches.jsonl");
  await writeFile(branches, header("branches") + call("a", ["same"], {}, "2026-09-21T17:00:00Z") + call("b", ["same"]) + result("same", "a", "branch-a") + result("same", "b", "branch-b") + line({ type: "compaction", retainedTail: [{ role: "assistant", content: [{ type: "toolCall", id: "copied", name: "tool", arguments: {} }] }] }));
  assert.equal((await activity({ session_path: branches })).total_calls_inspected, 2);
  assert.equal((await activity({ session_path: branches, tool_call_id: "same" })).status, "ambiguous");
  assert.equal(JSON.parse((await activity({ session_path: branches, tool_call_id: "same", disambiguation_index: 0 })).call.segment.text).content, "branch-a");
  const filtered = await activity({ session_path: branches, since_timestamp: stamp });
  assert.equal(filtered.items[0].matched_by, "result_timestamp");
  console.log("native duplicate-ID branch selection, result-time filters and compaction deduplication");

  // Process one is gone; process two has no registry knowledge of this file.
  await p.stop(); p = new NativeRpc(f, ["--larva-persona", "ok"]); await p.command("get_state");
  await appendFile(path, call("new-parent", ["new-parent"]));
  const continued = await activity({ session_path: path, cursor: recentPages.cursor });
  assert.deepEqual(continued.items.map(x => x.call_id), ["new-parent"]);
  console.log("FR7: cursor continued in a fresh native parent with an empty registry");

  // Real accepted child + real 120s watchdog. At ~65s an activity read must not
  // restore waiting_for_child or reset the 120s deadline. Callback delivery then
  // occurs once through the native message_end/customType surface.
  childHold = true;
  const started = Date.now();
  const receipt = await invoke("larva_subagent", { persona_id: "child", task: "HOLD_ACTIVITY_NEUTRALITY", no_progress_timeout_ms: 120000 });
  assert.equal(receipt.status, "accepted"); const task = receipt.task_id;
  let readyTimer;
  try { await Promise.race([childHeld, new Promise((_, reject) => { readyTimer = setTimeout(() => reject(new Error("Child did not reach held request after recording a tool result")), 15000); })]); }
  finally { clearTimeout(readyTimer); }
  assert.equal((await f.inspect()).liveChildren.length, 1);
  const statusBefore = await invoke("larva_subagent_status", { task_id: task });
  assert.equal(statusBefore.runs[0].result_pending, true); assert.equal(statusBefore.runs[0].callback_delivery, "pending");
  const targetBefore = await stat(task);
  const readLive = await activity({ session_path: task }); assert.equal(readLive.status, "success");
  const targetAfter = await stat(task);
  assert.equal(targetBefore.mtimeMs, targetAfter.mtimeMs); assert.equal(targetBefore.size, targetAfter.size);
  const eventsBefore = await invoke("larva_subagent_events", { task_ids: [task] });
  await activity({ session_path: task });
  const eventsAfter = await invoke("larva_subagent_events", { task_ids: [task] });
  assert.deepEqual(eventsAfter.events, eventsBefore.events, "reader cannot touch lifecycle event history");
  await new Promise(resolve => setTimeout(resolve, Math.max(0, 65000 - (Date.now() - started))));
  const stalled = await invoke("larva_subagent_status", { task_id: task });
  assert.equal(stalled.runs[0].phase, "stall_suspected");
  await activity({ session_path: task });
  const stillStalled = await invoke("larva_subagent_status", { task_id: task });
  assert.equal(stillStalled.runs[0].phase, "stall_suspected"); assert.equal(stillStalled.runs[0].callback_delivery, "pending");
  const callbacks = frames => frames.filter(x => x.type === "message_end" && x.message?.customType === "larva-subagent-result" && x.message.details?.task_id === task);
  assert.equal(callbacks(p.frames).length, 0);
  const callback = await p.until(frames => callbacks(frames)[0], 85000);
  assert.equal(callback.message.details.status, "cancelled");
  const elapsed = Date.now() - started; assert.ok(elapsed >= 120000 && elapsed < 150000, `watchdog elapsed ${elapsed}`);
  await p.until(frames => frames.slice(frames.indexOf(callback)).some(x => x.type === "agent_settled"));
  await activity({ session_path: task });
  assert.equal(callbacks(p.frames).length, 1, "activity cannot consume/replay delivered callback");
  assert.equal((await f.inspect()).liveChildren.length, 0);
  console.log(`FR8: live/pending and stall_suspected reads preserved events/phase/files; real watchdog fired at ${elapsed}ms; one native callback`);
  await p.stop();
  assert.deepEqual(f.errors, []);
  console.log(`native activity: ${executions} registered executions; maximum whole-response bytes=${maxBytes}`);
} finally {
  const cleanup = await f.close();
  assert.ok(cleanup.parents.every(x => !x.alive)); assert.equal(cleanup.providerClosed, true); assert.equal(cleanup.rootRemoved, true);
  console.log(`native owned parents/provider/fixtures reconciled and removed; child provider requests=${childRequests}`);
}
