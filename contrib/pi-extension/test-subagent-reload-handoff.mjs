// purpose: prove live subagent ownership transfers across fresh module imports on Pi reload
// usage: node contrib/pi-extension/test-subagent-reload-handoff.mjs
// effects: controlled RPC subprocesses and disposable capsules; no live provider calls
// requires: Node with registerHooks and installed extension dependencies
import "../../scripts/pi-test-child-loader.mjs";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = await mkdtemp(join(tmpdir(), "larva-reload-handoff-"));
const modules = new Set();
let importSequence = 0;
const fresh = async () => {
  const mod = await import(`./larva.ts?reload-${++importSequence}`);
  modules.add(mod);
  return mod;
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (check) => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for callback delivery");
};
try {
  const agent = join(root, "agent");
  await mkdir(agent);
  await writeFile(join(agent, "settings.json"), "{}");
  const child = join(root, "child.mjs");
  // SIGUSR1 is a deterministic completion gate: the real child stays running
  // throughout teardown/import/rebind, without a timing-dependent finish delay.
  await writeFile(child, `
import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.argv.at(-1);
mkdirSync(root, { recursive: true });
const sessionFile = join(root, 'child-' + process.pid + '.jsonl');
writeFileSync(sessionFile, JSON.stringify({ type: 'session', id: 'child-' + process.pid }) + '\\n');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
process.on('SIGUSR1', () => send({ type: 'agent_end' }));
createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  const route = process.env.LARVA_PI_INITIAL_PERSONA_MODEL_FROM_CLI;
  const slash = route.indexOf('/');
  if (msg.type === 'get_state') send({ id: msg.id, success: true, data: { sessionFile, model: { provider: route.slice(0, slash), id: route.slice(slash + 1) }, thinkingLevel: process.env.LARVA_PI_CHILD_REQUESTED_THINKING } });
  else if (msg.type === 'prompt') send({ id: msg.id, success: true });
  else if (msg.type === 'get_last_assistant_text') { send({ id: msg.id, success: true, data: { text: 'reload-complete' } }); setTimeout(() => process.exit(0), 5); }
  else if (msg.type === 'abort') { send({ id: msg.id, success: true }); process.exit(0); }
});
`);
  const env = {
    HOME: root, PI_CODING_AGENT_DIR: agent,
    LARVA_PI_CHILD_RPC_LEGACY_FALLBACK: "1",
    LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, fileURLToPath(new URL("../../tests/fixtures/pi/fake-larva-cli.mjs", import.meta.url))]),
    LARVA_PI_CHILD_SESSION_DIR: join(root, "sessions"),
    LARVA_PI_TEST_CHILD_ARGV_JSON: JSON.stringify([process.execPath, child]),
  };
  function host() {
    const handlers = new Map();
    const callbacks = [];
    const statuses = [];
    const tools = new Map();
    let poisoned = false;
    let staleCalls = 0;
    function check() { if (poisoned) { staleCalls++; throw new Error("retired Pi surface called"); } }
    const ctx = { env, mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "same-parent", getSessionFile: () => join(root, "parent.jsonl"), getBranch: () => [] }, modelRegistry: { find: (provider, id) => ({ provider, id }) }, ui: { setStatus(key, value) { check(); statuses.push([key, value]); }, notify() {} } };
    const pi = { registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {}, on(name, handler) { handlers.set(name, handler); }, getAllTools: () => ["read", "bash", "larva_subagent"], setActiveTools: () => true, setModel: () => true, getThinkingLevel: () => "off", setThinkingLevel() {}, sendMessage(message) { check(); callbacks.push(message); } };
    return { ctx, pi, callbacks, statuses, tools, poison() { poisoned = true; }, get staleCalls() { return staleCalls; }, emit: async (name, reason) => handlers.get(name)?.({ type: name, reason }, ctx) };
  }
  async function spawn(mod, h) {
    const result = await h.tools.get("larva_subagent").execute("reload-call", { persona_id: "child", task: "Wait for reload handoff" }, undefined, () => {}, h.ctx);
    assert.equal(result.status, "accepted", JSON.stringify(result));
    const run = mod.subagentActiveRunDiagnosticsForTests().find((r) => r.task_id === result.task_id);
    assert.equal(run.status, "running");
    assert.equal(run.child_running, true);
    assert.ok(alive(run.child_pid));
    return { task: result.task_id, pid: run.child_pid };
  }
  // Both a running completion and a terminal result arriving in the reload gap.
  for (const finishInGap of [false, true]) {
    const one = await fresh();
    const old = host();
    await one.initializeExtension(old.ctx, old.pi);
    assert.equal((await one.commitPersona("ok", old.ctx, old.pi)).ok, true);
    const { task, pid } = await spawn(one, old);
    const before = one.larva_subagent_events().details.next_sequence;
    const existingWaiter = one.larva_subagent_wait({ task_ids: [task], timeout_ms: 5000 }, old.ctx);
    await old.emit("session_shutdown", "reload");
    old.poison();
    assert.equal(one.sessionTimelineReaderMetricsForTests().active, false);
    if (finishInGap) {
      process.kill(pid, "SIGUSR1");
      const terminal = await one.larva_subagent_wait({ task_ids: [task], timeout_ms: 5000 }, old.ctx);
      assert.equal(terminal.details.satisfied, true);
      assert.equal(terminal.details.terminal_result.callback_delivery, "pending");
      assert.equal(old.callbacks.length, 0);
    }
    const two = await fresh();
    const next = host();
    await two.initializeExtension(next.ctx, next.pi);
    await next.emit("session_start", "reload");
    assert.ok(two.subagentPresentationLogForTests().some((e) => e.task_id === task));
    if (!finishInGap) {
      await old.emit("session_shutdown", "quit");
      assert.ok(alive(pid), "retired handler must not reap transferred child");
      const status = await two.larva_subagent_status({ task_id: task }, next.ctx);
      assert.equal(status.details.runs[0].status, "running");
      assert.ok(next.statuses.some(([k, v]) => k === "larva-subagents" && v === "🤖 1"));
      assert.equal(two.subagentPresentationLogForTests().find((e) => e.task_id === task).status, "running");
      assert.equal(two.sessionTimelineReaderMetricsForTests().active, true, "replacement worker resumes scans");
      process.kill(pid, "SIGUSR1");
    }
    assert.equal((await existingWaiter).details.satisfied, true, "pre-reload waiter remains subscribed");
    const waited = await two.larva_subagent_wait({ task_ids: [task], timeout_ms: 5000 }, next.ctx);
    assert.equal(waited.details.satisfied, true);
    assert.equal(waited.details.terminal_result.status, "success");
    await until(() => next.callbacks.length === 1);
    assert.equal(next.callbacks[0].customType, "larva-subagent-result");
    assert.match(next.callbacks[0].content, /reload-complete/);
    assert.equal(old.staleCalls, 0);
    assert.equal(old.callbacks.length, 0);
    assert.equal(one.sessionTimelineReaderMetricsForTests().active, false, "old stream closures must not restart the retired worker");
    assert.ok(next.statuses.some(([k, v]) => k === "larva-subagents" && v === undefined));
    assert.ok(two.larva_subagent_events().details.next_sequence > before);
    // Terminal callback precedes the collector's asynchronous child cleanup.
    await until(async () => !alive(pid) && (await readdir(join(root, ".pi/larva/runtime"))).length === 0);
    await next.emit("session_shutdown", "quit");
    assert.equal(alive(pid), false);
    assert.deepEqual(await readdir(join(root, ".pi/larva/runtime")), []);
  }
  // A failed host reload leaves the old shutdown handler responsible for cleanup.
  {
    const mod = await fresh();
    const h = host();
    await mod.initializeExtension(h.ctx, h.pi);
    assert.equal((await mod.commitPersona("ok", h.ctx, h.pi)).ok, true);
    const { task, pid } = await spawn(mod, h);
    await h.emit("session_shutdown", "reload");
    await h.emit("session_shutdown", "quit");
    assert.equal(alive(pid), false);
    assert.deepEqual(await readdir(join(root, ".pi/larva/runtime")), []);
    assert.equal(mod.subagentActiveRunDiagnosticsForTests().find(r => r.task_id === task).callback_delivery, "stale");
    assert.equal(h.callbacks.length, 0);
  }
  // Retention must protect every deferred callback, even beyond the 25-run window.
  {
    const one = await fresh();
    const old = host();
    await one.initializeExtension(old.ctx, old.pi);
    assert.equal((await one.commitPersona("ok", old.ctx, old.pi)).ok, true);
    const runs = [];
    for (let i = 0; i < 27; i++) runs.push(await spawn(one, old));
    await old.emit("session_shutdown", "reload");
    old.poison();
    for (const { pid } of runs) process.kill(pid, "SIGUSR1");
    await until(() => one.subagentActiveRunDiagnosticsForTests().every(r => r.status === "success"));
    const pending = one.subagentActiveRunDiagnosticsForTests();
    assert.equal(pending.length, 27);
    assert.ok(pending.every(r => r.callback_delivery === "pending"));
    const two = await fresh();
    const next = host();
    await two.initializeExtension(next.ctx, next.pi);
    await next.emit("session_start", "reload");
    await until(() => next.callbacks.length === 27);
    assert.deepEqual(new Set(next.callbacks.map(m => m.details.task_id)), new Set(runs.map(r => r.task)));
    assert.equal(two.subagentActiveRunDiagnosticsForTests().length, 25);
    assert.ok(two.subagentActiveRunDiagnosticsForTests().every(r => r.callback_delivery === "delivered"));
    assert.equal(old.staleCalls, 0);
    await until(async () => runs.every(r => !alive(r.pid)) && (await readdir(join(root, ".pi/larva/runtime"))).length === 0);
    await next.emit("session_shutdown", "quit");
  }
  for (const reason of ["quit", "new", "resume", "fork"]) {
    const mod = await fresh();
    assert.deepEqual(mod.subagentActiveRunDiagnosticsForTests(), [], "normal imports must not inherit state");
    const h = host();
    await mod.initializeExtension(h.ctx, h.pi);
    assert.equal((await mod.commitPersona("ok", h.ctx, h.pi)).ok, true);
    const { pid } = await spawn(mod, h);
    await h.emit("session_shutdown", reason);
    assert.equal(alive(pid), false, `${reason} must reap child`);
    assert.deepEqual(await readdir(join(root, ".pi/larva/runtime")), [], `${reason} must remove capsule`);
    assert.equal(h.callbacks.length, 0);
    assert.equal(mod.subagentPresentationLogForTests().length, 0);
  }
  console.log("PASS: running reload handoff, reload-gap callback, failed-reload quit cleanup, 27 deferred callbacks retained then pruned to 25, fresh-import isolation, quit/new/resume/fork child and capsule cleanup");
} finally {
  for (const mod of modules) await mod.resetExtensionUI("test_cleanup");
  await rm(root, { recursive: true, force: true });
}
