import assert from "node:assert/strict";
import { once } from "node:events";
import { unlinkSync } from "node:fs";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { RunOutbox, mintRunEpoch, terminalOutput } from "../../src/runtime/outbox.ts";
import { childSettlementBarrier } from "../../src/runtime/settlement-barrier.ts";
import { getNativeSupervisor, SubagentSupervisor, type NativeBinding } from "../../src/runtime/supervisor.ts";
import type { RunSnapshot, SubagentAcceptedReceipt } from "../../src/core/types.ts";
import { createSessionLeaseStore } from "../../src/store/session-lease.ts";
import * as capsule from "../../src/store/capsule.ts";

// A real owned Node subprocess with a test-only Pi protocol peer. Its separate control
// pipe lets tests park a specific RPC reply or emit a native event without sleeps.
const fakePi = `import { createConnection } from 'node:net';
import { writeFileSync } from 'node:fs';
const argv = process.argv.slice(2), arg = k => argv[argv.indexOf(k)+1];
const id = arg('--session');
try { writeFileSync(id, JSON.stringify({type:'session', version:3, cwd:process.cwd(), id:'test'})+'\\n',{flag:'wx'}); } catch(e) { if(e.code!=='EEXIST') throw e; }
const control = createConnection(process.env.TEST_SOCKET);
control.on('error', () => process.exit(2));
control.on('close', () => process.exit(0));
control.write(JSON.stringify({hello:true,id,argv,pid:process.pid,agentDir:process.env.PI_CODING_AGENT_DIR,baseAgentDir:process.env.LARVA_PI_BASE_AGENT_DIR,root:process.env.LARVA_PI_CAPSULE_ROOT,persona:process.env.LARVA_PI_INITIAL_PERSONA_ID,launched:process.env.LARVA_PI_LAUNCHED,home:process.env.LARVA_HOME,depth:process.env.LARVA_PI_SUBAGENT_DEPTH,ancestors:process.env.LARVA_PI_ANCESTOR_TASK_IDS})+'\\n');
control.pipe(process.stdout);
process.stdin.pipe(control,{end:false}); process.stdin.on('end',()=>{if(!process.env.TEST_IGNORE_EOF) control.end()});`;
const marker = { capability: "larva-child-rpc-frame-preload-v1", terminal: "agent_settled", framing: "lf-only", max_record_bytes: 1048576 };
type Frame = Record<string, any>;
type Peer = { hello: Frame; emit(frame: Frame): void; commands: Frame[] };
const input = { persona_id: "worker", task: "do work" };
const mcp = { surface: "mcp" as const };
const turn = () => new Promise<void>(r => setImmediate(r));
const err = (code: string) => ({ code });

type Options = ConstructorParameters<typeof SubagentSupervisor>[0];
async function fixture(fn: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "larva-supervisor-")));
  let f;
  try { f = await setup(home); await fn(f); }
  finally { try { await f?.close(); } finally { await rm(home, { recursive: true, force: true }); } }
}
async function setup(home: string) {
  const root = join(home, "state", "sessions"), work = join(home, "workspace"), agent = join(home, "agent");
  await Promise.all([root, work, agent, join(home, "personas"), join(home, "pi")].map(p => mkdir(p, { recursive: true, mode: 0o700 })));
  const config = (doc: unknown) => writeFile(join(home, "config.json"), JSON.stringify(doc));
  await writeFile(join(home, "personas", "worker.json"), JSON.stringify({ id: "worker", description: "Worker", prompt: "Work.", model: "local/one", can_spawn: true }));
  await writeFile(join(agent, "settings.json"), '{"theme":"dark"}');
  const script = join(home, "pi", "cli.mjs"), preload = join(home, "preload.mjs");
  await writeFile(join(home, "pi", "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: { pi: "cli.mjs" } }));
  await writeFile(script, fakePi);
  // The preload's production capsule-name compatibility is separately reported. This
  // protocol fixture does not purport to verify production preload installation.
  await writeFile(preload, `import { writeFileSync } from 'node:fs'; writeFileSync(process.env.LARVA_PI_CAPSULE_ROOT+'/child_self.json',JSON.stringify({pid:process.pid}),{flag:'wx'})`);
  const peers: Peer[] = [], sockets = new Set<Socket>();
  const hook: { command?: (q: Frame, peer: Peer, reply: (data?: Frame, success?: boolean) => void) => boolean | void } = {};
  const server = createServer(sock => {
    sockets.add(sock); sock.on("error", () => {}); sock.on("close", () => sockets.delete(sock));
    let peer: Peer, provider: string, model: string, thinking: string;
    createInterface({ input: sock }).on("line", line => {
      const q = JSON.parse(line);
      if (q.hello) {
        peer = { hello: q, commands: [], emit: frame => { sock.write(JSON.stringify(frame) + "\n"); } };
        peers.push(peer);
        const arg = (k: string) => q.argv[q.argv.indexOf(k) + 1];
        [provider, model] = arg("--model").split("/"); thinking = arg("--thinking"); return;
      }
      peer.commands.push(q);
      const reply = (data: Frame = {}, success = true) => peer.emit({ id: q.id, type: "response", command: q.type, success, data });
      if (hook.command?.(q, peer, reply)) return;
      switch (q.type) {
        case "get_state": return reply({ model: { provider, id: model }, sessionFile: peer.hello.id, persona_id: peer.hello.persona, thinkingLevel: thinking, larvaChildRpcFrame: marker });
        case "set_model": provider = q.provider; model = q.modelId; return reply();
        case "set_thinking_level": thinking = q.level; return reply();
        case "switch_session": return reply({ cancelled: false });
        case "prompt": return reply({ disposition: "started" });
        case "get_last_assistant_text": return reply({ text: `result-${peer.hello.pid}` });
        default: return reply();
      }
    });
  });
  const path = join(home, "control.sock"); server.listen(path); await once(server, "listening");
  const env: NodeJS.ProcessEnv = { HOME: home, TEST_SOCKET: path, LARVA_PI_CLI_SCRIPT: script, PI_CODING_AGENT_DIR: agent };
  const options = { home, env, extension: join(home, "extension.js"), preload };
  const supervisors = new Set<SubagentSupervisor>();
  const make = (opts?: Options) => { const s = new SubagentSupervisor({ ...options, ...opts }); supervisors.add(s); return s; };
  const native = (binding: NativeBinding) => { const s = getNativeSupervisor(options, binding); supervisors.add(s); return s; };
  const supervisor = make();
  const spawn = (extra = {}, s = supervisor) => s.spawn({ ...input, cwd: work, ...extra }, mcp) as Promise<SubagentAcceptedReceipt>;
  const header = (id: string, cwd: string) => writeFile(id, JSON.stringify({ type: "session", version: 3, cwd }) + "\n");
  return { home, root, work, agent, peers, hook, env, config, header, make, native, options, supervisor, spawn, async close() {
    try { await Promise.all([...supervisors].map(s => s.shutdown())); }
    finally {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r, j) => server.close(e => e ? j(e) : r()));
      for (const p of peers) assert.ok(capsule.pidExited(p.hello.pid), "RPC child was reaped");
    }
  } };
}

test("ordered admission: syntax, roots and recorded workspace precede lineage, config, authority, and lease", () => fixture(async f => {
  const { supervisor: s, env, work, root, config } = f;
  const id = join(root, "resume.jsonl");
  await config({ unknown: true }); env.LARVA_PI_SUBAGENT_DEPTH = "100";
  await assert.rejects(s.spawn({ ...input, no_progress_timeout_ms: 119999 }, mcp), err("LARVA_BAD_INPUT"));
  await assert.rejects(s.spawn({ ...input, stall_alert_ms: 120000, no_progress_timeout_ms: 120000 }, mcp), err("LARVA_BAD_INPUT"));
  await assert.rejects(s.spawn({ ...input, task_id: join(f.home, "escape.jsonl") }, mcp), err("LARVA_SESSION_INVALID"));
  for (const urls of [undefined, [], [pathToFileURL(work).href, pathToFileURL(join(work, "absent")).href], ["https://example.com/"], ["file:///nonexistent/larva-workspace"]]) {
    await assert.rejects(s.spawn(input, { ...mcp, ...(urls && { listRoots: async () => ({ roots: urls.map(uri => ({ uri })) }) }) }), err("LARVA_CWD_REQUIRED"));
  }
  await f.header(id, "relative"); await assert.rejects(s.spawn({ ...input, task_id: id }, mcp), err("LARVA_SESSION_INVALID"));
  await f.header(id, join(work, "missing")); await assert.rejects(s.spawn({ ...input, task_id: id }, mcp), err("LARVA_CHILD_START_FAILED"));
  await f.header(id, work); await assert.rejects(s.spawn({ ...input, task_id: id, cwd: root }, mcp), err("LARVA_BAD_INPUT"));
  await assert.rejects(f.spawn(), err("LARVA_CHILD_START_FAILED")); delete env.LARVA_PI_SUBAGENT_DEPTH;
  env.LARVA_PI_ANCESTOR_TASK_IDS = " ".repeat(65536) + "[]"; await assert.rejects(f.spawn(), err("LARVA_CHILD_START_FAILED"));
  env.LARVA_PI_ANCESTOR_TASK_IDS = JSON.stringify(Array.from({ length: 100 }, (_, i) => join(root, `${i}.jsonl`)));
  await assert.rejects(s.spawn({ ...input, cwd: work }, { ...mcp, selfTaskId: id }), err("LARVA_CHILD_START_FAILED"));
  const longDir = join(root, "a".repeat(190), "b".repeat(190), "c".repeat(190)); await mkdir(longDir, { recursive: true });
  // Set incoming UTF-8 bytes just below the limit; adding the current session crosses it, even with <=100 paths.
  const paths: string[] = [];
  for (let i = 0; i < 99; i++) {
    const path = join(longDir, `${i}-${"é".repeat(40)}.jsonl`);
    if (Buffer.byteLength(JSON.stringify([...paths, path])) > 65536) break;
    paths.push(path);
  }
  env.LARVA_PI_ANCESTOR_TASK_IDS = JSON.stringify(paths);
  const selfTaskId = join(longDir, `${"z".repeat(200)}.jsonl`);
  assert.ok(paths.length < 100 && Buffer.byteLength(JSON.stringify([...paths, selfTaskId])) > 65536);
  await assert.rejects(s.spawn({ ...input, cwd: work }, { ...mcp, selfTaskId }), err("LARVA_CHILD_START_FAILED"));
  delete env.LARVA_PI_ANCESTOR_TASK_IDS; await assert.rejects(f.spawn(), err("LARVA_CONFIG_INVALID"));
  await config({ subagent: { max_depth: 1 } }); env.LARVA_PI_SUBAGENT_DEPTH = "1"; await assert.rejects(f.spawn(), err("LARVA_SPAWN_NOT_ALLOWED"));
  await config({}); await assert.rejects(f.spawn(), err("LARVA_SPAWN_NOT_ALLOWED")); delete env.LARVA_PI_SUBAGENT_DEPTH;
  await assert.rejects(s.spawn(input, { surface: "pi", cwd: work, sessionKey: "a", activePersona: null }), err("LARVA_NO_ACTIVE_PERSONA"));
  env.LARVA_PI_ANCESTOR_TASK_IDS = JSON.stringify([id]); await assert.rejects(f.spawn({ task_id: id }), err("LARVA_SESSION_BUSY")); delete env.LARVA_PI_ANCESTOR_TASK_IDS;
  const lease = await createSessionLeaseStore(f.home, capsule).acquire(id);
  try { await assert.rejects(f.spawn({ task_id: id }), err("LARVA_SESSION_BUSY")); } finally { await lease.release(); }
  await config({ subagent: { max_active_runs: 1 } });
  const receipt = await s.spawn(input, { ...mcp, listRoots: async () => ({ roots: [{ uri: pathToFileURL(work).href }] }) });
  assert.equal((receipt as SubagentAcceptedReceipt).cwd, work); await assert.rejects(f.spawn(), err("LARVA_CHILD_START_FAILED"));
  const p = f.peers[0].hello;
  assert.equal(p.home, f.home); assert.equal(p.launched, "1"); assert.equal(p.persona, "worker"); assert.equal(p.depth, "1"); assert.equal(p.agentDir, p.root); assert.equal(p.baseAgentDir, f.agent);
  assert.equal(await readFile(join(p.agentDir, "settings.json"), "utf8"), '{"theme":"dark"}');
  assert.equal((await lstat(join(p.agentDir, "settings.json"))).mode & 0o777, 0o600);
  assert.equal(f.peers.length, 1); assert.ok((await s.status()).startup_failures.length > 0);
  const disk = await s.status({ scope: "disk" }); assert.equal(disk.disk_sessions?.find(x => x.task_id === receipt.task_id)?.lock_state, "active_local");
  assert.equal((await s.status({ task_id: id })).disk_sessions?.[0].cwd, work);
}));

test("exact status preserves observed missing handles but rejects an installed alias at the same path", () => fixture(async f => {
  const active = await f.spawn();
  const id = active.task_id, moved = join(f.root, "moved.jsonl");
  await rename(id, moved);
  assert.equal((await f.supervisor.status({ task_id: id })).runs[0].run_epoch, active.run_epoch);
  await symlink(moved, id);
  await assert.rejects(f.supervisor.status({ task_id: id }), err("LARVA_SESSION_INVALID"));
  const aliasDir = join(f.root, "alias-dir");
  await symlink(f.root, aliasDir, "dir");
  await assert.rejects(f.supervisor.status({ task_id: join(aliasDir, "unobserved.jsonl") }), err("LARVA_SESSION_INVALID"));
  await assert.rejects(f.supervisor.status({ task_id: join(f.root, "unobserved.jsonl") }), err("LARVA_SESSION_NOT_FOUND"));
}));

test("resume reopens the transcript under lease after an unlink wins the admission race", () => fixture(async f => {
  const id = join(f.root, "removed.jsonl"); await f.header(id, f.work);
  const off = f.supervisor.subscribe(() => { off(); unlinkSync(id); }); // after cwd read and slot reservation, before lock install
  try { await assert.rejects(f.spawn({ task_id: id }), err("LARVA_SESSION_NOT_FOUND")); } finally { off(); }
  assert.deepEqual(await readdir(f.root), []); assert.equal(f.peers.length, 0);
}));

test("explicit base Pi directory overrides inherited directories without changing child isolation", () => fixture(async f => {
  const env = { ...f.env, LARVA_PI_BASE_AGENT_DIR: join(f.home, "wrong-base"), PI_CODING_AGENT_DIR: join(f.home, "wrong-private") };
  const s = f.make({ env, piAgentDir: relative(process.cwd(), f.agent) });
  await f.spawn({}, s);
  const { baseAgentDir, agentDir, root } = f.peers[0].hello;
  assert.equal(baseAgentDir, f.agent);
  assert.equal(agentDir, root);
  assert.notEqual(agentDir, baseAgentDir);
  assert.equal(await readFile(join(agentDir, "settings.json"), "utf8"), '{"theme":"dark"}');
}));

test("mismatched preload/route and rejected or handled prompts never produce an accepted receipt", () => fixture(async f => {
  for (const mode of ["marker", "route", "handled", "rejected"]) {
    f.hook.command = (q, p, reply) => {
      if (q.type === "get_state" && (mode === "marker" || mode === "route")) {
        reply({ sessionFile: p.hello.id, persona_id: "worker", model: { provider: "x", id: "two" }, thinkingLevel: "medium", larvaChildRpcFrame: mode === "route" ? marker : { ...marker, terminal: "agent_end" } }); return true;
      }
      if (q.type === "prompt") { reply({ disposition: "handled" }, mode !== "rejected"); return true; }
    };
    await assert.rejects(f.spawn(), err(mode === "route" ? "LARVA_MODEL_UNAVAILABLE" : "LARVA_CHILD_PROTOCOL_FAILED"));
    assert.deepEqual(await readdir(join(f.home, "state", "capsules")), []);
    assert.ok(!(await readdir(f.root)).some(p => p.endsWith(".lock")));
  }
}));

test("callback barrier requires the consuming assistant settlement; alerts and failed/stale/suppressed callbacks cannot park it", () => {
  const barrier = childSettlementBarrier(); let transform!: (record: string) => readonly string[];
  const emitted: string[] = [], branch: unknown[] = [];
  barrier.bind({ configure(f) { transform = f; }, emit(lines) { emitted.push(...lines); } }, () => branch);
  const settled = '{"type":"agent_settled","aborted":false}', result = "larva-subagent-result";
  barrier.register("larva-subagent-alert", "alert"); assert.deepEqual(transform(settled), [settled]);
  barrier.register(result, "one"); barrier.register(result, "two"); barrier.delivery("one", "delivered");
  branch.push({ type: "message", message: { role: "assistant" } }, { type: "custom_message", customType: result, details: { callback_id: "one" } });
  assert.deepEqual(transform(settled), []); barrier.delivery("two", "stale"); assert.deepEqual(emitted, []);
  branch.push({ type: "message", message: { role: "assistant" } }); assert.deepEqual(transform(settled), [settled]);
  for (const state of ["failed", "suppressed", "stale"] as const) { barrier.register(result, state); assert.deepEqual(transform(settled), []); barrier.delivery(state, state); }
  assert.deepEqual(emitted, [settled, settled, settled]);
});

test("an idle continuation wakes a queued callback once but cannot acknowledge it", async () => {
  const b = childSettlementBarrier(); let transform!: (s: string) => readonly string[], wakes = 0;
  const emitted: string[] = [], end = '{"type":"agent_settled","aborted":false}';
  b.bind({ configure(f) { transform = f; }, emit(v) { emitted.push(...v); } }, () => [], () => "worker", { isIdle: () => true, triggerTurn() { wakes++; } });
  const state = transform(JSON.stringify({ type: "response", command: "get_state", success: true, data: { larvaChildRpcFrame: marker } }));
  assert.deepEqual(JSON.parse(state[0]).data, { persona_id: "worker", larvaChildRpcFrame: marker });
  b.register("larva-subagent-result", "result"); assert.deepEqual(transform(end), []); await turn(); assert.equal(wakes, 0);
  b.delivery("result", "delivered"); await turn(); assert.equal(wakes, 1);
  assert.deepEqual(transform(end), []); await turn(); assert.equal(wakes, 1); assert.deepEqual(emitted, []);
  b.delivery("result", "failed"); assert.deepEqual(emitted, [end]);
});

test("outbox evicts exactly the 26th-oldest epoch; a late write cannot resurrect it", () => {
  const out = new RunOutbox(); const epochs: RunSnapshot[] = [];
  for (let i = 0; i < 26; i++) {
    const s: RunSnapshot = { task_id: "/same.jsonl", run_epoch: mintRunEpoch(), cwd: "/", persona_id: "a", status: "success", phase: "success", started_at: "", updated_at: "", output_state: "pending" };
    epochs.push(s); out.retain(s); out.publish(s, { output_state: "inline", result_text: String(i) });
  }
  out.publish(epochs[0], { output_state: "inline", result_text: "late" }); assert.equal(epochs[0].output_state, "evicted"); assert.equal(epochs[0].result_text, undefined);
  assert.equal(out.recent().length, 25); assert.equal(out.lookup("/same.jsonl", epochs[0].run_epoch), undefined);
  const original = out.lookup("/same.jsonl", epochs[1].run_epoch)!; terminalOutput(original).result_text = "changed"; assert.equal(terminalOutput(original).result_text, "1");
});

test("wait binds at ingress across same-task resume and uses one deadline even during output delivery", () => fixture(async f => {
  const block = Promise.withResolvers<void>();
  const s = f.make({ writeOutput: async (_, text) => { await block.promise; return { output_state: "inline", result_text: text }; } });
  try {
    const a = await f.spawn({}, s), b = await f.spawn({}, s);
    const both = s.wait({ task_ids: [a.task_id, b.task_id], timeout_ms: 3000 }, "pi");
    const waiting = s.wait({ task_ids: [a.task_id], timeout_ms: 70 });
    f.peers[0].emit({ type: "agent_end" }); f.peers[0].emit({ type: "agent_settled", aborted: false });
    const before = performance.now(), w = await waiting;
    assert.ok(w.ready); assert.ok(performance.now() - before < 800); assert.equal(w.runs[0].output_state, "pending");
    assert.equal(w.terminal_outputs?.[a.task_id].output_state, "pending");
    // Join A's ownership cleanup (without waiting for the blocked artifact writer).
    assert.equal((await s.cancel({ task_ids: [a.task_id], reason: "already done" })).results[0].outcome, "already_terminal");
    const next = await f.spawn({ task_id: a.task_id }, s); assert.notEqual(next.run_epoch, a.run_epoch);
    assert.ok(f.peers[2].commands.some(q => q.type === "switch_session"));
    const stale = await s.cancel({ task_ids: [a.task_id], reason: "stale", expected_run_epochs: { [a.task_id]: a.run_epoch } });
    assert.equal(stale.results[0].outcome, "already_terminal"); assert.equal((await s.status({ task_id: a.task_id })).runs[0].status, "running");
    f.peers[1].emit({ type: "agent_settled", aborted: true });
    const r = await both; assert.deepEqual(r.runs.map(x => x.run_epoch), [a.run_epoch, b.run_epoch]); assert.deepEqual(r.runs.map(x => x.status), ["success", "cancelled"]);
    block.resolve(); await turn(); assert.equal((await s.pinned(a.task_id, a.run_epoch)).output_state, "inline");
  } finally { block.resolve(); }
}));

test("an artifact write failure is not a first_error execution failure", () => fixture(async f => {
  const s = f.make({ writeOutput: async () => { throw new Error("storage error"); } });
  const a = await f.spawn({}, s); f.peers[0].emit({ type: "agent_settled", aborted: false });
  const w = await s.wait({ task_ids: [a.task_id], return_when: "any" }); assert.equal(w.runs[0].output_state, "delivery_failed");
  const first = await s.wait({ task_ids: [a.task_id], return_when: "first_error", timeout_ms: 0 }); assert.equal(first.ready, false); assert.equal(first.runs[0].status, "success");
}));

test("unconfirmed descendant cleanup preserves lease and capsule evidence without interrupting another run", () => fixture(async f => {
  const a = await f.spawn(), b = await f.spawn(); const box = f.peers[0].hello.root;
  await writeFile(join(box, "descendants", "live.json"), JSON.stringify({ pid: process.pid }));
  const result = await f.supervisor.cancel({ task_ids: [a.task_id], reason: "cancel first" });
  assert.equal(result.isError, true); assert.equal(result.results[0].outcome, "cleanup_unconfirmed");
  for (const path of [join(box, "owner.json"), join(box, "descendants", "live.json"), `${a.task_id}.lock/lease.json`]) await access(path);
  assert.equal((await f.supervisor.status({ task_id: b.task_id })).runs[0].status, "running");
  assert.deepEqual(await f.supervisor.shutdown(), { settled: false });
  await rm(join(box, "descendants", "live.json"));
  assert.deepEqual(await f.supervisor.shutdown(), { settled: true });
  await assert.rejects(access(`${a.task_id}.lock`), err("ENOENT"));
}));

test("unresponsive child gets the 1500ms abort grace and is forcibly reaped", () => fixture(async f => {
  f.env.TEST_IGNORE_EOF = "1";
  const a = await f.spawn(); const before = performance.now();
  const c = await f.supervisor.cancel({ task_ids: [a.task_id], reason: "stop" });
  assert.ok(performance.now() - before >= 1450); assert.ok(f.peers[0].commands.some(q => q.type === "abort"));
  assert.equal(c.results[0].outcome, "cancelled"); assert.ok(capsule.pidExited(f.peers[0].hello.pid));
  await assert.rejects(access(`${a.task_id}.lock`), err("ENOENT"));
}));

test("supervisor admits only readable contained model-map targets", () => fixture(async f => {
  const target = join(f.home, "route.json"), profilePath = join(f.home, "model-map.profile.json");
  await writeFile(target, JSON.stringify({ models: { "local/one": { provider: "local", model_id: "two" } } }));
  await symlink(target, profilePath);
  await f.supervisor.commitProfile("profile");
  await f.spawn();
  assert.ok(f.peers[0].hello.argv.includes("local/two"));
  await rm(target);
  await assert.rejects(f.spawn(), err("LARVA_MODEL_MAP_INVALID"));
  await rm(profilePath);
  await symlink(tmpdir(), profilePath);
  await assert.rejects(f.spawn(), err("LARVA_MODEL_MAP_INVALID"));
  assert.equal(f.peers.length, 1);
}));

test("profile fence updates starting children only and reports a captured epoch that ended", () => fixture(async f => {
  await writeFile(join(f.home, "model-map.fast.json"), JSON.stringify({ models: { "local/one": { provider: "local", model_id: "two" } } }));
  const live = await f.spawn(), ended = await f.spawn();
  const hold = Promise.withResolvers<() => void>();
  f.hook.command = (q, p, reply) => {
    if (q.type !== "get_state") return;
    f.hook.command = undefined; hold.resolve(() => reply({ persona_id: "worker", model: { provider: "local", id: "one" }, sessionFile: p.hello.id, thinkingLevel: "medium", larvaChildRpcFrame: marker })); return true;
  };
  const starting = f.spawn(); const release = await hold.promise;
  const fleet = f.supervisor.captureFleet();
  await f.supervisor.cancel({ task_ids: [ended.task_id], reason: "finished before switch" });
  const switched = f.supervisor.commitProfile("fast", fleet); release(); const next = await starting;
  const rows = Object.fromEntries((await switched).map(r => [r.task_id, r.state]));
  assert.deepEqual(rows, { [ended.task_id]: "ended_during_switch", [live.task_id]: "in_flight_until_run_settles", [next.task_id]: "fenced_for_startup" });
  assert.ok(!f.peers[0].commands.some(q => q.type === "set_model")); assert.deepEqual(f.peers[2].commands.map(q => q.type), ["get_state", "set_model", "set_thinking_level", "get_state", "prompt"]);
  await f.spawn(); assert.ok(f.peers[3].hello.argv.includes("local/two"));
  const failedFence = Promise.withResolvers<() => void>();
  f.hook.command = (q, p, reply) => {
    if (q.type === "get_state") { failedFence.resolve(() => reply({ persona_id: "worker", model: { provider: "local", id: "two" }, sessionFile: p.hello.id, thinkingLevel: "medium", larvaChildRpcFrame: marker })); return true; }
    if (q.type === "set_model") { reply({}, false); return true; }
  };
  const rejected = assert.rejects(f.spawn(), err("LARVA_CHILD_PROTOCOL_FAILED"));
  const resume = await failedFence.promise; const switchedBack = f.supervisor.commitProfile("default"); resume();
  await rejected; assert.equal((await switchedBack).find(row => row.task_id === f.peers[4].hello.id)?.state, "failed");
  assert.ok(!f.peers[4].commands.some(q => q.type === "prompt"));
}));

test("native reload retains watchdog deadlines, progress episodes, epoch and one terminal callback", async t => fixture(async f => {
  const old: string[] = [], messages: Frame[] = [];
  const s = f.native({ sessionKey: "pi-a", steer(m) { old.push(m.customType); } });
  const ctx = { surface: "pi" as const, cwd: f.work, sessionKey: "pi-a", activePersona: { can_spawn: true } };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const receipt = await s.spawn({ ...input, no_progress_timeout_ms: 120000, stall_alert_ms: 60000 }, ctx);
    t.mock.timers.tick(59000); s.beginReload();
    const reloaded: typeof import("../../src/runtime/supervisor.ts") = await import(new URL("../../src/runtime/supervisor.ts?reload", import.meta.url).href);
    const rebound = reloaded.getNativeSupervisor(f.options, { sessionKey: "pi-a", steer(m) { messages.push(m); } });
    assert.equal((await rebound.status({ task_id: receipt.task_id })).runs[0].run_epoch, receipt.run_epoch);
    t.mock.timers.tick(1000); assert.deepEqual(messages.map(m => m.customType), ["larva-subagent-alert"]);
    t.mock.timers.tick(1000); assert.equal(messages.length, 1);
    // Wait for the real pipe to deliver the progress frame before advancing the watchdog clock.
    const progress = Promise.withResolvers<void>(); const off = s.subscribe(progress.resolve);
    try { f.peers[0].emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "new" } }); await progress.promise; } finally { off(); }
    assert.equal((await s.status({ task_id: receipt.task_id })).runs[0].phase, "waiting_for_child");
    t.mock.timers.tick(60000); assert.equal(messages.length, 2); s.beginReload(); t.mock.timers.tick(60000);
    const w = await s.wait({ task_ids: [receipt.task_id], return_when: "first_error" }); assert.equal(w.runs[0].error?.code, "LARVA_CHILD_CANCELLED");
    await s.cancel({ task_ids: [receipt.task_id], reason: "join completed teardown" });
    f.native({ sessionKey: "pi-a", steer(m) { messages.push(m); } }); f.native({ sessionKey: "pi-a", steer(m) { messages.push(m); } });
    assert.deepEqual(old, []); assert.equal(messages.filter(m => m.customType === "larva-subagent-result").length, 1);
  } finally { t.mock.timers.reset(); }
}));
