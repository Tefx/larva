import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { fixture, tool } from "./fixture.ts";

const spawn = "larva_subagent", wait = "larva_subagent_wait", cancel = "larva_subagent_cancel",
  status = "larva_subagent_status", activity = "larva_subagent_activity", panel = "larva_subagent_panel";
const worker = { persona_id: "worker" };

test("packaged Codex resources render four panel tabs and actually grow and shrink the widget", {
  skip: !process.env.LARVA_TEST_CHROME && "Set LARVA_TEST_CHROME to a Chromium executable.", timeout: 30_000,
}, () => fixture(async f => {
  const client = f.mcp();
  await client.initialize();
  const get = async (uri: string) => (await client.request("resources/read", { uri })).contents[0].text as string;
  const [panelHtml, widgetHtml] = await Promise.all([get("ui://larva-pi-subagent/panel-v4"), get("ui://larva-pi-subagent/widget-v4")]);
  const literal = (text: string) => JSON.stringify(text).replaceAll("<", "\\u003c");
  const file = join(f.host, "browser.html");
  await writeFile(file, `<!doctype html><meta charset="utf-8"><div id="result">waiting</div><script>
const result = document.querySelector('#result');
window.addEventListener('error', event => { result.textContent = event.message; });
const run = { task_id: '/example/child.jsonl', run_epoch: 'epoch-one', persona_id: 'worker', cwd: '/example',
  status: 'success', phase: 'success', output_state: 'inline', tool_call_count: 3, task_preview: 'Browser fixture task',
  result_text: 'Real output\\n\\n' + 'Measured content\\n'.repeat(30) };
const reply = { structuredContent: { runs: [run], startup_failures: [] } };
const setup = (full, html) => {
  const frame = document.createElement('iframe');
  frame.style.cssText = 'width:420px;height:600px';
  const heights = [];
  let pollCount = 0;
  const send = data => frame.contentWindow.postMessage({ jsonrpc: '2.0', ...data }, '*');
  const notify = (method, params) => send({ method, params });
  window.addEventListener('message', ({source, data}) => {
    if (source !== frame.contentWindow) return;
    if (data.method === 'ui/initialize') send({ id: data.id, result: { hostContext: { displayMode: full ? 'fullscreen' : 'inline' } } });
    else if (data.method === 'ui/notifications/initialized') {
      notify('ui/notifications/tool-input', { arguments: { scope: 'recent' } });
      if (!full) notify('ui/notifications/tool-result', reply);
    } else if (data.method === 'tools/call') { pollCount++; send({ id: data.id, result: reply }); }
    else if (data.method === 'ui/notifications/size-changed') heights.push(data.params.height);
  });
  frame.srcdoc = html;
  document.body.append(frame);
  const buttons = () => [...frame.contentDocument.querySelectorAll('button')];
  return { heights, buttons, pollCount: () => pollCount, send };
};
const panel = setup(true, ${literal(panelHtml)}), widget = setup(false, ${literal(widgetHtml)});
let stage = 0, before = 0, grown = 0, stopped = 0;
const timer = setInterval(() => {
  const by = (app, text) => app.buttons().find(button => button.textContent === text);
  if (stage === 0 && !result.textContent.startsWith('Error')) result.textContent = 'waiting: panel=' + panel.buttons().map(b => b.textContent) + '; widget=' + widget.buttons().map(b => b.textContent) + '; heights=' + widget.heights;
  if (stage === 0 && widget.heights.length && by(widget, 'Details') && by(panel, 'Task & Session')) {
    const names = ['All','Timeline','Result','Task & Session'];
    if (!names.every(name => by(panel, name)?.getBoundingClientRect().width > 0)) throw Error('Missing visible panel tab');
    by(panel, 'Result').click();
    if (by(panel, 'Result').getAttribute('aria-pressed') !== 'true' || by(panel, 'Copy task_id')) throw Error('Result tab did not isolate content');
    before = widget.heights.at(-1);
    by(widget, 'Details').click(); stage++;
  } else if (stage === 1 && by(widget, 'Hide details') && widget.heights.at(-1) !== before) {
    grown = widget.heights.at(-1);
    if (grown <= before) throw Error('Widget did not grow');
    by(widget, 'Hide details').click(); stage++;
  } else if (stage === 2 && by(widget, 'Details') && widget.heights.at(-1) !== grown) {
    const shrunk = widget.heights.at(-1);
    if (shrunk !== before || shrunk >= grown) throw Error('Widget did not shrink');
    panel.send({ id: 700, method: 'ui/resource-teardown' });
    stopped = panel.pollCount(); stage++;
    setTimeout(() => {
      if (panel.pollCount() !== stopped) throw Error('Panel polled after teardown');
      clearInterval(timer); result.textContent = 'verified-browser-layout';
    }, 1600);
  }
}, 50);
</script>`);
  const browser = promisify(execFile)(process.env.LARVA_TEST_CHROME!, ["--headless", "--no-first-run", "--no-default-browser-check",
    "--disable-gpu", "--disable-background-networking", "--disable-component-update", `--user-data-dir=${join(f.host, "browser-profile")}`,
    "--virtual-time-budget=7000", "--dump-dom", pathToFileURL(file).href], { timeout: 20_000, maxBuffer: 2 * 1024 * 1024 });
  const { stdout } = await browser.catch((error: { code?: number; stdout?: string; stderr?: string }) => {
    if (error.code === 2 && error.stdout && error.stderr?.includes("Teardown watchdog expired")) return { stdout: error.stdout };
    throw error;
  });
  assert.equal(/<div id="result">([^<]*)<\/div>/.exec(stdout)?.[1], "verified-browser-layout");
  assert.equal((await client.close()).code, 0);
}));

test("packaged MCP recovers real Pi oversized completion and pages its exact artifact", { timeout: 30_000 }, () => fixture(async f => {
  const client = f.mcp();
  await client.initialize();
  const marker = join(f.host, "native-events.jsonl");
  const observe = join(f.host, "observe.mjs");
  await writeFile(observe, `import { appendFileSync } from 'node:fs';
export default pi => {
  for (const name of ['agent_end', 'agent_settled']) pi.on(name, event => {
    appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ name, bytes: Buffer.byteLength(JSON.stringify(event)) }) + '\\n');
  });
};`);
  await f.config({ subagent: { extension_sources: [join(dirname(f.modelCatalog), "provider.mjs"), observe] } });
  const task = "Return a large multiline Unicode completion";
  const accepted = await client.ok(spawn, { ...worker, task, cwd: f.cwd });
  const { task_id, run_epoch } = accepted;
  const output = "Start of native output\n\n" + "é🙂 output\n".repeat(86_000) + "End of native output";
  const bytes = Buffer.byteLength(output);
  assert.ok(bytes > 1_048_576);
  (await f.provider(0, task)).reply(output);
  const settled = await client.ok(wait, { task_ids: [task_id], timeout_ms: 15_000 }, 20_000);
  const terminal = settled.terminal_outputs[task_id];
  const nativeEvents = (await readFile(marker, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  assert.ok(terminal, `Native events: ${JSON.stringify(nativeEvents)}; MCP state: ${JSON.stringify(settled).slice(0, 900)}`);
  assert.ok(nativeEvents.some(event => event.name === "agent_end" && event.bytes > 1_048_576), JSON.stringify(nativeEvents));
  assert.ok(nativeEvents.some(event => event.name === "agent_settled"), JSON.stringify(nativeEvents));
  assert.deepEqual([terminal.run_epoch, terminal.status, terminal.output_state], [run_epoch, "success", "artifactized"]);
  const artifact = terminal.full_output_artifact;
  assert.equal(artifact.bytes, bytes);
  assert.equal(artifact.sha256, createHash("sha256").update(output).digest("hex"));
  assert.equal(createHash("sha256").update(await readFile(artifact.path)).digest("hex"), artifact.sha256);
  // The persisted assistant message proves the native source was itself oversized.
  const messages = (await readFile(task_id, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line));
  const assistant = messages.findLast(entry => entry.message?.role === "assistant");
  assert.ok(Buffer.byteLength(JSON.stringify(assistant.message)) > 1_048_576);
  const page = async (offset: number, length: number) => (await client.ok(panel, { slice: { task_id, run_epoch, source: "output", offset, length } })).slice;
  const first = await page(0, 37);
  const second = await page(first.continuation_offset, 61);
  assert.equal(first.text + second.text, [...output].slice(0, 98).join(""));
  assert.equal((await page([...output].length - 20, 4000)).text, [...output].slice(-20).join(""));
  await client.ok(cancel, { task_ids: [task_id], reason: "Join child cleanup" });
}));
const lease = async (id: string) => JSON.parse(await readFile(`${id}.lock/lease.json`, "utf8"));
const header = (cwd: string) => `${JSON.stringify({ type: "session", version: 3, id: "fixture", cwd })}\n`;
const age = async (path: string) => {
  const old = new Date(Date.now() - 3 * 86_400_000);
  await utimes(path, old, old);
};

test("external-cache MCP uses singleton roots, recorded resume cwd and contained real Pi activity", { timeout: 30_000 }, () => fixture(async f => {
  await rm(f.sessions, { recursive: true });
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
  const pin = (task_id: string) => ({ run_epochs: [{ task_id, run_epoch: accepted.run_epoch }] });
  for (const [task_id, code] of [[alias, "LARVA_SESSION_INVALID"], [aliasedHomeId, "LARVA_SESSION_INVALID"],
    [join(directoryAlias, "missing.jsonl"), "LARVA_SESSION_INVALID"], [missingId, "LARVA_SESSION_NOT_FOUND"]]) {
    for (const tool of [status, activity, panel]) await mcp.error(tool, { task_id }, code);
    await mcp.error(spawn, { ...worker, task_id, task: "Rejected exact handle" }, code);
    if (code === "LARVA_SESSION_INVALID") assert.equal((await mcp.ok(panel, pin(task_id))).row_errors[0].error.code, code);
    await assert.rejects(access(`${task_id}.lock`), { code: "ENOENT" });
  }
  assert.deepEqual(await mcp.ok(panel, pin(missingId)), { runs: [], startup_failures: [], row_errors: [] });
  assert.equal((await mcp.ok(status, { task_id: id })).runs[0].task_id, id);
  assert.equal((await mcp.ok(panel, { task_id: id })).runs[0].task_id, id);
  assert.equal((await mcp.ok(panel, pin(id))).runs[0].run_epoch, accepted.run_epoch);
  const moved = join(f.sessions, "moved.jsonl");
  await rename(id, moved);
  await symlink(moved, id);
  assert.equal((await mcp.ok(panel, pin(id))).row_errors[0].error.code, "LARVA_SESSION_INVALID");
  await rm(id);
  assert.equal((await mcp.ok(panel, { task_id: id })).runs[0].run_epoch, accepted.run_epoch);
  const retained = await mcp.ok(panel, pin(id));
  assert.equal(retained.runs[0].result_text, "Read from the rooted workspace");
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

test("MCP stale epochs cannot cancel replacements; a live deep descendant retains ownership until shutdown reaps it", { timeout: 30_000 }, () => fixture(async f => {
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
  const guarded = await mcp.ok(cancel, { ...cancellation, expected_run_epochs: [{ task_id: id, run_epoch: seed.run_epoch }] });
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
  // Settle execution naturally: cancelling a running subtree would signal its
  // discoverable leaf. Retrying terminal cleanup must preserve the live proof.
  held.reply("Leader finished while the recorded descendant was still live");
  assert.equal((await mcp.ok(wait, { task_ids: [id] })).terminal_outputs[id].status, "success");
  const declined = await mcp.call(cancel, { ...cancellation, expected_run_epochs: [{ task_id: id, run_epoch: next.run_epoch }] });
  assert.equal(declined.isError, true);
  assert.deepEqual(declined.structuredContent.results, [{ task_id: id, outcome: "cleanup_unconfirmed" }]);
  await held.waitClosed();
  assert.throws(() => process.kill(child_pid, 0), { code: "ESRCH" });
  assert.equal((await lease(id)).lease_id, lease_id);
  assert.equal((await lease(id)).state, "unreconciled");
  assert.equal((await mcp.ok(status, { task_id: unrelated.task_id })).runs[0].status, "running");
  assert.deepEqual(await mcp.request("ping"), {});
  assert.equal(mcp.child.exitCode, null);
  await access(evidence);
  await access(join(capsule_root, "owner.json"));
  await access(`${id}.lock/lease.json`);

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
  assert.deepEqual(await mcp.close(), { code: 0, signal: null, stderr: "" });
  await leaf.exited();
  await assert.rejects(access(`${unrelated.task_id}.lock`), { code: "ENOENT" });
  assert.throws(() => process.kill(leafPid, 0), { code: "ESRCH" });
  assert.equal((await competitor.ok(status, { task_id: id })).disk_sessions[0].lock_state, "unlocked");
  for (const dryRun of [true, false]) {
    const gc = f.gc(dryRun);
    assert.equal((await gc.exited()).code, 0);
    assert.equal(gc.frames[0].data.deleted_sessions, 1);
    if (dryRun) await access(id);
  }
  for (const path of [id, `${id}.lock`, capsule_root, midRoot, leafRoot]) await assert.rejects(access(path), { code: "ENOENT" });
}));
