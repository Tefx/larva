import assert from "node:assert/strict";
import { access, lstat, mkdir, readFile, readdir, readlink, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fixture, tool } from "./fixture.ts";

const spawn = "larva_subagent";
const launch = (persona_id: string, task: string, timing: object = {}) => [tool(spawn, { persona_id, task, ...timing })];

for (const base of ["relative", "absolute", "tilde"] as const) test(`real Pi base (${base}) survives two child hops and reload`, { timeout: 30_000 }, () => fixture(async f => {
  if (base === "relative") await rm(f.sessions, { recursive: true });
  await f.config({ subagent: { extension_sources: ["pi-agent:provider.mjs"] } });
  const agent = dirname(f.modelCatalog), override = join(f.cwd, "agent-env.mjs");
  await symlink(agent, join(f.cwd, "agent"), "dir");
  await rm(join(f.host, ".pi", "settings.json"));
  const catalog = '{"providers":{}}\n';
  await writeFile(f.modelCatalog, catalog);
  // Set the override inside the isolated native Pi process, before Larva's first spawn.
  await writeFile(override, `export default () => { process.env.PI_CODING_AGENT_DIR = ${JSON.stringify(
    base === "relative" ? "agent" : base === "absolute" ? agent : "~/agent",
  )}; };`);
  const pi = f.pi(["-e", override, "--larva-persona", "parent"]);
  const forbidden = await pi.prompt("Parent tries to bypass its explicit allowlist");
  (await f.provider(0, "Parent tries to bypass its explicit allowlist")).reply(launch("leaf", "must not spawn directly"));
  assert.equal((await pi.toolResult(forbidden, spawn)).error.code, "LARVA_SPAWN_NOT_ALLOWED");
  (await f.provider(1, "LARVA_SPAWN_NOT_ALLOWED")).reply("Allowlist denied direct leaf");
  await pi.settled(forbidden);

  if (base === "relative") await assert.rejects(access(f.sessions), { code: "ENOENT" });
  const start = f.requests.length;
  const from = await pi.prompt("Start the multi-hop process tree");
  const initial = await f.provider(start, "Start the multi-hop process tree");
  const afterLaunch = f.requests.length;
  initial.reply(launch("worker", "Worker must spawn its own leaf", { cwd: f.host }));
  const accepted = await pi.toolResult(from, spawn);
  assert.equal(accepted.status, "accepted", JSON.stringify(accepted));
  assert.equal(accepted.cwd, f.host);
  const parent = await f.provider(afterLaunch, accepted.task_id);
  assert.equal(parent.payload.model, "parent");
  parent.reply("Root waiting for worker result");
  await pi.settled(from);

  const worker = await f.provider(afterLaunch, "Worker must spawn its own leaf");
  assert.equal(worker.payload.model, "worker");
  assert.ok(worker.payload.tools?.some(t => t.function.name === spawn));
  assert.ok(!worker.payload.tools?.some(t => t.function.name === "larva_persona_switch"), "launched child is manual");
  const afterWorkerLaunch = f.requests.length;
  worker.reply(launch("leaf", "A leaf may not spawn"));
  const leaf = await f.provider(afterWorkerLaunch, "A leaf may not spawn");
  assert.equal(leaf.payload.model, "leaf");
  assert.ok(leaf.payload.tools?.some(t => t.function.name === "larva_personas"));
  assert.ok(!leaf.payload.tools?.some(t => t.function.name.startsWith("larva_subagent")));
  const intermediate = await f.provider(afterWorkerLaunch, '"status":"accepted"');
  assert.equal(intermediate.payload.model, "worker");
  const grandchild = JSON.parse(intermediate.last);
  assert.notEqual(grandchild.task_id, accepted.task_id);
  assert.equal(grandchild.cwd, f.host);
  intermediate.reply("Provisional worker output before grandchild callback");

  const snapshot = async () => (await pi.command(`/larva-subagent ${accepted.task_id}`)).runs[0];
  const before = await snapshot();
  assert.equal(before.run_epoch, accepted.run_epoch);
  assert.equal(before.status, "running");
  assert.equal(before.output_state, "pending");
  const lock = `${accepted.task_id}.lock/lease.json`;
  const ownership = await readFile(lock, "utf8");
  const workerLease = JSON.parse(ownership);
  const leafLease = JSON.parse(await readFile(`${grandchild.task_id}.lock/lease.json`, "utf8"));
  assert.equal(workerLease.owner_pid, pi.child.pid);
  assert.equal(leafLease.owner_pid, workerLease.child_pid);
  for (const { capsule_root, child_pid } of [workerLease, leafLease]) {
    assert.equal(capsule_root, await realpath(capsule_root));
    assert.deepEqual(JSON.parse(await readFile(join(capsule_root, "child_self.json"), "utf8")), { pid: child_pid });
    assert.equal(await readFile(join(capsule_root, "agent", "models.json"), "utf8"), catalog);
  }
  if (base === "relative") {
    const task = accepted.task_id;
    assert.equal(dirname(task), f.sessions);
    const old = new Date(Date.now() - 3 * 86_400_000);
    await utimes(task, old, old);
    const disk = f.mcp(); // Open the same running lease via the configured symlink.
    await disk.initialize();
    const status = await disk.ok("larva_subagent_status", { task_id: task });
    assert.equal(status.disk_sessions[0].lock_state, "active_external");
    assert.equal((await disk.close()).code, 0);
    const reports = await Promise.all([f.configuredHome, f.home].map(async home => {
      const gc = f.gc(false, home);
      assert.equal((await gc.exited()).code, 0);
      assert.equal(gc.frames[0].ok, true);
      return gc.frames[0].data;
    }));
    assert.deepEqual(reports[0], reports[1]);
    assert.equal(reports[0].deleted_sessions, 0);
    assert.ok(reports[0].protected_bytes >= (await stat(task)).size);
    assert.deepEqual(reports[0].unreconciled_capsules, []);
  }
  const record = join(workerLease.capsule_root, "descendants", `${basename(leafLease.capsule_root)}.json`);
  assert.deepEqual(JSON.parse(await readFile(record, "utf8")), { capsule_root: leafLease.capsule_root, pid: leafLease.child_pid });
  assert.deepEqual(await pi.reload(), { persona_id: "parent", switch_mode: "confirm" });
  assert.equal(await readFile(lock, "utf8"), ownership);
  assert.equal((await snapshot()).run_epoch, accepted.run_epoch);

  const afterLeaf = f.requests.length;
  leaf.reply("Grandchild result for the consuming turn");
  const consuming = await f.provider(afterLeaf, "Grandchild result for the consuming turn");
  assert.equal(consuming.payload.model, "worker");
  assert.equal((await snapshot()).status, "running", "a recorded but unconsumed callback cannot release the child barrier");
  const final = pi.frames.length;
  const afterWorker = f.requests.length;
  consuming.reply("Worker final result after consuming grandchild");
  const callback = await f.provider(afterWorker, "Worker final result after consuming grandchild");
  assert.equal(callback.payload.model, "parent");
  callback.reply("Root observed the worker callback");
  await pi.settled(final);
  const { messages } = await pi.rpc("get_messages");
  const callbacks = messages.filter((message: { customType?: string }) => message.customType === "larva-subagent-result");
  assert.equal(callbacks.length, 1);
  assert.equal(callbacks[0].details.callback_id, accepted.run_epoch);
  assert.equal(callbacks[0].details.result_text, "Worker final result after consuming grandchild");
  const childEntries = (await readFile(accepted.task_id, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(childEntries.filter(entry => entry.customType === "larva-subagent-result").map(entry => entry.details.callback_id), [grandchild.run_epoch]);
  for (const id of [accepted.task_id, grandchild.task_id]) await assert.rejects(access(`${id}.lock`), { code: "ENOENT" });
  assert.deepEqual(await readdir(join(f.home, "state", "capsules")), []);
  for (const { child_pid } of [workerLease, leafLease]) assert.throws(() => process.kill(child_pid, 0), { code: "ESRCH" });
}, { aliasedHome: base === "relative" }));

test("real Pi uses projected auth and resources, returns empty text, and reports native startup failures", { timeout: 30_000 }, () => fixture(async f => {
  const base = dirname(f.modelCatalog), auth = join(base, "auth.json");
  const catalog = JSON.parse(await readFile(f.modelCatalog, "utf8"));
  delete catalog.providers.fixture.apiKey;
  const redactionProbe = "sk-fixture_provider";
  catalog.providers[redactionProbe] = catalog.providers.fixture;
  await writeFile(f.modelCatalog, JSON.stringify(catalog));
  // The fixture's child environment is an explicit allowlist with no API key variables.
  const credential = { type: "api_key", key: "local-test-auth-file-only" };
  const credentials = JSON.stringify({ fixture: credential });
  await writeFile(auth, credentials, { mode: 0o600 });
  const agents = join(base, "AGENTS.md"), skills = join(base, "skills");
  await mkdir(skills);
  await writeFile(agents, "Fixture global instructions marker");
  await writeFile(join(skills, "probe.md"), "---\nname: probe\ndescription: Fixture skill discovery marker\n---\nA fixture skill.");

  const peer = join(base, "prompt-peer.mjs"), promptReceipt = join(base, "prompt-reply.json");
  await writeFile(peer, `import { writeFile } from 'node:fs/promises';
export default pi => pi.on('before_provider_request', async () => {
  const replies = [];
  pi.events.emit('larva:resolve-system-prompt:v1', {
    scope: 'main', systemPrompt: 'Peer base', reply: value => replies.push(value),
  });
  await writeFile(${JSON.stringify(promptReceipt)}, JSON.stringify(replies));
});`);
  await f.config({ subagent: { extension_sources: [peer] } });
  const mcp = f.mcp();
  await mcp.initialize();
  const args = { persona_id: "worker", cwd: f.cwd };
  const receipt = await mcp.ok(spawn, { ...args, task: "Return no assistant text" });
  const request = await f.provider(0, "Return no assistant text");
  assert.equal(request.payload.model, "worker");
  const messages = JSON.stringify(request.payload.messages);
  assert.match(messages, /Fixture global instructions marker/);
  assert.match(messages, /Fixture skill discovery marker/);
  const replies = JSON.parse(await readFile(promptReceipt, "utf8"));
  assert.equal(replies.length, 1);
  assert.equal(replies[0].status, "ok");
  assert.match(replies[0].systemPrompt, /^Peer base\n\n[\s\S]*E2E identity worker/);
  assert.doesNotMatch(replies[0].systemPrompt, /Use larva_persona_switch/);
  const { capsule_root } = JSON.parse(await readFile(`${receipt.task_id}.lock/lease.json`, "utf8"));
  for (const path of [auth, agents, skills]) assert.equal(await readlink(join(capsule_root, "agent", basename(path))), path);
  assert.equal((await lstat(auth)).mode & 0o777, 0o600);
  request.reply("");
  const { terminal_outputs } = await mcp.ok("larva_subagent_wait", { task_ids: [receipt.task_id] });
  const terminal = terminal_outputs[receipt.task_id];
  assert.deepEqual([terminal.status, terminal.output_state, terminal.result_text], ["success", "inline", ""]);
  await mcp.ok("larva_subagent_cancel", { task_ids: [receipt.task_id], reason: "Join child cleanup" });
  assert.equal(await readFile(auth, "utf8"), credentials);

  // This catalog entry has no credential. Pi can verify the route, but the
  // native prompt preflight must reject without contacting the provider.
  const worker = JSON.parse(await readFile(f.personaFile("worker"), "utf8"));
  await writeFile(f.personaFile("worker"), JSON.stringify({ ...worker, model: `${redactionProbe}/worker` }));
  const missing = await mcp.call(spawn, { ...args, task: "Reject at preflight with missing auth" });
  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent.error.code, "LARVA_CHILD_PROTOCOL_FAILED");
  const diagnostic = missing.structuredContent.error.message;
  assert.match(diagnostic, /^Child rejected prompt: No API key found for \[REDACTED\]/);
  assert.doesNotMatch(diagnostic, /[\r\n]|sk-fixture_provider|local-test-auth-file-only/);
  assert.equal(f.requests.length, 1, "missing auth must reject before requesting the provider");

  // Inject a structured startup failure in a real Pi extension. A launched
  // child takes its route from the CLI; it does not activate it in Larva init.
  const failStartup = join(base, "fail-startup.mjs");
  await writeFile(failStartup, `export default pi => pi.on('session_start', () => {
    const error = { code: 'LARVA_MODEL_UNAVAILABLE', message: 'Fixture startup model unavailable. password=fixture-only' };
    process.stderr.write(JSON.stringify({ ok: false, error }) + '\\n', () => process.exit(2));
  });`);
  await f.config({ subagent: { extension_sources: [failStartup] } });
  const startup = await mcp.call(spawn, { ...args, task: "Fail at persona startup" });
  assert.equal(startup.isError, true, JSON.stringify(startup));
  assert.deepEqual(startup.structuredContent.error, { code: "LARVA_MODEL_UNAVAILABLE",
    message: "Fixture startup model unavailable. [REDACTED]" });
  assert.equal(f.requests.length, 1);
  assert.deepEqual(await readdir(join(f.home, "state", "capsules")), []);
}, { modelsOnly: true }));

// The closed wire schema has no faster legal settings. Drive both real
// deadlines from a silent local provider, not sleeps or a replaced timer.
test("real Pi observes one soft stall alert, then the hard no-progress watchdog cancels and reaps", { timeout: 150_000 }, () => fixture(async f => {
  const pi = f.pi(["--larva-persona", "parent"]);
  const from = await pi.prompt("Start a silent real Pi run");
  (await f.provider(0, "Start a silent real Pi run")).reply(launch("worker", "Hold until the watchdog cancels", {
    stall_alert_ms: 60_000, no_progress_timeout_ms: 120_000,
  }));
  const accepted = await pi.toolResult(from, spawn);
  assert.equal(accepted.status, "accepted", JSON.stringify(accepted));
  const held = await f.provider(1, "Hold until the watchdog cancels");
  assert.equal(held.payload.model, "worker");
  const { child_pid } = JSON.parse(await readFile(`${accepted.task_id}.lock/lease.json`, "utf8"));
  (await f.provider(1, accepted.task_id)).reply("Root idle while child is silent");
  await pi.settled(from);
  const alert = await pi.frame(from, "message_end", e => e.message?.customType === "larva-subagent-alert", 75_000);
  assert.equal(alert.message.details.run_epoch, accepted.run_epoch);
  assert.equal(alert.message.details.phase, "stall_suspected");
  const status = (await pi.command(`/larva-subagent ${accepted.task_id}`)).runs[0];
  assert.equal(status.status, "running");
  assert.equal(status.phase, "stall_suspected");
  assert.equal(f.requests.length, 3, "soft stall alert must not itself trigger a model turn");
  assert.deepEqual(await pi.reload(), { persona_id: "parent", switch_mode: "confirm" });
  const rebound = (await pi.command(`/larva-subagent ${accepted.task_id}`)).runs[0];
  assert.equal(rebound.run_epoch, accepted.run_epoch);
  assert.equal(rebound.phase, "stall_suspected");

  // At reload the run has already consumed about half its hard deadline.
  // This bound accepts the original deadline but not a fresh 120s timer.
  const cancelled = await pi.frame(from, "message_end", e => e.message?.customType === "larva-subagent-result", 75_000);
  assert.equal(cancelled.message.details.callback_id, accepted.run_epoch);
  assert.equal(cancelled.message.details.status, "cancelled");
  assert.equal(cancelled.message.details.error.code, "LARVA_CHILD_CANCELLED");
  assert.match(cancelled.message.details.error.message, /no-progress timeout/);
  (await f.provider(2, "Larva subagent cancelled")).reply("Root observed hard timeout");
  await pi.settled(pi.frames.indexOf(cancelled));
  await held.waitClosed();
  assert.equal(pi.frames.filter(e => e.type === "message_end" && e.message?.customType === "larva-subagent-alert").length, 1);
  assert.throws(() => process.kill(child_pid, 0), { code: "ESRCH" });
  await assert.rejects(access(`${accepted.task_id}.lock`), { code: "ENOENT" });
}));
