import "../../scripts/pi-test-child-loader.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { appendFile, copyFile, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { Input } from "@earendil-works/pi-tui";

const mod = await import(pathToFileURL(join(process.cwd(), "contrib/pi-extension/larva.ts")).href + `?test=${Date.now()}`);
const dir = await mkdtemp(join(tmpdir(), "larva-timeline-"));
const originalReadFileSync = fs.readFileSync, originalParse = JSON.parse;
let parentSessionReads = 0, parentSessionParses = 0;
const sessionFiles = new Set();
fs.readFileSync = (...args) => { if (typeof args[0] === "string" && sessionFiles.has(args[0])) parentSessionReads++; return originalReadFileSync(...args); };
syncBuiltinESMExports();
JSON.parse = (...args) => { if (typeof args[0] === "string" && args[0].includes('"user-huge"')) parentSessionParses++; return originalParse(...args); };
const entry = (id) => mod.subagentPresentationLogForTests().find((row) => row.task_id === id);
const assistants = (id) => entry(id)?.timeline_events?.filter((row) => row.kind === "assistant") ?? [];
const header = (id) => JSON.stringify({ type: "session", version: 3, id }) + "\n";
const line = (id, text, toolCallIds = []) => JSON.stringify({ type: "message", id, message: { role: "assistant", content: [{ type: "text", text }, ...toolCallIds.map((toolId) => ({ type: "toolCall", id: toolId, name: "read", arguments: {} }))] } }) + "\n";
async function until(predicate, label, ms = 20000) {
  const end = performance.now() + ms;
  while (!predicate()) {
    if (performance.now() > end) throw new Error(`timeout waiting for ${label}: ${JSON.stringify(mod.sessionTimelineReaderMetricsForTests())}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}
try {
  mod.resetSubagentPresentationStateForTests();
  const first = join(dir, "first.jsonl"), second = join(dir, "second.jsonl"), small = join(dir, "small.jsonl");
  sessionFiles.add(first); sessionFiles.add(second); sessionFiles.add(small);
  // A single large persisted record makes JSON.parse itself uninterruptible on
  // the parent, even if the parent used async readFile. Both files are realistic
  // 20-30 MiB session inputs, read in fair slices by the Worker.
  const huge = JSON.stringify({ type: "message", id: "user-huge", message: { role: "user", content: [{ type: "text", text: "z".repeat(23 * 1024 * 1024) }] } }) + "\n";
  await Promise.all([writeFile(first, header("first") + huge + line("a", "same") + line("b", "same") + line("a", "duplicate id ignored")), writeFile(second, header("second") + huge + line("c", "second file")), writeFile(small, header("small") + line("small", "fair slice"))]);
  const input = new Input();
  input.focused = true;
  let worstTimerMs = 0, worstEchoMs = 0, echoCount = 0;
  let previous = performance.now();
  const tick = () => {
    const now = performance.now();
    worstTimerMs = Math.max(worstTimerMs, now - previous - 5);
    previous = now;
    const before = performance.now();
    input.handleInput("x");
    assert.ok(input.render(80).join("").includes(input.getValue().slice(-1)));
    worstEchoMs = Math.max(worstEchoMs, performance.now() - before);
    echoCount++;
  };
  mod.recordSubagentPresentationEntryForTests(first, "test", "running");
  mod.recordSubagentPresentationEntryForTests(second, "test", "running");
  mod.recordSubagentPresentationEntryForTests(small, "test", "running");
  const highRateStart = performance.now();
  for (let n = 0; n < 2500; n++) mod.applySubagentStreamEventForTests(first, { kind: "assistant_delta", text: "p" });
  const highRateMs = performance.now() - highRateStart;
  assert.equal(assistants(first).length, 0, "RPC text must stay out of Timeline");
  assert.equal(parentSessionReads, 0, "stream path must not synchronously read session files on parent");
  assert.equal(parentSessionParses, 0, "stream path must not parse session records on parent");
  mod.applySubagentStreamEventForTests(first, { kind: "assistant_delta", text: '{"path":"secret"}', tool_argument: true });
  assert.ok(!entry(first).live_assistant_preview.includes("secret"), "tool arguments must stay out of assistant preview");
  previous = performance.now();
  const ticker = setInterval(tick, 5);
  await until(() => assistants(small).length === 1, "small task fair slice");
  assert.equal(assistants(first).length, 0, "small task must not wait for huge record on another task");
  await until(() => assistants(first).length === 2 && assistants(second).length === 1 && mod.sessionTimelineReaderMetricsForTests().inFlight === 0, "two catch-ups");
  clearInterval(ticker);
  assert.equal(input.getValue().length, echoCount);
  assert.deepEqual(assistants(first).map((row) => row.text), ["same", "same"]);
  assert.ok(entry(first).live_assistant_preview.length <= 4000);
  const initial = mod.sessionTimelineReaderMetricsForTests();
  assert.ok(initial.bytes >= 46 * 1024 * 1024 && initial.bytes < 48 * 1024 * 1024);
  mod.applySubagentStreamEventForTests(first, { kind: "message_boundary" });
  await until(() => mod.sessionTimelineReaderMetricsForTests().inFlight === 0, "unchanged scan");
  assert.deepEqual(mod.sessionTimelineReaderMetricsForTests().bytes, initial.bytes, "no reread of unchanged file");
  assert.deepEqual(mod.sessionTimelineReaderMetricsForTests().records, initial.records, "no reparse of unchanged file");

  const utf8 = Buffer.from(line("utf", "a\n雪❄️"));
  const split = utf8.indexOf(Buffer.from("雪")) + 1;
  await appendFile(first, utf8.subarray(0, split));
  mod.applySubagentStreamEventForTests(first, { kind: "message_boundary" });
  await until(() => mod.sessionTimelineReaderMetricsForTests().inFlight === 0, "partial scan");
  assert.equal(assistants(first).length, 2);
  await appendFile(first, utf8.subarray(split));
  mod.applySubagentStreamEventForTests(first, { kind: "message_boundary" });
  await until(() => assistants(first).length === 3, "UTF-8 completion");
  assert.ok(assistants(first).at(-1).text.includes("雪❄️"));
  const appendedBytes = mod.sessionTimelineReaderMetricsForTests().bytes - initial.bytes;
  assert.ok(appendedBytes < 4096, "append work proportional to increment");

  await appendFile(first, line("tool-msg", "before completed tool", ["tool-1"]));
  mod.applySubagentStreamEventForTests(first, { kind: "tool", toolCallId: "tool-1", name: "read", status: "running" });
  mod.applySubagentStreamEventForTests(first, { kind: "tool", toolCallId: "tool-1", name: "read", status: "success" });
  await until(() => assistants(first).some((row) => row.text === "before completed tool"), "delayed backfill");
  const timeline = entry(first).timeline_events;
  assert.ok(timeline.findIndex((row) => row.text === "before completed tool") < timeline.findIndex((row) => row.kind === "tool" && row.toolCallId === "tool-1"));
  assert.equal(timeline.find((row) => row.kind === "tool" && row.toolCallId === "tool-1").snapshot.status, "success");
  assert.ok(assistants(first).find((row) => row.text === "same")?.placement === "historical");
  await appendFile(first, line("future-msg", "before future tool", ["future-tool"]));
  mod.applySubagentStreamEventForTests(first, { kind: "message_boundary" });
  await until(() => assistants(first).some((row) => row.text === "before future tool"), "persisted assistant before RPC tool");
  mod.applySubagentStreamEventForTests(first, { kind: "tool", toolCallId: "future-tool", name: "read", status: "running" });
  const futureTimeline = entry(first).timeline_events;
  assert.equal(futureTimeline.find((row) => row.text === "before future tool").placement, "anchored");
  assert.ok(futureTimeline.findIndex((row) => row.text === "before future tool") < futureTimeline.findIndex((row) => row.kind === "tool" && row.toolCallId === "future-tool"));

  const twoTurns = join(dir, "two-turns.jsonl");
  await writeFile(twoTurns, header("two-turns") + line("turn-a", "turn A", ["call-a"]) + line("turn-b", "turn B", ["call-b"]) + line("turn-c", "final C"));
  mod.recordSubagentPresentationEntryForTests(twoTurns, "test", "running");
  for (const id of ["call-a", "call-b"]) mod.applySubagentStreamEventForTests(twoTurns, { kind: "tool", toolCallId: id, name: "read", status: "success" });
  await until(() => assistants(twoTurns).length === 3, "two-turn delayed backfill");
  mod.finishSubagentPresentationForTests(twoTurns);
  const twoTurnEvents = entry(twoTurns).timeline_events;
  assert.deepEqual(twoTurnEvents.map((item) => item.kind === "assistant" ? item.text : item.kind === "tool" ? item.toolCallId : item.kind), ["turn A", "call-a", "turn B", "call-b", "final C", "terminal"]);
  const renderedTurns = mod.renderSubagentPresentationOverlayForTests({ task_id: twoTurns, expanded: true });
  assert.ok(renderedTurns.includes("session excerpt · tool order unknown"), renderedTurns.slice(0, 2400));
  assert.ok(renderedTurns.indexOf("turn A") < renderedTurns.indexOf("turn B") && renderedTurns.indexOf("turn B") < renderedTurns.indexOf("final C"), "rendered assistant order must agree with persisted session order");

  const overPreviousLimit = join(dir, "large-valid-assistant.jsonl");
  sessionFiles.add(overPreviousLimit);
  await writeFile(overPreviousLimit, header("large-valid") + line("large-text", "huge valid excerpt " + "z".repeat(65 * 1024 * 1024)));
  mod.recordSubagentPresentationEntryForTests(overPreviousLimit, "test", "running");
  await until(() => assistants(overPreviousLimit).length === 1, "valid record larger than the former 64 MiB limit");
  assert.ok(assistants(overPreviousLimit)[0].text.startsWith("huge valid excerpt"));
  assert.ok(!entry(overPreviousLimit).presentation_diagnostic?.includes("oversized"));
  const invalidHeader = join(dir, "invalid-header.jsonl");
  await writeFile(invalidHeader, "{}\n" + line("unbound", "must not attach without session identity"));
  mod.recordSubagentPresentationEntryForTests(invalidHeader, "test", "running");
  mod.applySubagentStreamEventForTests(invalidHeader, { kind: "assistant_delta", text: "preview intact" });
  await until(() => entry(invalidHeader).presentation_diagnostic?.includes("session header"), "invalid session identity diagnostic");
  assert.equal(assistants(invalidHeader).length, 0);
  assert.ok(entry(invalidHeader).live_assistant_preview.includes("preview intact"));

  const finalStart = performance.now();
  mod.finishSubagentPresentationForTests(second);
  const finalMs = performance.now() - finalStart;
  assert.ok(finalMs < 100, `terminal UI must not await history: ${finalMs.toFixed(2)}ms`);
  await appendFile(second, line("late", "terminal persistence lag"));
  await until(() => assistants(second).some((row) => row.text === "terminal persistence lag"), "bounded terminal retry");
  assert.equal(entry(second).result_text, "final output");
  assert.equal(entry(second).timeline_events.at(-1).kind, "terminal");

  await appendFile(first, "{malformed\n");
  mod.applySubagentStreamEventForTests(first, { kind: "message_boundary" });
  await until(() => entry(first).presentation_diagnostic?.includes("malformed"), "malformed session diagnostic");
  assert.equal(entry(first).status, "running");

  // Same path, different invocation: pending old results cannot enter new row.
  mod.recordSubagentPresentationEntryForTests(first, "test", "running");
  mod.recordSubagentPresentationEntryForTests(first, "test", "running");
  await until(() => assistants(first).length >= 4, "resume catch-up");
  const replacement = join(dir, "replacement.jsonl");
  await writeFile(replacement, header("replacement") + line("fresh", "replacement only"));
  await rename(replacement, first);
  mod.applySubagentStreamEventForTests(first, { kind: "message_boundary" });
  await until(() => assistants(first).length === 1 && assistants(first)[0].text === "replacement only", "file replacement reset");
  await writeFile(first, header("replacement") + line("short", "truncated only"));
  mod.applySubagentStreamEventForTests(first, { kind: "message_boundary" });
  await until(() => assistants(first).length === 1 && assistants(first)[0].text === "truncated only", "observed truncate reset");
  const failedReplacement = join(dir, "failed-replacement.jsonl");
  await writeFile(failedReplacement, header("after-failed-read") + line("after-failed-read", "new after read failure"));
  mod.failNextSessionTimelineResetReadForTests();
  await rename(failedReplacement, first);
  mod.applySubagentStreamEventForTests(first, { kind: "message_boundary" });
  await until(() => entry(first).presentation_diagnostic?.includes("injected read failure"), "replacement followed by read failure");
  assert.equal(assistants(first).length, 0, "old session excerpts must clear even when replacement read fails");
  assert.equal(entry(first).presentation_session_id, undefined);
  mod.applySubagentStreamEventForTests(first, { kind: "message_boundary" });
  await until(() => assistants(first).length === 1 && assistants(first)[0].text === "new after read failure", "replacement retry after failure");
  assert.equal(entry(first).presentation_session_id, "after-failed-read");

  mod.failSessionTimelineReaderForTests();
  await until(() => entry(first).presentation_diagnostic !== undefined, "reader failure diagnostic");
  mod.applySubagentStreamEventForTests(first, { kind: "message_boundary" });
  await until(() => mod.sessionTimelineReaderMetricsForTests().inFlight === 0, "reader restart");
  assert.equal(assistants(first).length, 1);
  mod.recordSubagentPresentationEntryForTests(second, "test", "running");
  mod.larva_subagent_log({ clear: true });
  await mod.awaitSessionTimelineDisposalForTests();
  assert.equal(mod.subagentPresentationLogForTests().length, 0, "late worker results cannot resurrect cleared rows");
  assert.equal(mod.sessionTimelineReaderMetricsForTests().active, false);
  assert.equal(mod.sessionTimelineReaderMetricsForTests().retiring, false);
  const installed = join(dir, "installed-package");
  await mkdir(installed);
  const source = join(process.cwd(), "contrib/pi-extension");
  for (const name of ["larva.ts", "activity.ts", "session-timeline-worker.mjs", "package.json"]) await copyFile(join(source, name), join(installed, name));
  await symlink(join(source, "node_modules"), join(installed, "node_modules"));
  const copied = await import(pathToFileURL(join(installed, "larva.ts")).href);
  copied.recordSubagentPresentationEntryForTests(first, "test", "running");
  await until(() => copied.subagentPresentationLogForTests().find((row) => row.task_id === first)?.timeline_events?.some((row) => row.kind === "assistant" && row.text === "new after read failure"), "copied package worker executed");
  copied.resetSubagentPresentationStateForTests();
  await copied.awaitSessionTimelineDisposalForTests();

  // UI eviction owns reader lifetime. Forty invocations must leave precisely
  // the twenty-five retained cursors, including in the Worker itself.
  for (let n = 0; n < 40; n++) {
    const file = join(dir, `retained-${n}.jsonl`);
    sessionFiles.add(file);
    await writeFile(file, header(`many-${n}`) + line(`many-${n}`, `row-${n}`));
    mod.recordSubagentPresentationEntryForTests(file, "test", "running");
  }
  const kept = mod.subagentPresentationLogForTests();
  assert.equal(kept.length, 25);
  assert.ok(!kept.some((row) => row.task_id === join(dir, "retained-0.jsonl")));
  await until(() => mod.sessionTimelineReaderMetricsForTests().workerContexts === 25
    && mod.sessionTimelineReaderMetricsForTests().inFlight === 0
    && mod.sessionTimelineReaderMetricsForTests().cursors === 25
    && mod.sessionTimelineReaderMetricsForTests().seen === 25
    && assistants(join(dir, "retained-39.jsonl")).length === 1, "bounded UI and Worker cursor retention");
  const beforeUnchanged = mod.sessionTimelineReaderMetricsForTests().bytes;
  mod.applySubagentStreamEventForTests(join(dir, "retained-15.jsonl"), { kind: "message_boundary" });
  await until(() => mod.sessionTimelineReaderMetricsForTests().inFlight === 0, "retained unchanged cursor");
  assert.equal(mod.sessionTimelineReaderMetricsForTests().bytes, beforeUnchanged, "retained cursor must not rescan after other invocations evict");

  mod.failSessionTimelineReaderForTests();
  mod.larva_subagent_log({ clear: true });
  await mod.awaitSessionTimelineDisposalForTests();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual({ active: mod.sessionTimelineReaderMetricsForTests().active, retiring: mod.sessionTimelineReaderMetricsForTests().retiring, deferred: mod.sessionTimelineReaderMetricsForTests().deferred, cursors: mod.sessionTimelineReaderMetricsForTests().cursors, seen: mod.sessionTimelineReaderMetricsForTests().seen, workerContexts: mod.sessionTimelineReaderMetricsForTests().workerContexts }, { active: false, retiring: false, deferred: 0, cursors: 0, seen: 0, workerContexts: 0 }, "failure retry cannot recreate reader after clear");
  mod.recordSubagentPresentationEntryForTests(first, "test", "running");
  mod.failSessionTimelineReaderForTests();
  await mod.resetExtensionUI("test failure-then-reset");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(mod.sessionTimelineReaderMetricsForTests().active, false, "reset must suppress failure retry");
  assert.equal(mod.sessionTimelineReaderMetricsForTests().retiring, false);
  assert.equal(mod.subagentPresentationLogForTests().length, 0);
  assert.equal(parentSessionReads, 0, "terminal and backfill must not synchronously read sessions on parent");
  assert.equal(parentSessionParses, 0, "terminal and backfill must not parse sessions on parent");

  const replacedAfterFailure = join(dir, "failure-after-replace.jsonl");
  await writeFile(replacedAfterFailure, header("old-id") + line("old-entry", "old text"));
  const reader = new Worker(new URL("./session-timeline-worker.mjs", import.meta.url));
  try {
    const scan = async (testFailAfterReset = false) => {
      const pending = once(reader, "message");
      reader.postMessage({ kind: "scan", path: replacedAfterFailure, invocation: 1, generation: 1, testFailAfterReset });
      return (await pending)[0];
    };
    const before = await scan();
    assert.equal(before.sessionId, "old-id");
    const swapped = join(dir, "swapped-after-failure.jsonl");
    await writeFile(swapped, header("new-id") + line("new-entry", "new text"));
    await rename(swapped, replacedAfterFailure);
    const failure = await scan(true);
    assert.equal(failure.reset, true, "reset must survive post-detection read failure");
    assert.ok(failure.diagnostic.includes("injected read failure"));
    const recovered = await scan();
    assert.equal(recovered.sessionId, "new-id");
    assert.deepEqual(recovered.excerpts.map((item) => item.text), ["new text"]);
  } finally { await reader.terminate(); }

  console.log(JSON.stringify({ status: "PASS", highRateMs: +highRateMs.toFixed(2), finalMs: +finalMs.toFixed(2), inputEchoes: echoCount, worstTimerMs: +worstTimerMs.toFixed(2), worstEchoMs: +worstEchoMs.toFixed(2), readMiB: +(initial.bytes / 1048576).toFixed(2), parsedRecords: initial.records, appendedBytes, parentSessionReads, parentSessionParses }));
} finally {
  fs.readFileSync = originalReadFileSync;
  syncBuiltinESMExports();
  JSON.parse = originalParse;
  mod.resetSubagentPresentationStateForTests();
  await mod.awaitSessionTimelineDisposalForTests();
  await rm(dir, { recursive: true, force: true });
}
