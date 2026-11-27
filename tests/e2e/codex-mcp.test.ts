import assert from "node:assert/strict";
import { access, mkdir, readFile, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { fixture, tool } from "./fixture.ts";

const spawn = "larva_subagent", wait = "larva_subagent_wait", cancel = "larva_subagent_cancel",
  status = "larva_subagent_status", activity = "larva_subagent_activity", panel = "larva_subagent_panel";
const worker = { persona_id: "worker" };
const lease = async (id: string) => JSON.parse(await readFile(`${id}.lock/lease.json`, "utf8"));
const header = (cwd: string) => `${JSON.stringify({ type: "session", version: 3, id: "fixture", cwd })}\n`;
const age = async (path: string) => {
  const old = new Date(Date.now() - 3 * 86_400_000);
  await utimes(path, old, old);
};

test("external-cache MCP uses singleton roots, recorded resume cwd and contained real Pi activity", { timeout: 30_000 }, () => fixture(async f => {
  const mcp = f.mcp();
  await mcp.initialize();
  const good = pathToFileURL(f.cwd).href, missing = pathToFileURL(join(f.host, "missing")).href;
  for (const roots of [[], [good, missing], [missing], ["https://example.com/workspace"]]) {
    mcp.setRoots(...roots);
    await mcp.error(spawn, { ...worker, task: "must never reach Pi" }, "LARVA_CWD_REQUIRED");
  }
  assert.equal(mcp.rootsCalls(), 4);
  assert.equal(f.requests.length, 0);

  mcp.setRoots(good);
  await writeFile(join(f.cwd, "probe.txt"), "authorized workspace contents\n");
  await writeFile(join(f.host, "probe.txt"), "MCP host decoy contents\n");
  const accepted = await mcp.ok(spawn, { ...worker, task: "Read the relative workspace probe" });
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.cwd, f.cwd);
  assert.equal(mcp.rootsCalls(), 5);
  const request = await f.provider(0, "Read the relative workspace probe");
  assert.match(JSON.stringify(request.payload.messages[0]), /E2E identity worker/);
  request.reply([tool("read", { path: "probe.txt" })]);
  const result = await f.provider(1, "authorized workspace contents");
  assert.doesNotMatch(result.last, /MCP host decoy/);
  result.reply("Read from the rooted workspace");
  const id: string = accepted.task_id;
  const completed = await mcp.ok(wait, { task_ids: [id] });
  assert.equal(completed.terminal_outputs[id].result_text, "Read from the rooted workspace");
  assert.equal(completed.runs[0].run_epoch, accepted.run_epoch);
  await mcp.ok(cancel, { task_ids: [id], reason: "Join ownership cleanup" });
  assert.ok((await readFile(id, "utf8")).startsWith('{"type":"session"'));
  const evidence = await mcp.ok(activity, { task_id: id, tool_name: "read" });
  assert.equal(evidence.status, "success");
  assert.equal(evidence.items.length, 1);
  assert.match(evidence.items[0].result, /authorized workspace contents/);
  const readCall = completed.runs[0].tool_snapshots.find((call: { name: string }) => call.name === "read");
  assert.equal(readCall?.status, "done");
  assert.equal(readCall.tool_call_id, evidence.items[0].call_id);
  const detail = (segment_part: "args" | "result") => mcp.ok(activity, { task_id: id, tool_call_id: readCall.tool_call_id, segment_part });
  const args = (await detail("args")).call.segment;
  assert.equal(args.part, "args");
  assert.deepEqual(JSON.parse(args.text), { path: "probe.txt" });
  const recorded = (await detail("result")).call.segment;
  assert.equal(recorded.part, "result");
  assert.match(recorded.text, /authorized workspace contents/);

  const escaped = join(f.sessions, "escaped.jsonl"), outside = join(f.host, "outside.jsonl"), relative = join(f.sessions, "relative.jsonl");
  const alias = join(f.sessions, "alias.jsonl"), aliasedHomeId = join(f.configuredHome, "state", "sessions", basename(id));
  const missingId = join(f.sessions, "missing.jsonl"), directoryAlias = join(f.sessions, "alias-dir");
  await symlink(id, alias);
  await symlink(f.sessions, directoryAlias, "dir");
  const pin = (task_id: string) => ({ task_id, run_epochs: { [task_id]: accepted.run_epoch } });
  for (const [task_id, code] of [[alias, "LARVA_SESSION_INVALID"], [aliasedHomeId, "LARVA_SESSION_INVALID"],
    [join(directoryAlias, "missing.jsonl"), "LARVA_SESSION_INVALID"], [missingId, "LARVA_SESSION_NOT_FOUND"]]) {
    for (const tool of [status, activity, panel]) await mcp.error(tool, { task_id }, code);
    await mcp.error(spawn, { ...worker, task_id, task: "Rejected exact handle" }, code);
    if (code === "LARVA_SESSION_INVALID") await mcp.error(panel, pin(task_id), code);
    await assert.rejects(access(`${task_id}.lock`), { code: "ENOENT" });
  }
  assert.deepEqual(await mcp.ok(panel, pin(missingId)), { runs: [], startup_failures: [], terminal_outputs: {} });
  assert.equal((await mcp.ok(status, { task_id: id })).runs[0].task_id, id);
  assert.equal((await mcp.ok(panel, { task_id: id })).runs[0].task_id, id);
  assert.equal((await mcp.ok(panel, pin(id))).runs[0].run_epoch, accepted.run_epoch);
  const moved = join(f.sessions, "moved.jsonl");
  await rename(id, moved);
  await symlink(moved, id);
  await mcp.error(panel, pin(id), "LARVA_SESSION_INVALID");
  await rm(id);
  assert.equal((await mcp.ok(panel, { task_id: id })).runs[0].run_epoch, accepted.run_epoch);
  const retained = await mcp.ok(panel, pin(id));
  assert.equal(retained.terminal_outputs[id].result_text, "Read from the rooted workspace");
  await rename(moved, id);
  // A byte-identical, valid transcript just outside the real containment boundary.
  await writeFile(outside, await readFile(id));
  await symlink(outside, escaped);
  await writeFile(relative, header(".")); // Resolves to a real directory if a relative path is accidentally admitted.
  await mcp.error(activity, { task_id: escaped }, "LARVA_SESSION_INVALID");
  await mcp.error(status, { task_id: escaped }, "LARVA_SESSION_INVALID");
  assert.deepEqual((await mcp.ok(status, { scope: "disk" })).disk_sessions, [
    { task_id: id, cwd: f.cwd, cwd_exists: true, lock_state: "unlocked" },
  ]);
  await mcp.error(spawn, { ...worker, task_id: relative, task: "must not resolve relative header" }, "LARVA_SESSION_INVALID");
  await mcp.error(spawn, { ...worker, task_id: id, cwd: f.host, task: "must not override recorded workspace" }, "LARVA_BAD_INPUT");
  assert.equal(f.requests.length, 2);

  mcp.setRoots(pathToFileURL(f.host).href);
  const resume = await mcp.ok(spawn, { ...worker, task_id: id, task: "Resume in recorded workspace" });
  assert.equal(resume.cwd, f.cwd);
  assert.equal(resume.task_id, id);
  assert.notEqual(resume.run_epoch, accepted.run_epoch);
  assert.equal(mcp.rootsCalls(), 5, "resume must not consult roots");
  (await f.provider(2, "Resume in recorded workspace")).reply([tool("read", { path: "probe.txt" })]);
  (await f.provider(3, "authorized workspace contents")).reply("Resume read the original workspace");
  assert.equal((await mcp.ok(wait, { task_ids: [id] })).terminal_outputs[id].result_text, "Resume read the original workspace");
  assert.equal((await mcp.close()).code, 0);
}, { aliasedHome: true }));

test("MCP status tracks a live Pi tool evicted from display history until it ends", { timeout: 30_000 }, () => fixture(async f => {
  const names = Array.from({ length: 26 }, (_, index) => `call-${index}`);
  const gates = new Map(names.map(name => [`/${name}`, Promise.withResolvers<ServerResponse>()]));
  const server = createServer((request, response) => {
    const gate = gates.get(request.url ?? "");
    if (gate) gate.resolve(response);
    else response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const extension = join(f.host, "parallel.mjs"), name = "fixture_parallel";
    await writeFile(extension, `export default pi => pi.registerTool({
      name: '${name}', label: 'Parallel fixture', description: 'Wait for the test to release this call', executionMode: 'parallel',
      parameters: { type: 'object', properties: { gate: { type: 'string', enum: ${JSON.stringify(names)} } }, required: ['gate'] },
      async execute(_, { gate }, signal) {
        const reply = await fetch('http://127.0.0.1:${address.port}/' + gate, { signal });
        return { content: [{ type: 'text', text: await reply.text() }], details: {} };
      },
    });`);
    const agent = dirname(f.modelCatalog);
    await f.config({ subagent: { extension_sources: [join(agent, "provider.mjs"), extension] } });
    const mcp = f.mcp();
    await mcp.initialize();
    const task = "Execute 26 parallel fixture calls";
    const { task_id } = await mcp.ok(spawn, { ...worker, cwd: f.cwd, task });
    const { child_pid } = await lease(task_id);
    (await f.provider(0, task)).reply(names.map(gate => tool(name, { gate })));
    const deadline = AbortSignal.timeout(5_000);
    const reached = new AbortController();
    const [oldest, ...newer] = await Promise.race([
      Promise.all(names.map(gate => gates.get(`/${gate}`)!.promise)),
      once(deadline, "abort", { signal: reached.signal }).then(() => assert.fail("All 26 Pi tools must reach their gates concurrently")),
    ]).finally(() => reached.abort());
    const snapshot = async () => (await mcp.ok(status, { task_id })).runs[0];
    const observe = async (status: string) => {
      const deadline = performance.now() + 5_000;
      for (;;) {
        const run = await snapshot();
        if (run.tool_snapshots.length === 25 && run.tool_snapshots.every((call: { status: string }) => call.status === status)) return run;
        assert.ok(performance.now() < deadline, JSON.stringify(run));
        await delay(10);
      }
    };
    const running = await observe("running");
    assert.deepEqual(running.tool_snapshots.map((row: { args_preview: string }) => JSON.parse(row.args_preview).gate), names.slice(1));
    assert.equal(running.active_tool.tool_call_id, running.tool_snapshots.at(-1).tool_call_id);
    for (const response of newer) response.end("Newer tool completed");
    const partial = await observe("done");
    assert.equal(partial.status, "running");
    assert.equal(f.requests.length, 1, "the evicted tool still holds the tool batch open");
    assert.deepEqual(partial.active_tool, { tool_call_id: "e2e-0-0", name, status: "running" });
    oldest.end("Oldest tool completed");
    const continuation = await f.provider(1, "");
    const ended = await snapshot();
    assert.deepEqual(ended.tool_snapshots, partial.tool_snapshots);
    assert.equal(ended.status, "running", "the provider continuation is still held");
    assert.equal(ended.active_tool, null);
    continuation.reply("Parallel calls completed");
    assert.equal((await mcp.ok(wait, { task_ids: [task_id] })).terminal_outputs[task_id].status, "success");
    assert.equal((await mcp.close()).code, 0);
    assert.throws(() => process.kill(child_pid, 0), { code: "ESRCH" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}));

test("base models.json alone supplies doctor, native Pi, and the bundled MCP child route", { timeout: 30_000 }, () => fixture(async f => {
  const catalog = await readFile(f.modelCatalog);
  const doctor = f.doctor();
  assert.deepEqual(await doctor.exited(), { code: 0, signal: null, stderr: "" });
  assert.equal(doctor.frames[0].ok, true);
  assert.equal(doctor.frames[0].data.personas_checked, 3);
  assert.deepEqual(doctor.frames[0].data.diagnostics, []);
  const pi = f.pi(["--model", "fixture/worker", "--thinking", "off"]);
  assert.deepEqual(await pi.route(), ["fixture", "worker", "off"]);
  assert.equal((await pi.close()).code, 0);

  const mcp = f.cliMcp();
  await mcp.initialize();
  const run = await mcp.ok(spawn, { ...worker, cwd: f.cwd, task: "Use only the base model catalog" });
  assert.equal(run.status, "accepted");
  const { capsule_root } = await lease(run.task_id);
  const capsuleCatalog = join(capsule_root, "agent", "models.json");
  assert.deepEqual(await readFile(capsuleCatalog), catalog);
  assert.equal((await stat(capsuleCatalog)).mode & 0o777, 0o600);
  const request = await f.provider(0, "Use only the base model catalog");
  assert.equal(request.payload.model, "worker");
  request.reply("Model catalog route worked");
  assert.equal((await mcp.ok(wait, { task_ids: [run.task_id] })).terminal_outputs[run.task_id].result_text, "Model catalog route worked");
  assert.equal((await mcp.close()).code, 0);
  await assert.rejects(access(capsule_root), { code: "ENOENT" });
  assert.deepEqual(await readFile(f.modelCatalog), catalog);
}, { modelsOnly: true }));

test("two real MCP processes serialize resume, live leases beat GC, and dead-owner leases are reclaimed", { timeout: 30_000 }, () => fixture(async f => {
  const clients = [f.mcp(), f.mcp()];
  await Promise.all(clients.map(c => c.initialize()));
  const seed = await clients[0].ok(spawn, { ...worker, cwd: f.cwd, task: "Seed lease contention transcript" });
  const id: string = seed.task_id;
  (await f.provider(0, "Seed lease contention transcript")).reply("Lease transcript seeded");
  await clients[0].ok(wait, { task_ids: [id] });
  await clients[0].ok(cancel, { task_ids: [id], reason: "Join seed cleanup" });
  await assert.rejects(access(`${id}.lock`), { code: "ENOENT" });

  const race = await Promise.all(clients.map(c => c.call(spawn, { ...worker, task_id: id, task: "Hold sole resume owner" })));
  const owner = race.findIndex(r => !r.isError);
  assert.notEqual(owner, -1, JSON.stringify(race));
  assert.equal(race[1 - owner].isError, true);
  assert.equal(race[1 - owner].structuredContent.error.code, "LARVA_SESSION_BUSY");
  const live = await f.provider(1, "Hold sole resume owner");
  assert.equal(f.requests.length, 2, "only the winner prompts a real Pi");
  const before = await lease(id);
  assert.equal(before.owner_pid, clients[owner].child.pid);
  assert.equal(before.state, "running");
  assert.ok(Number.isInteger(before.child_pid));
  assert.equal((await clients[1 - owner].ok(status, { scope: "disk" })).disk_sessions[0].lock_state, "active_external");
  await age(id);
  const gc = f.gc();
  assert.equal((await gc.close()).code, 0);
  assert.equal(gc.frames[0].ok, true);
  assert.equal(gc.frames[0].data.deleted_sessions, 0);
  assert.equal(gc.frames[0].data.protected_bytes, (await stat(id)).size);
  assert.deepEqual(await lease(id), before);
  const result = await clients[owner].ok(cancel, { task_ids: [id], reason: "Release contention winner" });
  assert.deepEqual(result.results, [{ task_id: id, outcome: "cancelled" }]);
  await live.waitClosed();
  await assert.rejects(access(`${id}.lock`), { code: "ENOENT" });
  assert.throws(() => process.kill(before.child_pid, 0), { code: "ESRCH" });

  // Model the durable pre-spawn crash state with a positively reaped process:
  // 'reserving' guarantees no child PID or capsule ever existed.
  const dead = gc.child.pid;
  assert.ok(dead);
  assert.throws(() => process.kill(dead, 0), { code: "ESRCH" });
  await mkdir(`${id}.lock`, { mode: 0o700 });
  await writeFile(`${id}.lock/lease.json`, JSON.stringify({ lease_id: "dead-reserver", state: "reserving",
    owner_pid: dead, child_pid: null, capsule_root: null }), { mode: 0o600 });
  const resumed = await clients[1 - owner].ok(spawn, { ...worker, task_id: id, task: "Hold reclaimed session" });
  assert.equal(resumed.task_id, id);
  assert.notEqual(resumed.run_epoch, race[owner].structuredContent.run_epoch);
  const after = await lease(id);
  assert.notEqual(after.lease_id, "dead-reserver");
  assert.equal(after.owner_pid, clients[1 - owner].child.pid);
  const final = await f.provider(2, "Hold reclaimed session");
  final.reply("Reclaimed and completed");
  assert.equal((await clients[1 - owner].ok(wait, { task_ids: [id] })).terminal_outputs[id].result_text, "Reclaimed and completed");
  await clients[1 - owner].ok(cancel, { task_ids: [id], reason: "Join final cleanup" });
  await age(id);
  const unprotected = f.gc();
  assert.equal((await unprotected.close()).code, 0);
  assert.equal(unprotected.frames[0].data.deleted_sessions, 1);
  await clients[owner].error(spawn, { ...worker, task_id: id, task: "GC won before this resume" }, "LARVA_SESSION_NOT_FOUND");
  await assert.rejects(access(`${id}.lock`), { code: "ENOENT" });
  for (const c of clients) assert.equal((await c.close()).code, 0);
}));

test("MCP stale epochs cannot cancel replacements; a live deep descendant retains ownership after supervisor exit", { timeout: 30_000 }, () => fixture(async f => {
  const mcp = f.mcp();
  await mcp.initialize();
  const seed = await mcp.ok(spawn, { ...worker, cwd: f.cwd, task: "Seed epoch replacement" });
  const id: string = seed.task_id;
  (await f.provider(0, "Seed epoch replacement")).reply("Epoch one complete");
  await mcp.ok(wait, { task_ids: [id] });
  await mcp.ok(cancel, { task_ids: [id], reason: "Join seed teardown" });
  const next = await mcp.ok(spawn, { ...worker, task_id: id, task: "Hold replacement epoch" });
  assert.notEqual(next.run_epoch, seed.run_epoch);
  const held = await f.provider(1, "Hold replacement epoch");
  const unrelated = await mcp.ok(spawn, { ...worker, cwd: f.cwd, task: "Hold unrelated run" });
  await f.provider(2, "Hold unrelated run");
  const cancellation = { task_ids: [id], reason: "User requested cancellation" };
  const guarded = await mcp.ok(cancel, { ...cancellation, expected_run_epochs: { [id]: seed.run_epoch } });
  assert.deepEqual(guarded.results, [{ task_id: id, outcome: "already_terminal" }]);
  const current = (await mcp.ok(status, { task_id: id })).runs[0];
  assert.equal(current.run_epoch, next.run_epoch);
  assert.equal(current.status, "running");

  const { capsule_root, lease_id, child_pid } = await lease(id);
  // Reconstruct the durable edges of a crashed two-hop subtree using real PIDs.
  // The intermediate has already exited; only the leaf prevents retention release.
  const intermediate = f.gc(true), leaf = f.pi();
  assert.equal((await intermediate.exited()).code, 0);
  assert.deepEqual((await leaf.route()).slice(0, 2), ["fixture", "native"]);
  const midPid = intermediate.child.pid, leafPid = leaf.child.pid;
  assert.ok(midPid && leafPid);
  assert.throws(() => process.kill(midPid, 0), { code: "ESRCH" });
  const capsules = join(f.home, "state", "capsules");
  const midRoot = join(capsules, `child-${child_pid}-aa`), leafRoot = join(capsules, `child-${midPid}-bb`);
  for (const root of [midRoot, leafRoot]) await mkdir(join(root, "descendants"), { recursive: true, mode: 0o700 });
  await writeFile(join(midRoot, "owner.json"), JSON.stringify({ owner_pid: child_pid, child_pid: midPid, state: "running" }));
  await writeFile(join(leafRoot, "owner.json"), JSON.stringify({ owner_pid: midPid, state: "spawning" }));
  await writeFile(join(leafRoot, "child_self.json"), JSON.stringify({ pid: leafPid }));
  const evidence = join(capsule_root, "descendants", `child-${child_pid}-aa.json`);
  await writeFile(evidence, JSON.stringify({ pid: midPid, capsule_root: midRoot }));
  await writeFile(join(midRoot, "descendants", `child-${midPid}-bb.json`), JSON.stringify({ capsule_root: leafRoot }));
  const declined = await mcp.call(cancel, { ...cancellation, expected_run_epochs: { [id]: next.run_epoch } });
  assert.equal(declined.isError, true);
  assert.deepEqual(declined.structuredContent.results, [{ task_id: id, outcome: "cleanup_unconfirmed" }]);
  await held.waitClosed();
  assert.throws(() => process.kill(child_pid, 0), { code: "ESRCH" });
  assert.equal((await lease(id)).lease_id, lease_id);
  assert.equal((await lease(id)).state, "unreconciled");
  assert.equal((await mcp.ok(status, { task_id: unrelated.task_id })).runs[0].status, "running");
  assert.deepEqual(await mcp.request("ping"), {});
  assert.equal(mcp.child.exitCode, null);
  assert.deepEqual(await mcp.close(), { code: 1, signal: null, stderr: "" });
  await access(evidence);
  await access(join(capsule_root, "owner.json"));
  await access(`${id}.lock/lease.json`);
  await assert.rejects(access(`${unrelated.task_id}.lock`), { code: "ENOENT" });

  await age(id);
  const competitor = f.mcp();
  await competitor.initialize();
  for (const dryRun of [true, false]) {
    const gc = f.gc(dryRun);
    assert.equal((await gc.exited()).code, 0);
    assert.equal(gc.frames[0].data.deleted_sessions, 0);
    assert.equal(gc.frames[0].data.protected_bytes, (await stat(id)).size + (await stat(unrelated.task_id)).size);
    assert.ok(gc.frames[0].data.unreconciled_capsules.includes(capsule_root));
    assert.equal((await lease(id)).lease_id, lease_id);
    for (const root of [capsule_root, midRoot, leafRoot]) await access(join(root, "owner.json"));
  }
  assert.equal((await competitor.ok(status, { task_id: id })).disk_sessions[0].lock_state, "unreconciled");
  await competitor.error(spawn, { ...worker, task_id: id, task: "Do not reclaim live deep leaf" }, "LARVA_SESSION_BUSY");
  assert.equal((await lease(id)).lease_id, lease_id);
  assert.equal((await leaf.close()).code, 0);
  assert.throws(() => process.kill(leafPid, 0), { code: "ESRCH" });
  assert.equal((await competitor.ok(status, { task_id: id })).disk_sessions[0].lock_state, "unlocked");
  for (const dryRun of [true, false]) {
    const gc = f.gc(dryRun);
    assert.equal((await gc.exited()).code, 0);
    assert.equal(gc.frames[0].data.deleted_sessions, 1);
    if (dryRun) await access(`${id}.lock/lease.json`);
  }
  for (const path of [id, `${id}.lock`, capsule_root, midRoot, leafRoot]) await assert.rejects(access(path), { code: "ENOENT" });
}));
