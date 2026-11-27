import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inspectSubagentActivity } from "../../src/activity/inspector.ts";
import type { ActivityQuery, ActivityResponse, ActivitySegment } from "../../src/core/types.ts";

const day = "2026-08-21";
const stamp = `${day}T10:00:00Z`;
const later = `${day}T11:00:00Z`;
const latest = `${day}T12:00:00Z`;
const line = (value: unknown) => JSON.stringify(value) + "\n";
const header = line({ type: "session", id: "child", version: 3 });
const call = (id: string, ids: string[], args: unknown = {}, timestamp = stamp, name = "tool") =>
  line({ type: "message", id, parentId: null, timestamp, message: { role: "assistant",
    content: ids.map(id => ({ type: "toolCall", id, name, arguments: args })) } });
const result = (toolCallId: string, content: string, parentId: string, timestamp = later) =>
  line({ type: "message", id: `result-${toolCallId}-${parentId}`, parentId, timestamp, message: {
    role: "toolResult", toolCallId, toolName: "tool", content, isError: false,
  } });

async function fixture(run: (home: string, path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "larva-activity-"));
  try {
    const home = await realpath(dir);
    const sessions = join(home, "state", "sessions");
    await mkdir(sessions, { recursive: true });
    await run(home, join(sessions, "child.jsonl"));
  } finally { await rm(dir, { recursive: true, force: true }); }
}

async function inspect(home: string, path: string, query: Omit<ActivityQuery, "task_id"> = {}) {
  const response = await inspectSubagentActivity(home, { task_id: path, ...query });
  assert.ok(Buffer.byteLength(JSON.stringify(response), "utf8") <= 8192);
  return response;
}

function listing(value: ActivityResponse) {
  assert.equal(value.status, "success", JSON.stringify(value));
  assert.ok("items" in value);
  return value;
}
function detail(value: ActivityResponse) {
  assert.equal(value.status, "success", JSON.stringify(value));
  assert.ok("call" in value);
  return value.call;
}
function failed(value: ActivityResponse, code: string) {
  assert.equal(value.status, "failed");
  assert.equal(value.error.code, code);
}

test("activity admits only canonical contained task IDs and rejects retired or malformed input", () => fixture(async (home, path) => {
  const outside = join(home, "outside.jsonl");
  const nestedEscape = join(home, "state", "sessions", "nested");
  await writeFile(outside, header + call("secret", ["outside"]));
  await symlink(outside, path);
  await symlink(home, nestedEscape, "dir");
  failed(await inspect(home, path), "LARVA_SESSION_INVALID");
  failed(await inspect(home, join(nestedEscape, "outside.jsonl")), "LARVA_SESSION_INVALID");
  failed(await inspect(home, outside), "LARVA_SESSION_INVALID");
  failed(await inspectSubagentActivity(home, { session_path: outside }), "LARVA_BAD_INPUT");
  failed(await inspectSubagentActivity(home, { task_id: path, session_path: path }), "LARVA_BAD_INPUT");
  failed(await inspectSubagentActivity(home, { task_id: path, limit: null }), "LARVA_BAD_INPUT");
  failed(await inspect(home, path, { since_timestamp: "2026-02-30T00:00:00Z" }), "LARVA_BAD_INPUT");
  await rm(path);
  await writeFile(path, header + call("recorded", ["inside"]));
  const alias = join(home, "alias");
  await symlink(home, alias, "dir");
  assert.deepEqual(listing(await inspect(alias, path)).items.map(x => x.call_id), ["inside"]);
  const linked = join(home, "state", "sessions", "linked.jsonl");
  await symlink(path, linked);
  failed(await inspect(alias, linked), "LARVA_SESSION_INVALID");
  await rm(path);
  failed(await inspect(alias, linked), "LARVA_SESSION_INVALID"); // dangling entry is not absence
  failed(await inspect(alias, path), "LARVA_SESSION_NOT_FOUND");
}));

test("byte-limited cursor drains the frozen window exactly once, then includes newly appended events", () => fixture(async (home, path) => {
  const ids = Array.from({ length: 20 }, (_, index) => `id-${index}`);
  const text = '漢😀"\\\n'.repeat(140);
  await writeFile(path, header + call("entry", ids, { text }) + ids.map(id => result(id, text, "entry")).join(""));
  let page = listing(await inspect(home, path, { limit: 20 }));
  assert.ok(page.has_more && page.items.length > 0 && page.items.length < 20);
  const seen = page.items.map(x => x.call_id);
  await appendFile(path, call("arrived", ["arrival"]));
  for (let i = 0; page.has_more; i++) {
    assert.ok(i < 20);
    page = listing(await inspect(home, path, { cursor: page.cursor, limit: 20 }));
    assert.ok(page.items.length);
    seen.push(...page.items.map(x => x.call_id));
  }
  assert.deepEqual(seen, ids);
  assert.deepEqual(listing(await inspect(home, path, { cursor: page.cursor })).items.map(x => x.call_id), ["arrival"]);
  await writeFile(path, header + call("metadata", ["漢".repeat(4000)]));
  failed(await inspect(home, path), "LARVA_SESSION_INVALID");
}));

test("incremental pages include old-call results and filter inclusively on either endpoint", () => fixture(async (home, path) => {
  await writeFile(path, header + call("old", ["late"]) + call("inside", ["matches-call"], {}, later)
    + call("excluded", ["other"], {}, later, "different"));
  const filter = { tool_name: "tool", since_timestamp: later, until_timestamp: later };
  let page = listing(await inspect(home, path, { ...filter, limit: 1 }));
  assert.deepEqual(page.items.map(x => x.call_id), ["matches-call"]);
  await appendFile(path, call("new", ["new"], {}, later) + result("late", "at-boundary", "old")
    + result("matches-call", "match retained", "inside", latest));
  const cursor = page.cursor;
  failed(await inspect(home, path, { cursor }), "LARVA_BAD_INPUT");
  const updates: [string, string | undefined][] = [];
  do {
    assert.ok(updates.length < 3);
    page = listing(await inspect(home, path, { ...filter, cursor: page.cursor, limit: 1 }));
    updates.push(...page.items.map((item): [string, string | undefined] => [item.call_id, item.result]));
  } while (page.has_more);
  assert.deepEqual(updates, [["new", undefined], ["late", "at-boundary"], ["matches-call", "match retained"]]);
  assert.deepEqual(listing(await inspect(home, path, { ...filter, cursor: page.cursor })).items, []);
}));

test("duplicate call selectors and zero-based result indexes follow recorded ancestry", () => fixture(async (home, path) => {
  await writeFile(path, header + call("branch-a", ["same", "unique"]) + call("branch-b", ["same"])
    + result("same", "first-a", "branch-a") + result("same", "only-b", "branch-b") + result("same", "second-a", "branch-a"));
  const exact = { tool_call_id: "same" };
  const ambiguous = await inspect(home, path, exact);
  assert.equal(ambiguous.status, "ambiguous");
  assert.deepEqual(ambiguous.candidates.map(c => [c.index, c.entry_id]), [[0, "branch-a"], [1, "branch-b"]]);
  const first = detail(await inspect(home, path, { ...exact, entry_id: "branch-a" }));
  assert.equal(first.result_state, "ambiguous");
  assert.equal(first.result_candidates_count, 2);
  assert.equal(first.segment, undefined);
  const selected = detail(await inspect(home, path, { ...exact, disambiguation_index: 0, result_index: 1 }));
  assert.equal(JSON.parse(selected.segment?.text ?? "").content, "second-a");
  assert.equal(selected.selected_result_index, 1);
  const second = detail(await inspect(home, path, { ...exact, disambiguation_index: 1 }));
  assert.equal(second.call_location.entry_id, "branch-b");
  assert.equal(JSON.parse(second.segment?.text ?? "").content, "only-b");
  failed(await inspect(home, path, { ...exact, entry_id: "branch-b", result_index: 1 }), "LARVA_BAD_INPUT");
  await appendFile(path, result("same", "unresolved", "missing-parent"));
  const unresolved = detail(await inspect(home, path, { ...exact, disambiguation_index: 1 }));
  assert.equal(unresolved.result_association, "ambiguous");
  assert.equal(unresolved.unassociated_results_count, 1);
  assert.equal(unresolved.segment, undefined);
}));

test("UTF-16 segments bind exact selections and validate the consumed prefix across append and rewrite", () => fixture(async (home, path) => {
  const content = { value: "😀漢" + '\\"漢😀'.repeat(2000) };
  await writeFile(path, header + call("entry", ["a", "b"], content) + result("a", "result", "entry"));
  const query = { tool_call_id: "a", segment_part: "args" as const };
  const expected = JSON.stringify(content);
  const split = expected.indexOf("😀") + 1;
  const first = detail(await inspect(home, path, { ...query, length: split })).segment;
  assert.ok(first);
  assert.equal(first.offset_units, "UTF-16 code units");
  assert.equal(first.continuation_offset, split);
  assert.equal(first.text.charCodeAt(split - 1), 0xd83d);
  failed(await inspect(home, path, { ...query, offset: split }), "LARVA_BAD_INPUT");
  failed(await inspect(home, path, { ...query, tool_call_id: "b", offset: split, source_version: first.source_version }), "LARVA_BAD_INPUT");
  failed(await inspect(home, path, { ...query, segment_part: "result", offset: split, source_version: first.source_version }), "LARVA_BAD_INPUT");
  await appendFile(path, call("new-entry", ["a"]));
  let text = first.text, offset: number = split;
  while (offset < expected.length) {
    const segment: ActivitySegment | undefined = detail(await inspect(home, path, {
      ...query, offset, length: 4000, source_version: first.source_version,
    })).segment;
    assert.ok(segment && segment.length > 0);
    assert.equal(segment.offset, offset);
    assert.equal(segment.source_version, first.source_version);
    assert.equal(segment.total_chars, expected.length);
    offset += segment.length;
    text += segment.text;
    assert.equal(segment.continuation_offset, segment.has_more ? offset : undefined);
  }
  assert.equal(text, expected);
  const copy = `${path}.replacement`;
  await writeFile(copy, header + call("entry", ["a", "b"], content) + result("a", "result", "entry") + call("new-entry", ["a"]));
  await rename(copy, path);
  failed(await inspect(home, path, { ...query, offset: split, source_version: first.source_version }), "LARVA_SESSION_INVALID");
  const replaced = detail(await inspect(home, path, { ...query, disambiguation_index: 0, length: split })).segment;
  assert.ok(replaced);
  await writeFile(path, header + call("entry", ["a", "b"], { value: content.value.replace("漢", "字") }) + result("a", "result", "entry") + call("new-entry", ["a"]));
  failed(await inspect(home, path, { ...query, disambiguation_index: 0, offset: split, source_version: replaced.source_version }), "LARVA_SESSION_INVALID");
}));

test("compact projection preserves result flags while detail returns the saved result message", () => fixture(async (home, path) => {
  const saved = { role: "toolResult", toolCallId: "mixed", toolName: "tool",
    content: [{ type: "text", text: "first" }, { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
      { type: "text", text: "second" }], details: { count: 2, fullOutputPath: join(home, "not-a-file"), truncation: { truncated: false } },
    isError: false, timestamp: 13 };
  await writeFile(path, header + call("entry", ["mixed"]) + line({ type: "message", id: "saved", parentId: "entry",
    timestamp: later, message: saved }));
  const [summary] = listing(await inspect(home, path)).items;
  assert.equal(summary.result, "first\nsecond");
  assert.equal(summary.result_truncated, true);
  assert.equal(summary.has_image, true);
  assert.equal(summary.has_details, true);
  assert.equal(summary.is_error, false);
  assert.equal(summary.upstream_truncated, false);
  const expanded = detail(await inspect(home, path, { tool_call_id: "mixed" }));
  assert.equal(expanded.result_message_timestamp, 13);
  assert.deepEqual(JSON.parse(expanded.segment?.text ?? ""), saved);
}));

test("an unterminated tail is incomplete until its newline is visible", () => fixture(async (home, path) => {
  await writeFile(path, header + call("visible", ["prior"]) + call("tail", ["pending"]).trimEnd());
  const first = listing(await inspect(home, path));
  assert.equal(first.inspection_complete, false);
  assert.equal(first.items[0].result_state, "incomplete");
  assert.equal((await inspect(home, path, { tool_call_id: "pending" })).status, "partial");
  await appendFile(path, "\n");
  const next = listing(await inspect(home, path, { cursor: first.cursor }));
  assert.deepEqual(next.items.map(x => x.call_id), ["pending"]);
  assert.equal(next.inspection_complete, undefined);
}));
