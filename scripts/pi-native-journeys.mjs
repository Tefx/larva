// purpose: native loader/SDK/provider/session journeys for acceptance, without test loader
// usage: node scripts/pi-native-journeys.mjs --scenario state|children|invocation|environment|tui
// effects: disposable Pi processes, sessions, loopback provider and scoped tool fixtures
// requires: locked local native Pi 0.85.1; environment/tui also Python 3.12
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, stat, copyFile, symlink, utimes, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, CLI, CONTROL, createNativeFixture, NativeRpc, jsonLines, directory, alive, execute } from "./pi-native-support.mjs";
const text = (payload) => payload.messages?.map((m) => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n") ?? "";
const toolResults = (frames, name) => frames.filter((f) => f.type === "tool_execution_end" && f.toolName === name).map((f) => f.result?.details ?? f.result);
const commits = (snapshot) => snapshot.value.entries.filter((e) => e.customType === "larva-active-persona-commit");
async function waitObservation(f, event, predicate = () => true, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const row = (await jsonLines(join(f.root, "observations.jsonl"))).find((r) => r.event === event && predicate(r.value));
    if (row) return row;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Missing actual observation: ${event}`);
}
async function cleanChildren(f) {
  const deadline = Date.now() + 5000;
  let result;
  do {
    result = await f.inspect();
    if (!result.liveChildren.length && !result.capsules.length) return result;
    await new Promise((r) => setTimeout(r, 25));
  } while (Date.now() < deadline);
  assert.deepEqual({ live: result.liveChildren, capsules: result.capsules }, { live: [], capsules: [] });
}
async function runState(f, evidence) {
  const p = new NativeRpc(f, ["--larva-persona", "ok"]);
  let state = await p.command("get_state");
  assert.equal(state.model.id, "persona"); assert.equal(state.thinkingLevel, "medium");
  await p.prompt("persist actual history");
  const initial = await p.snapshot();
  assert.equal(commits(initial).length, 1);
  await p.command("prompt", { message: "/audit-model manual high" });
  await p.command("prompt", { message: "/larva-mode auto" });
  const before = await p.snapshot();
  await p.stop();
  const resumed = new NativeRpc(f, ["--session", before.value.session, "--larva-persona", "ok"]);
  state = await resumed.command("get_state");
  assert.equal(state.model.id, "manual"); assert.equal(state.thinkingLevel, "high");
  const reopened = await resumed.snapshot();
  assert.equal(commits(reopened).length, 1);
  evidence.restore = { model: state.model.id, thinking: state.thinkingLevel, commits: commits(reopened).length, session: before.value.session };
  // Native reload, including newly loaded extension instances, must keep manual choices.
  await resumed.command("prompt", { message: "/audit-reload" });
  const reloaded = await resumed.snapshot();
  assert.equal(reloaded.value.model.id, "manual"); assert.equal(reloaded.value.thinking, "high");
  assert.equal(commits(reloaded).length, 1);
  // A temporary borrow without a UI response distinguishes restored auto mode
  // from fresh confirm/manual and persistent free mode, before any mode write.
  let first = true;
  f.respond = () => first ? (first = false, { tools: [{ name: "larva_persona_switch", args: { persona_id: "child", reason: "Native lease observation", continue_task: false } }] }) : { text: "Borrowed turn ended." };
  const frames = await resumed.prompt("borrow for this turn");
  const switched = toolResults(frames, "larva_persona_switch");
  assert.equal(switched[0]?.committed, true, JSON.stringify(switched));
  const restored = await resumed.snapshot();
  assert.equal(restored.value.model.id, "manual"); assert.equal(restored.value.thinking, "high");
  assert.equal(commits(restored).at(-1).data.persona_id, "ok", "temporary borrow must not persist the borrowed persona as primary identity");
  assert.ok(switched[0].lease);
  evidence.restore.mode = "auto";
  evidence.borrow = { result: switched[0], restored: { model: restored.value.model.id, thinking: restored.value.thinking } };
  evidence.policyDenials = [];
  for (const [mode, code] of [["manual", "Tool larva_persona_switch not found"], ["confirm", "LARVA_CONFIRMATION_UNAVAILABLE"]]) {
    await resumed.command("prompt", { message: `/larva-mode ${mode}` });
    let send = true;
    f.respond = () => send ? (send = false, { tools: [{ name: "larva_persona_switch", args: { persona_id: "child", reason: "Native denial observation", continue_task: false } }] }) : { text: "Observed denial." };
    const frames = await resumed.prompt(`Attempt ${mode} switch`);
    const denied = frames.find((r) => r.type === "tool_execution_end" && r.toolName === "larva_persona_switch");
    assert.ok(JSON.stringify(denied).includes(code), JSON.stringify(denied));
    const state = await resumed.command("get_state");
    assert.equal(state.model.id, "manual"); assert.equal(state.thinkingLevel, "high");
    evidence.policyDenials.push({ mode, result: denied });
  }
  await resumed.command("prompt", { message: "/larva-mode auto" });
  let continueSwitch = true;
  const continuationFrom = resumed.frames.length;
  const requestFrom = f.requests.length;
  f.respond = () => continueSwitch ? (continueSwitch = false, { tools: [{ name: "larva_persona_switch", args: { persona_id: "child", reason: "Native continuation boundary", continue_task: true } }] }) : { text: "Native borrowed continuation finished." };
  await resumed.prompt("Borrow and continue");
  await resumed.until((frames) => frames.slice(continuationFrom).filter((r) => r.type === "agent_settled").length >= 2);
  const continuation = f.requests.slice(requestFrom).find((r) => text(r.payload).includes("You are fake persona child."));
  assert.ok(continuation, "continuation must execute with the borrowed persona prompt");
  const afterContinuation = await resumed.command("get_state");
  assert.equal(afterContinuation.model.id, "manual"); assert.equal(afterContinuation.thinkingLevel, "high");
  evidence.continuation = { request: continuation, restored: { model: afterContinuation.model.id, thinking: afterContinuation.thinkingLevel } };
  await resumed.command("prompt", { message: "/larva-mode free" });
  let freeSwitch = true;
  f.respond = () => freeSwitch ? (freeSwitch = false, { tools: [{ name: "larva_persona_switch", args: { persona_id: "child", reason: "Native free-mode observation", continue_task: false } }] }) : { text: "Persistent switch finished." };
  await resumed.prompt("Switch persistently in free mode");
  const free = await resumed.snapshot();
  assert.equal(commits(free).at(-1).data.persona_id, "child");
  assert.equal(free.value.model.id, "persona");
  evidence.free = { model: free.value.model.id, lastCommit: commits(free).at(-1) };
  await resumed.command("prompt", { message: "/larva-persona ok" });
  await resumed.command("prompt", { message: "/audit-model manual high" });
  f.respond = () => ({ text: "native lifecycle turn" });
  await resumed.command("prompt", { message: "/audit-fork" });
  const forked = await resumed.snapshot();
  assert.notEqual(forked.value.session, before.value.session);
  assert.equal(forked.value.model.id, "manual");
  evidence.fork = { distinctSession: true, model: forked.value.model.id, commits: commits(forked).length };
  await resumed.command("prompt", { message: "/audit-new" });
  const fresh = await resumed.snapshot();
  assert.notEqual(fresh.value.session, forked.value.session);
  evidence.newSession = { model: fresh.value.model.id, commits: commits(fresh).length };
  const profileRoot = join(f.home, ".pi/larva");
  await mkdir(profileRoot, { recursive: true });
  await writeFile(join(profileRoot, "model-map.alternate.json"), JSON.stringify({ models: { "openai/gpt-5.5": { provider: "native-loopback", model_id: "profile" } }, prefix_rules: [] }));
  await resumed.command("prompt", { message: "/larva-model-map alternate" });
  const profiled = await resumed.command("get_state");
  assert.equal(profiled.model.id, "profile"); assert.equal(profiled.thinkingLevel, "medium");
  evidence.profile = { model: profiled.model.id, thinking: profiled.thinkingLevel };
  // Main preferences remain the actual Pi settings file, with no exit rollback.
  const globals = JSON.parse(await readFile(join(f.agent, "settings.json"), "utf8"));
  for (const key of ["defaultProvider", "defaultModel", "defaultThinkingLevel"]) assert.equal(globals[key], f.settings[key]);
  evidence.globalDefaults = Object.fromEntries(["defaultProvider", "defaultModel", "defaultThinkingLevel"].map((k) => [k, globals[k]]));
  await resumed.stop();
}
async function startTask(f, p, task, taskId, extra = {}) {
  let emitted = false;
  f.respond = (payload) => {
    // The real child request is recognized by its task. Do not manufacture a receipt.
    if (text(payload).includes(task) && !text(payload).includes("native-driver-start")) return task.startsWith("HOLD_") ? { hold: true } : task.startsWith("ERROR_") ? { error: true } : { text: task.startsWith("LARGE_") ? "Native oversized output.\n".repeat(12000) : "Native child completed." };
    if (!emitted) { emitted = true; return { tools: [{ name: "larva_subagent", args: { persona_id: "child", task, ...extra, ...(taskId ? { task_id: taskId } : {}) } }] }; }
    return { text: "Parent continuation." };
  };
  const from = p.frames.length;
  await p.command("prompt", { message: "native-driver-start" });
  await p.until((frames) => toolResults(frames.slice(from), "larva_subagent")[0], 20000);
  const receipt = toolResults(p.frames.slice(from), "larva_subagent")[0];
  assert.equal(receipt.status, "accepted", JSON.stringify(receipt));
  assert.equal(receipt.result_pending, true);
  return { receipt, from };
}
async function waitCallback(p, from, taskId, timeout = 20000) {
  const callback = await p.until((frames) => frames.slice(from).find((f) => f.type === "message_end" && f.message?.customType === "larva-subagent-result" && f.message.details?.task_id === taskId), timeout);
  await p.until((frames) => frames.slice(frames.indexOf(callback)).find((f) => f.type === "agent_settled"), 15000);
  return callback.message.details;
}
async function runChildren(f, evidence) {
  const p = new NativeRpc(f, ["--larva-persona", "ok"]);
  const initial = await p.command("get_state");
  const first = await startTask(f, p, "FIRST_NATIVE_CHILD");
  const callback = await waitCallback(p, first.from, first.receipt.task_id);
  assert.equal(callback.status, "success");
  const after = await cleanChildren(f);
  assert.ok(after.sessions.includes(first.receipt.task_id.split("/").at(-1)));
  const resumed = await startTask(f, p, "RESUMED_NATIVE_CHILD", first.receipt.task_id);
  const secondCallback = await waitCallback(p, resumed.from, first.receipt.task_id);
  assert.equal(secondCallback.status, "success");
  await cleanChildren(f);
  const history = await readFile(first.receipt.task_id, "utf8");
  assert.ok(history.includes("FIRST_NATIVE_CHILD") && history.includes("RESUMED_NATIVE_CHILD"));
  const observed = await jsonLines(join(f.root, "children.jsonl"));
  const beforePrompts = observed.filter((r) => r.event === "before_prompt");
  assert.equal(new Set(beforePrompts.map((r) => r.pid)).size, 2);
  for (const row of beforePrompts) {
    assert.equal(row.mode, "rpc"); assert.equal(row.frame?.capability, "larva-child-rpc-frame-preload-v1"); assert.equal(row.frame.configured, true);
    assert.equal(row.modeDirectory, 0o700); assert.equal(row.modeSettings, 0o600);
    assert.equal(row.base, f.agent); assert.ok(row.argv.includes("--no-extensions"));
    assert.equal(row.model.id, "persona"); assert.equal(row.thinking, "high"); // xhigh clamped by native model capability
    assert.equal(row.settings.defaultModel, "origin");
    assert.ok(!row.activeTools.includes("audit-snapshot"));
  }
  const final = await p.command("get_state");
  assert.equal(final.model.id, initial.model.id); assert.equal(final.thinkingLevel, initial.thinkingLevel);
  evidence.newResume = { receipts: [first.receipt, resumed.receipt], callbacks: [callback, secondCallback], children: beforePrompts, historySurvives: true, parentModel: final.model.id, parentThinking: final.thinkingLevel };
  const large = await startTask(f, p, "LARGE_NATIVE_CHILD");
  const largeCallback = await waitCallback(p, large.from, large.receipt.task_id);
  assert.equal(largeCallback.status, "success"); assert.equal(largeCallback.delivery_status, "artifactized");
  await cleanChildren(f);
  const manifest = largeCallback.full_output_artifact;
  const output = await readFile(manifest.path);
  assert.equal(output.length, manifest.bytes);
  assert.equal(createHash("sha256").update(output).digest("hex"), manifest.sha256.replace(/^sha256:/, ""));
  assert.ok(output.toString().includes("Native oversized output."));
  evidence.oversized = { receipt: large.receipt, callback: largeCallback, artifactSurvivesCapsuleCleanup: true, manifestVerified: true };
  // A live accepted native child is still in a held provider request at shutdown.
  const held = await startTask(f, p, "HOLD_NATIVE_CHILD");
  await p.until((frames) => frames.slice(held.from).some((f) => f.type === "agent_settled"));
  const during = await f.inspect();
  assert.equal(during.liveChildren.length, 1); assert.equal(during.capsules.length, 1);
  const heldRequest = (r) => text(r.payload).includes("HOLD_NATIVE_CHILD") && !text(r.payload).includes("native-driver-start");
  if (!f.requests.some(heldRequest)) await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { f.requestEvents.off("request", onRequest); reject(new Error("Accepted child never reached held provider request")); }, 5000);
    const onRequest = (row) => { if (heldRequest(row)) { clearTimeout(timer); f.requestEvents.off("request", onRequest); resolve(); } };
    f.requestEvents.on("request", onRequest);
  });
  let observing = true;
  const handle = held.receipt.task_id;
  f.respond = () => observing ? (observing = false, { tools: [
    { name: "larva_subagent_status", args: { task_id: handle } },
    { name: "larva_subagent_events", args: { task_ids: [handle] } },
    { name: "larva_subagent_wait", args: { task_ids: [handle], return_when: "all", timeout_ms: 0 } },
    { name: "larva_subagent_select", args: { task_ids: [handle], timeout_ms: 0 } },
  ] }) : { text: "Readiness observation completed." };
  const observationFrames = await p.prompt("Observe the exact held child handle");
  const status = toolResults(observationFrames, "larva_subagent_status")[0];
  const events = toolResults(observationFrames, "larva_subagent_events")[0];
  assert.equal(status.runs[0].task_id, handle); assert.equal(status.runs[0].result_pending, true);
  assert.ok(events.events.some((r) => r.task_id === handle));
  const readiness = ["larva_subagent_wait", "larva_subagent_select"].map((name) => toolResults(observationFrames, name)[0]);
  for (const result of readiness) { assert.equal(result.satisfied, false); assert.deepEqual(result.pending_task_ids, [handle]); assert.deepEqual(result.ready_task_ids, []); }
  evidence.readiness = { status, events, readiness };
  const concurrent = await startTask(f, p, "HOLD_NATIVE_SECOND_CHILD");
  await p.until((frames) => frames.slice(concurrent.from).some((r) => r.type === "agent_settled"));
  const two = await f.inspect();
  assert.equal(two.liveChildren.length, 2); assert.equal(new Set(two.capsules).size, 2);
  let cancelSent = false;
  f.respond = () => !cancelSent ? (cancelSent = true, { tools: [{ name: "larva_subagent_cancel", args: { task_id: concurrent.receipt.task_id, reason: "Cancel only the second native child" } }] }) : { text: "Targeted cancellation observed." };
  const cancelFrames = await p.prompt("Cancel only the second exact child");
  const cancelled = toolResults(cancelFrames, "larva_subagent_cancel")[0];
  assert.equal(cancelled.task_id, concurrent.receipt.task_id);
  assert.ok(["cancelled", "cancelling"].includes(cancelled.status));
  const deadline = Date.now() + 5000;
  let one = await f.inspect();
  while (one.liveChildren.length !== 1 && Date.now() < deadline) { await new Promise((r) => setTimeout(r, 25)); one = await f.inspect(); }
  assert.deepEqual(one.liveChildren, during.liveChildren); assert.equal(one.capsules.length, 1);
  evidence.concurrentCancellation = { secondReceipt: concurrent.receipt, liveBefore: two.liveChildren, capsulesBefore: two.capsules, cancelled, liveAfter: one.liveChildren, capsulesAfter: one.capsules, firstChildUnaffected: true };
  const exit = await p.stop();
  const cleaned = await cleanChildren(f);
  assert.ok((await readFile(held.receipt.task_id, "utf8")).includes("HOLD_NATIVE_CHILD"));
  evidence.shutdown = { receipt: held.receipt, inFlightProvider: true, liveBefore: during.liveChildren, capsulesBefore: during.capsules, exit, liveAfter: cleaned.liveChildren, capsulesAfter: cleaned.capsules, retainedSession: held.receipt.task_id };
}
async function runCapsuleAging(f, evidence) {
  const p = new NativeRpc(f, ["--larva-persona", "ok"]);
  await p.command("get_state");
  const held = await startTask(f, p, "HOLD_AGED_NATIVE_CHILD");
  await p.until((frames) => frames.slice(held.from).some((r) => r.type === "agent_settled"));
  const before = await f.inspect();
  assert.equal(before.liveChildren.length, 1); assert.equal(before.capsules.length, 1);
  const runtime = join(f.home, ".pi/larva/runtime");
  const owned = join(runtime, before.capsules[0]);
  const unrelated = join(runtime, "unrelated-cooperative-entry");
  await mkdir(unrelated); await writeFile(join(unrelated, "keep"), "unrelated data");
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  await utimes(owned, old, old); await utimes(unrelated, old, old);
  const q = new NativeRpc(f, ["--larva-persona", "ok"]);
  await q.command("get_state");
  const second = await startTask(f, q, "HOLD_OTHER_PARENT_CHILD");
  await q.until((frames) => frames.slice(second.from).some((r) => r.type === "agent_settled"));
  const after = await f.inspect();
  evidence.aging = { held: held.receipt, second: second.receipt, before, after, owned, unrelated, ageHours: 25 };
  assert.ok(after.liveChildren.includes(before.liveChildren[0]));
  assert.ok(after.capsules.includes(before.capsules[0]), "starting another parent child deleted an aged live capsule");
  assert.equal(await readFile(join(unrelated, "keep"), "utf8"), "unrelated data");
  // Cancel both through native lifecycle, then verify only unrelated state remains.
  await q.stop(); await p.stop();
  const stopped = await f.inspect();
  assert.deepEqual(stopped.liveChildren, []); assert.deepEqual(stopped.capsules, ["unrelated-cooperative-entry"]);
  assert.ok((await readFile(held.receipt.task_id, "utf8")).includes("HOLD_AGED_NATIVE_CHILD"));
  assert.deepEqual(stopped.settings, f.settings);
  evidence.aging.stopped = stopped;
  await rm(unrelated, { recursive: true }); // fixture-owned unrelated data, after preservation proof
}

async function runCapsuleRemoval(f, evidence) {
  evidence.removal = [];
  for (const [operation, code] of [["rmSync", "EACCES"], ["lstatSync", "EACCES"], ["rmSync", "ENOENT"]]) {
    const fault = join(f.root, "cleanup-fault.json");
    await rm(fault, { force: true });
    const p = new NativeRpc(f, ["--larva-persona", "ok"], { ...f.env, NATIVE_CLEANUP_FAULT: fault, NODE_OPTIONS: `--import=${pathToFileURL(join(ROOT, "tests/fixtures/pi/native-cleanup-fault.mjs")).href}` });
    await p.command("get_state");
    const task = await startTask(f, p, "HOLD_REMOVAL_NATIVE_CHILD");
    await p.until((frames) => frames.slice(task.from).some((r) => r.type === "agent_settled"));
    const before = await f.inspect();
    const capsule = join(f.home, ".pi/larva/runtime", before.capsules[0]);
    await writeFile(fault, JSON.stringify({ operation, code, path: capsule }));
    // Actual cancellation invokes Larva cleanup; inject only its OS operation.
    let cancel = true;
    f.respond = () => cancel ? (cancel = false, { tools: [{ name: "larva_subagent_cancel", args: { task_id: task.receipt.task_id, reason: "Exercise native cleanup filesystem failure" } }] }) : { text: "Cancellation observed." };
    const cancelled = toolResults(await p.prompt("Cancel the held native child"), "larva_subagent_cancel")[0];
    const terminal = cancelled.status === "cancelling" ? await waitCallback(p, task.from, task.receipt.task_id) : cancelled;
    assert.equal(terminal.status, "cancelled");
    let after;
    const deadline = Date.now() + 3000;
    do {
      after = await f.inspect();
      if (after.traces.some((r) => r.event === "cleanup_end" && r.pid === before.liveChildren[0])) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    const exit = await p.stop();
    const hits = await jsonLines(fault + ".hits");
    const observation = { operation, code, capsule, before, after, cancelled, exit, stderr: p.stderr, hits };
    evidence.removal.push(observation);
    assert.ok(hits.some((r) => r.operation === operation && r.path === capsule));
    assert.deepEqual(after.liveChildren, []);
    assert.ok(after.capsules.includes(before.capsules[0]));
    assert.deepEqual(after.settings, f.settings);
    assert.ok((await readFile(task.receipt.task_id, "utf8")).includes("HOLD_REMOVAL_NATIVE_CHILD"));
    assert.ok(await stat(join(f.agent, "models.json")), "linked base resource survives");
    assert.match(p.stderr, /larva pi: capsule cleanup failed:/);
    assert.ok(p.stderr.includes(capsule), "visible diagnostic retains the owned path");
    assert.ok(p.stderr.length < 2048, "filesystem exception must remain bounded");
    const end = after.traces.filter((r) => r.event === "cleanup_end").at(-1);
    assert.equal(end.running, false); assert.equal(end.capsule_root, capsule);
    await rm(fault); await rm(capsule, { recursive: true }); // scoped fixture recovery after child reaped
  }
}

async function runFailures(f, evidence) {
  evidence.cases = [];
  let retainedTask;
  for (const fault of ["runtime", "malformed"]) {
    const p = new NativeRpc(f, ["--larva-persona", "ok"], { ...f.env, NATIVE_CHILD_FAULT: fault });
    await p.command("get_state");
    const task = await startTask(f, p, fault === "runtime" ? "ERROR_NATIVE_PROVIDER" : "HOLD_MALFORMED_NATIVE", retainedTask);
    retainedTask = task.receipt.task_id;
    if (fault === "malformed") {
      const during = await f.inspect();
      assert.equal(during.liveChildren.length, 1);
      process.kill(during.liveChildren[0], "SIGUSR2");
    }
    const result = await waitCallback(p, task.from, task.receipt.task_id);
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, fault === "runtime" ? "LARVA_CHILD_RUNTIME_FAILED" : "LARVA_CHILD_PROTOCOL_FAILED");
    const cleanup = await cleanChildren(f);
    assert.ok(cleanup.sessions.includes(task.receipt.task_id.split("/").at(-1)));
    assert.ok((await readFile(task.receipt.task_id, "utf8")).includes("ERROR_NATIVE_PROVIDER"));
    evidence.cases.push({ fault, receipt: task.receipt, result, cleanup, retainedSession: true });
    await p.stop();
  }
  const startupParent = new NativeRpc(f, ["--larva-persona", "ok"], { ...f.env, FAKE_LARVA_SCENARIO: "native-child-resolve-exit" });
  await startupParent.command("get_state");
  let startupSent = false;
  f.respond = () => !startupSent ? (startupSent = true, { tools: [{ name: "larva_subagent", args: { persona_id: "child", task: "Fail actual child startup" } }] }) : { text: "Observed typed startup failure." };
  const startupFrames = await startupParent.prompt("native-driver-start");
  const startupResult = toolResults(startupFrames, "larva_subagent")[0];
  assert.equal(startupResult.status, "failed");
  assert.equal(startupResult.error.code, "LARVA_PERSONA_NOT_FOUND");
  evidence.cases.push({ fault: "native-startup", result: startupResult, cleanup: await cleanChildren(f) });
  await startupParent.stop();
  // Remove only the frame preload in a disposable installed-package copy.
  const copy = join(f.root, "missing-preload-package");
  await mkdir(copy);
  const source = join(ROOT, "contrib/pi-extension");
  for (const file of ["larva.ts", "activity.ts", "package.json"]) await copyFile(join(source, file), join(copy, file));
  await symlink(join(source, "node_modules"), join(copy, "node_modules"));
  await writeFile(join(f.agent, "settings.json"), JSON.stringify({ ...f.settings, packages: [copy] }));
  const p = new NativeRpc(f, ["--larva-persona", "ok"]);
  await p.command("get_state");
  const traceBefore = (await jsonLines(join(f.root, "child-trace.jsonl"))).length;
  let emitted = false;
  f.respond = () => !emitted ? (emitted = true, { tools: [{ name: "larva_subagent", args: { persona_id: "child", task: "Never spawn without preload" } }] }) : { text: "Observed startup failure." };
  const frames = await p.prompt("native-driver-start");
  const result = toolResults(frames, "larva_subagent")[0];
  assert.equal(result.status, "failed"); assert.equal(result.error.code, "LARVA_CHILD_START_FAILED");
  const trace = (await jsonLines(join(f.root, "child-trace.jsonl"))).slice(traceBefore);
  assert.ok(!trace.some((r) => r.event === "child_spawn"));
  const cleanup = await cleanChildren(f);
  evidence.cases.push({ fault: "missing-preload", result, trace, cleanup, spawned: false });
  await p.stop();
}

async function runWatchdog(f, evidence) {
  const p = new NativeRpc(f, ["--larva-persona", "ok"]);
  await p.command("get_state");
  const start = Date.now();
  const task = await startTask(f, p, "HOLD_WATCHDOG_NATIVE", undefined, { no_progress_timeout_ms: 120000 });
  const before = await f.inspect();
  assert.equal(before.liveChildren.length, 1); assert.equal(before.capsules.length, 1);
  const result = await waitCallback(p, task.from, task.receipt.task_id, 160000);
  const elapsed = Date.now() - start;
  assert.equal(result.status, "cancelled");
  assert.equal(result.error?.code, "LARVA_CHILD_CANCELLED");
  assert.match(result.error?.message, /recognized progress|no.progress|120000/i);
  assert.ok(elapsed >= 120000 && elapsed < 160000);
  const after = await cleanChildren(f);
  assert.ok((await readFile(task.receipt.task_id, "utf8")).includes("HOLD_WATCHDOG_NATIVE"));
  evidence.watchdog = { receipt: task.receipt, before, result, elapsed, after, retainedSession: true };
  await p.stop();
}

async function runInvocation(f, evidence) {
  const p = new NativeRpc(f, ["--larva-persona", "ok"]);
  await p.command("get_state");
  const id = randomUUID();
  await p.command("prompt", { message: "/audit-invoke " + JSON.stringify({ request_id: id, persona_id: "child", prompt: "Invoke through the actual event bus", timeout_ms: 15000 }) });
  const result = await waitObservation(f, "invocation", (r) => r.request_id === id);
  assert.equal(result.value.status, "success"); assert.equal(result.value.final_text, "Deterministic protocol response.");
  await cleanChildren(f);
  f.respond = () => ({ hold: true });
  const timeoutId = randomUUID();
  await p.command("prompt", { message: "/audit-invoke " + JSON.stringify({ request_id: timeoutId, persona_id: "child", prompt: "Held native invocation", timeout_ms: 2000 }) });
  const timed = await waitObservation(f, "invocation", (r) => r.request_id === timeoutId);
  assert.equal(timed.value.error.code, "LARVA_PERSONA_INVOCATION_TIMEOUT");
  const clean = await cleanChildren(f);
  assert.ok(clean.sessions.length >= 1);
  evidence.invocation = { success: result.value, timeout: timed.value, cleanup: { live: clean.liveChildren, capsules: clean.capsules, sessions: clean.sessions } };
  await p.stop();
}
async function runEnvironment(f, evidence) {
  const ab = join(f.root, "ab");
  const helper = join(ROOT, "tests/fixtures/pi/native_ab_probe.py");
  const python = join(ROOT, ".venv/bin/python");
  const rust = await execute("rustup", ["which", "rustc"]);
  assert.equal(rust.code, 0, rust.stderr);
  const rustBin = rust.stdout.trim().replace(/\/rustc$/, "");
  const cleanPath = `${rustBin}:${f.env.PATH}`;
  const prepareEnv = { ...f.env, PATH: cleanPath, UV_CACHE_DIR: join(f.root, "uv-cache"), CARGO_HOME: join(f.root, "cargo"), CARGO_TARGET_DIR: join(f.root, "target"), UV_PYTHON_DOWNLOADS: "never" };
  const preparation = await execute(python, [helper, "--prepare", ab, ROOT], { env: prepareEnv, timeout: 240000 });
  assert.equal(preparation.code, 0, preparation.stderr + preparation.stdout);
  evidence.preparation = JSON.parse(preparation.stdout);
  const binding = JSON.stringify([join(ab, "A/bin/python"), join(ab, "backend.py")]);
  const observations = [];
  for (const mode of ["red", "B", "absent"]) {
    const env = { ...prepareEnv, LARVA_CLI_ARGV_JSON: binding };
    if (mode !== "absent") { env.VIRTUAL_ENV = join(ab, mode === "red" ? "A" : "B"); env.PATH = join(env.VIRTUAL_ENV, "bin") + ":" + cleanPath; }
    const p = new NativeRpc(f, ["--larva-persona", "ok"], env);
    await p.command("get_state");
    await p.command("prompt", { message: "/larva-persona --refresh-cache" });
    let pendingTool;
    const requested = new Set();
    const tool = (label) => ({ name: "bash", args: { command: `${JSON.stringify(join(ab, "B/bin/python"))} ${JSON.stringify(helper)} --tool ${JSON.stringify(ab)} ${label}` } });
    f.respond = (payload) => {
      const system = JSON.stringify(payload.messages?.filter((m) => m.role === "system" || m.role === "developer")) ?? "";
      const child = system.includes("larva-spec: child@");
      if (child && !requested.has("child")) { requested.add("child"); return { tools: [tool(mode === "B" ? "child" : "no-child")] }; }
      if (!child && pendingTool) { const next = pendingTool; pendingTool = null; return { tools: [next] }; }
      return { text: "Native tool protocol completed." };
    };
    const mainLabel = mode === "red" ? "red" : mode === "B" ? "main" : "no-main";
    pendingTool = tool(mainLabel);
    const mainFrames = await p.prompt(`NATIVE_ENV_${mode}`, 120000);
    assert.equal(mainFrames.filter((row) => row.type === "tool_execution_end" && row.toolName === "bash").length, 1);
    const main = JSON.parse(await readFile(join(ab, `${mainLabel}-tool.json`), "utf8"));
    assert.equal(main.virtualEnv, mode === "absent" ? null : env.VIRTUAL_ENV);
    assert.deepEqual(main.targets, mode === "red" ? { A: true, B: false } : mode === "B" ? { A: false, B: true } : { A: false, B: false });
    assert.equal(main.result.exit === 0, mode !== "absent");
    if (mode !== "red") {
      pendingTool = { name: "larva_subagent", args: { persona_id: "child", task: `NATIVE_ENV_CHILD_${mode}` } };
      const from = p.frames.length;
      await p.command("prompt", { message: "start native environment child" });
      await p.until((frames) => toolResults(frames.slice(from), "larva_subagent")[0], 20000);
      const receipt = toolResults(p.frames.slice(from), "larva_subagent")[0];
      assert.equal(receipt.status, "accepted", JSON.stringify(receipt));
      const callback = await waitCallback(p, from, receipt.task_id);
      assert.equal(callback.status, "success");
      const child = JSON.parse(await readFile(join(ab, `${mode === "B" ? "child" : "no-child"}-tool.json`), "utf8"));
      assert.equal(child.virtualEnv, mode === "B" ? env.VIRTUAL_ENV : null);
      assert.deepEqual(child.targets, { A: false, B: mode === "B" });
      assert.equal(child.result.exit === 0, mode === "B");
      observations.push({ mode, main, child, receipt, callback });
      await cleanChildren(f);
    } else observations.push({ mode: "inherited-A negative control", main });
    const snapshot = await p.snapshot();
    assert.equal(snapshot.value.env.virtualEnv, mode === "absent" ? null : env.VIRTUAL_ENV);
    assert.equal(snapshot.value.env.capsule, null);
    await p.stop();
  }
  const backend = await jsonLines(join(ab, "backend.jsonl"));
  for (const value of [join(ab, "A"), join(ab, "B"), null]) {
    const matching = backend.filter((row) => row.virtualEnv === value);
    assert.ok(matching.some((row) => row.argv[0] === "resolve"));
    assert.ok(matching.some((row) => row.argv[0] === "list"));
    assert.ok(matching.every((row) => row.prefix === join(ab, "A")));
  }
  evidence.environment = { observations, backend, backendActivatedByExtension: false };
}

async function runPrint(f, evidence) {
  let sent = false;
  f.respond = () => !sent ? (sent = true, { tools: [{ name: "larva_persona_switch", args: { persona_id: "child", reason: "Print mode must deny confirmation", continue_task: false } }] }) : { text: "Native print completed after safe denial." };
  const run = await execute(process.execPath, [CLI, "-p", "--offline", "--approve", "-e", CONTROL, "--larva-persona", "ok", "Exercise print mode"], { env: f.env, cwd: f.cwd, timeout: 20000 });
  assert.equal(run.code, 0, run.stderr);
  assert.ok(run.stdout.includes("Native print completed after safe denial."));
  assert.equal(f.requests.length, 2);
  assert.ok(text(f.requests[1].payload).includes("LARVA_CONFIRMATION_UNAVAILABLE"));
  for (const request of f.requests) {
    const system = request.payload.messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => m.content).join("\n");
    assert.ok(system.includes("You are fake persona ok."));
    assert.ok(!system.includes("You are fake persona child."));
  }
  evidence.print = run;
}

async function runStoredRestore(f, evidence) {
  const p = new NativeRpc(f, ["--larva-persona", "ok"]);
  await p.command("get_state");
  await p.prompt("Persist native saved-session history");
  const saved = await p.snapshot();
  assert.equal(commits(saved).at(-1).data.persona_id, "ok");
  await p.stop();
  const log = join(f.root, "resolved.jsonl");
  const q = new NativeRpc(f, ["--session", saved.value.session, "--larva-persona", "startup"], { ...f.env, FAKE_LARVA_RESOLVE_LOG: log, FAKE_LARVA_MODEL_ok: "unavailable/stored", FAKE_LARVA_MODEL_startup: "unavailable/unused" });
  const state = await q.command("get_state");
  const resolves = await jsonLines(log);
  assert.deepEqual(resolves.slice(0, 2), [{ id: "startup", resolved: true }, { id: "ok", resolved: true }]);
  const status = q.frames.filter((r) => r.type === "extension_ui_request" && r.method === "setStatus");
  assert.ok(status.some((r) => /unavailable.*LARVA_MODEL_UNAVAILABLE|restore unavailable/.test(r.statusText)));
  assert.ok(!status.some((r) => /^larva: (ok|startup)$/.test(r.statusText)));
  const before = f.requests.length;
  await q.prompt("Prove the reopened session is still usable");
  assert.equal(f.requests.length, before + 1);
  const system = f.requests.at(-1).payload.messages.filter((m) => m.role === "system" || m.role === "developer");
  assert.ok(!JSON.stringify(system).includes("larva-spec:"), "failed stored restore must not activate explicit or stored persona");
  const after = await q.snapshot();
  assert.equal(commits(after).length, commits(saved).length);
  const exit = await q.stop();
  evidence.restore = { session: saved.value.session, resolves, state, status, exit, providerRequests: 1, system, commitsBefore: commits(saved).length, commitsAfter: commits(after).length };
}

async function runInstalledLoading(f, evidence) {
  const source = join(ROOT, "contrib/pi-extension");
  const copy = join(f.root, "installed-package");
  await mkdir(copy);
  for (const name of ["larva.ts", "activity.ts", "child-rpc-frame-preload.mjs", "package.json"]) await copyFile(join(source, name), join(copy, name));
  await symlink(join(source, "node_modules"), join(copy, "node_modules"));
  await writeFile(join(f.agent, "settings.json"), JSON.stringify({ ...f.settings, packages: [] }));
  const install = await execute(process.execPath, [CLI, "install", copy], { env: f.env, cwd: f.cwd });
  assert.equal(install.code, 0, install.stderr);
  const args = [CLI, "-p", "--offline", "--approve", "--larva-persona", "ok", "Viable loopback prompt"];
  const control = await execute(process.execPath, args, { env: f.env, cwd: f.cwd });
  assert.equal(control.code, 0, control.stderr); assert.equal(f.requests.length, 1);
  evidence.install = install; evidence.control = { ...control, requests: f.requests.length };
  evidence.cases = [];
  const missingDependency = `@larva-native-fixture/absent-tui-${randomUUID()}`;
  for (const fault of ["missing-entry", "host-provided-dependency-control", "broken-dependency-import"]) {
    if (fault === "missing-entry") await rm(join(copy, "larva.ts"));
    else if (fault === "host-provided-dependency-control") {
      await copyFile(join(source, "larva.ts"), join(copy, "larva.ts"));
      await rm(join(copy, "node_modules"));
      const dependency = join(copy, "node_modules/@earendil-works/pi-tui");
      await mkdir(dependency, { recursive: true });
      await writeFile(join(dependency, "package.json"), JSON.stringify({ name: "@earendil-works/pi-tui", version: "0.85.1", type: "module", exports: "./index.js" }));
      await writeFile(join(dependency, "index.js"), 'throw new Error("Deliberately unusable package-local dependency");\n');
    } else {
      // Fault only the installed copy's actual import. Pi's embedded TUI and the
      // production source stay intact; package-local TUI bytes are unused here.
      const entry = join(copy, "larva.ts");
      const installed = await readFile(entry, "utf8");
      const specifier = 'from "@earendil-works/pi-tui";';
      assert.equal(installed.split(specifier).length, 2, "fault must target exactly one import");
      await writeFile(entry, installed.replace(specifier, `from "${missingDependency}";`));
    }
    const before = f.requests.length;
    const run = await execute(process.execPath, args, { env: f.env, cwd: f.cwd, timeout: 15000 });
    evidence.cases.push({ fault, ...(fault === "broken-dependency-import" ? { missingDependency } : {}), ...run, requests: f.requests.length - before });
    assert.equal(run.timedOut, false);
    if (fault === "host-provided-dependency-control") {
      assert.equal(run.code, 0, JSON.stringify(run));
      assert.equal(f.requests.length, before + 1);
      const system = f.requests.at(-1).payload.messages.filter((m) => m.role === "system" || m.role === "developer");
      assert.ok(JSON.stringify(system).includes("larva-spec: ok@"), "host-provided dependency must preserve the requested persona");
    } else {
      assert.equal(run.code, 1, JSON.stringify(run));
      if (fault === "missing-entry") assert.match(run.stderr, /Unknown option: --larva-persona/);
      else {
        assert.match(run.stdout + run.stderr, /Cannot find module|Cannot find package|ERR_MODULE_NOT_FOUND/);
        assert.ok((run.stdout + run.stderr).includes(missingDependency), "native diagnostic must name the broken import");
      }
      assert.equal(f.requests.length, before, "failed installed loading issued a vanilla request");
    }
  }
}

async function runAdmission(f, evidence) {
  const badPolicy = join(f.root, "bad-policy.json");
  await writeFile(badPolicy, "{malformed");
  const cases = [
    { name: "missing-id", args: ["--larva-persona", "missing"], diagnostic: "LARVA_PERSONA_NOT_FOUND", code: 2 },
    { name: "bad-model", args: ["--larva-persona", "ok"], env: { FAKE_LARVA_MODEL_ok: "unavailable/missing" }, diagnostic: "LARVA_MODEL_UNAVAILABLE", code: 2 },
    { name: "bad-policy", args: ["--larva-persona", "ok"], env: { LARVA_PI_TOOL_POLICY_FILE: badPolicy }, diagnostic: "LARVA_POLICY_INVALID", code: 2 },
    { name: "bad-mode", args: ["--larva-agent-persona-switch", "invalid"], diagnostic: "LARVA_BAD_INPUT", code: 2 },
    { name: "bad-binding", args: ["--larva-persona", "ok"], env: { LARVA_CLI_ARGV_JSON: "[\"relative-program\"]" }, diagnostic: "LARVA_PERSONA_NOT_FOUND", code: 2 },
    { name: "unknown-flag", args: ["--unknown-native-fixture-flag"], diagnostic: "Unknown option", code: 1 },
    { name: "missing-value", args: ["--larva-persona"], diagnostic: "requires a value", code: 1 },
  ];
  evidence.cases = [];
  for (const mode of ["rpc", "print"]) {
    for (const row of cases) {
      const input = mode === "rpc" ? JSON.stringify({ id: "queued-first", type: "prompt", message: "A queued first request must never run" }) + "\n" : "A queued first request must never run";
      const args = [CLI, ...(mode === "rpc" ? ["--mode", "rpc"] : ["-p"]), "--offline", "--approve", "-e", CONTROL, ...row.args];
      const run = await execute(process.execPath, args, { cwd: f.cwd, env: { ...f.env, ...row.env }, input, timeout: 15000 });
      assert.equal(run.code, row.code, JSON.stringify({ mode, row, run }));
      assert.ok((run.stdout + run.stderr).includes(row.diagnostic), JSON.stringify({ row, run }));
      assert.equal(run.timedOut, false);
      assert.equal(f.requests.length, 0, "fatal admission issued a model request");
      evidence.cases.push({ mode, case: row.name, ...run, firstRequests: 0 });
    }
  }
  const tuiCases = cases.map((row) => ({ ...row, args: row.name === "missing-value" ? row.args : [...row.args, "A queued first request must never run"] }));
  const tui = await execute(join(ROOT, ".venv/bin/python"), [join(ROOT, "tests/fixtures/pi/native_tui_probe.py"), process.execPath, CLI, CONTROL, "--admission", JSON.stringify(tuiCases)], { cwd: ROOT, env: f.env, timeout: 120000 });
  assert.equal(tui.code, 0, tui.stderr);
  assert.equal(f.requests.length, 0);
  evidence.tui = JSON.parse(tui.stdout);
}

async function runConsumers(f, evidence) {
  const policy = join(f.root, "tool-policy.json");
  await writeFile(policy, JSON.stringify({ personas: { ok: { deny: ["native_denied"] } } }));
  const config = join(f.root, "compaction.json");
  const p = new NativeRpc(f, ["--larva-persona", "ok"], { ...f.env, NATIVE_TEST_TOOLS: "1", LARVA_PI_TOOL_POLICY_FILE: policy, LARVA_PI_COMPACTION_CONFIG_FILE: config, FAKE_LARVA_COMPACTION_FOCUS: "Keep the native fixture operation pending." });
  await p.command("get_state");
  let first = true;
  f.respond = () => first ? (first = false, { tools: [{ name: "native_allowed", args: {} }, { name: "native_denied", args: {} }] }) : { text: "Observed tool-policy batch." };
  const frames = await p.prompt("Exercise co-loaded tool composition");
  const effects = (await jsonLines(join(f.root, "observations.jsonl"))).filter((r) => r.event === "fixture_tool_effect");
  assert.deepEqual(effects.map((r) => r.value.name), ["native_allowed"]);
  const request = f.requests[0].payload;
  assert.ok(request.tools.some((t) => t.function.name === "native_allowed"));
  assert.ok(!request.tools.some((t) => t.function.name === "native_denied"));
  const system = request.messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => m.content).join("\n");
  assert.equal((system.match(/<!-- larva-spec:/g) ?? []).length, 1);
  assert.ok(system.includes("COLOADED_NON_LARVA_CONTENT"));
  evidence.composition = { effects, activeToolNames: request.tools.map((t) => t.function.name), overlayCount: 1, nonLarvaContentPreserved: true, deniedResult: frames.filter((f) => f.type === "tool_execution_end" && f.toolName === "native_denied") };
  // Build enough actual history for native compaction, then exercise both hook and fallback.
  f.respond = () => ({ text: "Observed conversation content. ".repeat(600) });
  await p.prompt("Build compaction history");
  const before = f.requests.length;
  f.respond = () => ({ text: "Deterministic compacted content." });
  await p.command("compact", { customInstructions: "Keep the operator's next action." }, 20000);
  const focused = await waitObservation(f, "session_compact", (r) => r.fromExtension === true);
  const focusRequest = f.requests[before].payload;
  const focusedText = text(focusRequest);
  assert.ok(focusedText.includes("Keep the native fixture operation pending."));
  assert.ok(focusedText.includes("Keep the operator's next action."));
  assert.ok(focusedText.includes("Larva carry-forward rule:"));
  await writeFile(config, JSON.stringify({ enabled: false }));
  f.respond = () => ({ text: "Another conversation span. ".repeat(600) });
  await p.prompt("Build second compaction history");
  const beforeFallback = f.requests.length;
  f.respond = () => ({ text: "Native fallback summary." });
  await p.command("compact", { customInstructions: "Native fallback operator focus." }, 20000);
  const fallback = await waitObservation(f, "session_compact", (r) => r.fromExtension === false);
  const fallbackText = text(f.requests[beforeFallback].payload);
  assert.ok(!fallbackText.includes("Larva carry-forward rule:"));
  assert.ok(fallbackText.includes("Native fallback operator focus."));
  evidence.compaction = { focused: focused.value, fallback: fallback.value, focusRequest, fallbackRequest: f.requests[beforeFallback].payload };
  await p.stop();
}

async function runTui(f, evidence) {
  let emitted = false, borrowed = false;
  f.respond = (payload) => {
    const system = JSON.stringify(payload.messages?.filter((m) => m.role === "system" || m.role === "developer")) ?? "";
    if (system.includes("larva-spec: child@") && text(payload).includes("HOLD_TUI_CHILD")) return { hold: true };
    if (!borrowed && text(payload).includes("NATIVE_TUI_BORROW")) { borrowed = true; return { tools: [{ name: "larva_persona_switch", args: { persona_id: "child", reason: "Native confirmation dialog observation", continue_task: false } }] }; }
    if (!emitted && text(payload).includes("NATIVE_TUI_START_CHILD")) { emitted = true; return { tools: [{ name: "larva_subagent", args: { persona_id: "child", task: "HOLD_TUI_CHILD" } }] }; }
    return { text: "Native TUI turn completed." };
  };
  const result = await execute(join(ROOT, ".venv/bin/python"), [join(ROOT, "tests/fixtures/pi/native_tui_probe.py"), process.execPath, CLI, CONTROL], { env: f.env, timeout: 120000 });
  evidence.terminalRun = result;
  // Retain actual terminal output even if a key/state assertion fails.
  evidence.terminals = await Promise.all((await directory(f.root)).filter((name) => name.startsWith("terminal-")).map(async (name) => ({ name, output: await readFile(join(f.root, name), "utf8") })));
  assert.equal(result.code, 0, result.stderr + result.stdout);
  evidence.tui = JSON.parse(result.stdout);
  await cleanChildren(f);
  const settings = JSON.parse(await readFile(join(f.agent, "settings.json"), "utf8"));
  assert.equal(settings.theme, "light");
  for (const key of ["defaultProvider", "defaultModel", "defaultThinkingLevel"]) assert.equal(settings[key], f.settings[key]);
}

export async function runJourney(scenario) {
  const f = await createNativeFixture();
  const evidence = { scenario, modality: "actual native CLI + normal package loader + loopback provider", node: process.version, cli: CLI };
  try {
    if (scenario === "state") await runState(f, evidence);
    else if (scenario === "children") await runChildren(f, evidence);
    else if (scenario === "invocation") await runInvocation(f, evidence);
    else if (scenario === "environment") await runEnvironment(f, evidence);
    else if (scenario === "tui") await runTui(f, evidence);
    else if (scenario === "consumers") await runConsumers(f, evidence);
    else if (scenario === "watchdog") await runWatchdog(f, evidence);
    else if (scenario === "failures") await runFailures(f, evidence);
    else if (scenario === "capsule-aging") await runCapsuleAging(f, evidence);
    else if (scenario === "capsule-removal") await runCapsuleRemoval(f, evidence);
    else if (scenario === "admission") await runAdmission(f, evidence);
    else if (scenario === "installed-loading") await runInstalledLoading(f, evidence);
    else if (scenario === "stored-restore") await runStoredRestore(f, evidence);
    else if (scenario === "print") await runPrint(f, evidence);
    else throw new Error(`Unknown journey ${scenario}`);
    assert.deepEqual(f.errors, [], "loopback fixture failure");
    evidence.pass = true;
  } catch (error) { evidence.pass = false; evidence.error = error.stack; }
  finally {
    evidence.observations = await jsonLines(join(f.root, "observations.jsonl"));
    evidence.requests = f.requests;
    evidence.stderr = f.parents.map((p) => p.stderr);
    evidence.cleanup = await f.close();
    if (evidence.cleanup.liveChildren.length || evidence.cleanup.capsules.length) { evidence.pass = false; evidence.cleanupFailure = "owned children/capsules remained before scratch deletion"; }
  }
  return evidence;
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const scenario = process.argv[process.argv.indexOf("--scenario") + 1];
  const evidence = await runJourney(scenario);
  const output = process.argv[process.argv.indexOf("--output") + 1];
  if (process.argv.includes("--output")) await writeFile(output, JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify({ scenario, pass: evidence.pass, error: evidence.error, cleanup: { live: evidence.cleanup.liveChildren, capsules: evidence.cleanup.capsules, parents: evidence.cleanup.parents }, stderr: evidence.stderr }));
  process.exitCode = evidence.pass ? 0 : 1;
}
