import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { compile } from "@earendil-works/pi-schema";
import { registerPiTools } from "../../src/surfaces/pi-tools.ts";

const exec = promisify(execFile);
const repo = fileURLToPath(new URL("../../", import.meta.url));
const version: string = JSON.parse(await readFile(join(repo, "package.json"), "utf8")).version;
const widgetUri = "ui://larva-pi-subagent/widget-v4", panelUri = "ui://larva-pi-subagent/panel-v4";
const input = { persona_id: "worker", task: "work" };

// A separate OS process speaks only the Pi RPC commands used by the supervisor.
// The server, stdio transport, child preload, epoch outbox and leases are real.
const piScript = `
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const argv = process.argv.slice(2), arg = key => argv[argv.indexOf(key) + 1];
const id = arg('--session'), persona_id = arg('--larva-persona');
const [provider, model] = arg('--model').split('/');
try { writeFileSync(id, JSON.stringify({type:'session', version:3, cwd:process.cwd(), id:'fixture'})+'\\n',{flag:'wx'}); }
catch (e) { if (e.code !== 'EEXIST') throw e; }
writeFileSync(id+'.pid', String(process.pid));
const send = frame => process.stdout.write(JSON.stringify(frame)+'\\n');
const settled = () => send({type:'agent_settled', aborted:false});
let task, outputRequest, outputReleased = false;
const reply = (q, data) => send({type:'response', id:q.id, command:q.type, success:true, data});
const output = q => reply(q, {text:'result: '+task});
process.on('SIGUSR2', settled);
process.on('SIGWINCH', () => { outputReleased = true; if (outputRequest) output(outputRequest); });
createInterface({input:process.stdin}).on('line', line => {
  const q = JSON.parse(line);
  switch (q.type) {
    case 'get_state': return reply(q, {model:{provider,id:model}, sessionFile:id, persona_id, thinkingLevel:arg('--thinking')});
    case 'switch_session': return reply(q, {cancelled:false});
    case 'prompt': task = q.message; reply(q, {disposition:'started'}); if (task.startsWith('complete')) settled(); return;
    case 'get_last_assistant_text': if (task !== 'hold-output' || outputReleased) return output(q); outputRequest = q; return;
  }
}).on('close', () => process.exit(0));`;

async function fixture<T>(fn: (f: Awaited<ReturnType<typeof setup>>) => Promise<T>) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "larva-mcp-")));
  try { return await fn(await setup(home)); }
  finally { await rm(home, { recursive: true, force: true }); }
}

async function setup(home: string) {
  const work = join(home, "workspace-é"), host = join(home, "server-cwd"), agent = join(home, "agent"), pi = join(home, "pi");
  const paths = [work, join(host, ".pi"), agent, pi, join(home, "personas")];
  await Promise.all(paths.map(path => mkdir(path, { recursive: true })));
  await Promise.all([
    writeFile(join(host, ".pi", "settings.json"), "not JSON"),
    writeFile(join(agent, "settings.json"), "{}"),
    writeFile(join(home, "personas", "worker.json"), JSON.stringify({ id: "worker", description: "Worker é", prompt: "Private prompt.", model: "local/one" })),
    writeFile(join(pi, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.6.1", bin: { pi: "cli.mjs" }, exports: "./registry.mjs" })),
    writeFile(join(pi, "cli.mjs"), piScript),
    writeFile(join(pi, "registry.mjs"), `export class ModelRuntime { static async create() { return {}; } }
      export class ModelRegistry { getError() {} find(provider,id) { if (provider === 'local' && id === 'one') return {provider,id}; } }`),
  ]);
  const env = { HOME: home, PATH: process.env.PATH, LARVA_HOME: home, PI_CODING_AGENT_DIR: agent, LARVA_PI_CLI_SCRIPT: join(pi, "cli.mjs") };
  return { home, work, host, env, async bundle() {
    await build({
      absWorkingDir: repo, entryPoints: ["src/mcp-server.ts", "src/child-rpc-preload.ts"], outdir: home,
      outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm",
      define: { __LARVA_VERSION__: JSON.stringify(version) },
    });
    return join(home, "mcp-server.mjs");
  } };
}

type Fixture = Awaited<ReturnType<typeof setup>>;
type Framing = "length" | "line";
function encode(frame: object, framing: Framing) {
  const json = JSON.stringify(frame);
  return Buffer.from(framing === "length" ? `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}` : `${json}\n`);
}

async function withServer(f: Fixture, main: string, fn: (client: ReturnType<typeof connect>) => Promise<void>, args: string[] = []) {
  const client = connect(f, main, args);
  try { await fn(client); }
  finally {
    if (client.child.exitCode === null && client.child.signalCode === null) client.child.kill("SIGTERM");
    await client.exit;
  }
}

function connect(f: Fixture, main: string, args: string[]) {
  const child = spawn(process.execPath, [main, ...args], { env: f.env, cwd: f.host, stdio: "pipe" });
  const close = once(child, "close");
  let stderr = "", buffer = Buffer.alloc(0), nextId = 0;
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  child.stdin.on("error", () => {});
  type Reply = { framing: Framing; message: ReturnType<typeof JSON.parse> };
  const pending = new Map<number, PromiseWithResolvers<Reply>>();
  const rootsRequests: Framing[] = [];
  let roots: unknown = [];
  let respondToRoots = true;
  const send = (frame: object, framing: Framing) => child.stdin.write(encode({ jsonrpc: "2.0", ...frame }, framing));
  child.stdout.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length) {
      const framed = buffer.subarray(0, 15).toString() === "Content-Length:";
      const end = buffer.indexOf(framed ? "\r\n\r\n" : "\n");
      if (end < 0) break;
      const start = framed ? end + 4 : 0;
      const stop = framed ? start + Number(buffer.subarray(15, end).toString()) : end;
      if (buffer.length < stop + (framed ? 0 : 1)) break;
      const message = JSON.parse(buffer.subarray(start, stop).toString());
      buffer = buffer.subarray(stop + (framed ? 0 : 1));
      const framing = framed ? "length" : "line";
      if (message.method === "roots/list") {
        rootsRequests.push(framing);
        if (respondToRoots) send({ id: message.id, result: { roots } }, framing);
      } else pending.get(message.id)?.resolve({ framing, message });
    }
  });
  const exit = close.then(([code, signal]) => {
    for (const reply of pending.values()) reply.reject(new Error(`MCP exited (${code}/${signal}): ${stderr}`));
    return { code, signal, stderr };
  });
  // Give cleanup a hard bound even after a failing assertion or transport regression.
  const kill = setTimeout(() => child.kill("SIGKILL"), 20_000);
  void exit.finally(() => clearTimeout(kill));
  async function request(method: string, params: object = {}, framing: Framing = "line", splitUnicode = false) {
    const id = ++nextId;
    const reply = Promise.withResolvers<Reply>();
    pending.set(id, reply);
    const timer = setTimeout(() => reply.reject(new Error(`No response to ${method}: ${stderr}`)), 7000);
    try {
      const frame = { id, method, params };
      if (splitUnicode) {
        const bytes = encode({ jsonrpc: "2.0", ...frame }, framing);
        const split = bytes.indexOf(0xc3) + 1;
        assert.ok(split > 1);
        // Split both the first header line and a multibyte JSON field.
        child.stdin.write(bytes.subarray(0, 8));
        await delay(10);
        child.stdin.write(bytes.subarray(8, split));
        await delay(10);
        child.stdin.write(bytes.subarray(split));
      } else send(frame, framing);
      const response = await reply.promise;
      assert.equal(response.framing, framing);
      assert.equal(response.message.jsonrpc, "2.0");
      return response.message;
    } finally { clearTimeout(timer); pending.delete(id); }
  }
  const call = async (name: string, args: object = {}, framing: Framing = "line") => {
    const { result, error } = await request("tools/call", { name, arguments: args }, framing);
    assert.equal(error, undefined);
    assert.equal(typeof result.isError, "boolean");
    return result;
  };
  return { child, exit, request, call, rootsRequests, setRoots(value: unknown) { roots = value; }, ignoreRoots() { respondToRoots = false; } };
}

const cli = join(repo, "src", "cli.ts");
const server = join(repo, "src", "mcp-server.ts");
const init = { protocolVersion: "2025-11-25", capabilities: { roots: {} }, clientInfo: { name: "tést", version: "1" } };

test("standalone MCP serves both framings, closed tool schemas, byte-exact instructions, and Codex resources", () => fixture(async f => {
  await withServer(f, server, async c => {
    const skill = await readFile(join(repo, "plugins/codex/skills/larva-subagent/SKILL.md"));
    const { result: initialized } = await c.request("initialize", init, "length", true);
    assert.deepEqual(Buffer.from(initialized.instructions), skill);
    assert.equal(initialized.serverInfo.version, version);
    assert.deepEqual(initialized.capabilities, { tools: {}, resources: {} });
    const { result: { tools } } = await c.request("tools/list");
    const model = ["larva_personas", "larva_subagent", "larva_subagent_wait", "larva_subagent_status", "larva_subagent_activity", "larva_subagent_cancel"];
    assert.deepEqual(tools.map((tool: { name: string }) => tool.name), [...model, "search_mentions", "larva_subagent_panel"]);
    for (const tool of tools) {
      assert.deepEqual(tool._meta.ui.visibility, model.includes(tool.name) ? ["model", "app"] : ["app"]);
      assert.equal(tool.inputSchema.type, "object");
      assert.equal(tool.inputSchema.additionalProperties, false);
    }
    for (const tool of tools.slice(1, 4)) {
      assert.equal(tool._meta.ui.resourceUri, widgetUri);
      assert.deepEqual(tool._meta["openai/ui"], { preferredModelDisplayMode: "inline", availableDisplayModes: ["inline", "fullscreen"] });
    }
    assert.deepEqual(tools[1].inputSchema.required, ["persona_id", "task"]);
    assert.equal(tools[1].inputSchema.properties.wait_for_completion.type, "boolean");
    assert.equal(tools[1].inputSchema.properties.parent_persona_id.type, "string");
    assert.equal(tools[1].inputSchema.properties.stall_alert_ms.anyOf[1].minimum, 60000);
    assert.equal(tools[2].inputSchema.properties.task_ids.maxItems, 25);
    assert.equal(tools[2].inputSchema.properties.timeout_ms.maximum, 86400000);
    const piSchemas = new Map<string, ToolDefinition["parameters"]>();
    registerPiTools({ on() {}, registerTool: ({ name, parameters }: ToolDefinition) => piSchemas.set(name, parameters) } as unknown as ExtensionAPI, {
      current: () => assert.fail("registration must not need a live Pi session"), async authorize() {},
    });
    for (const tool of tools.slice(0, model.length)) {
      const schema = structuredClone(tool.inputSchema);
      if (tool.name === "larva_subagent") {
        delete schema.properties.wait_for_completion;
        delete schema.properties.parent_persona_id;
      }
      assert.deepEqual(schema, piSchemas.get(tool.name), tool.name);
    }
    assert.deepEqual(tools[4].inputSchema.required, ["task_id"]);
    assert.equal(tools[4].inputSchema.properties.session_path, undefined);
    assert.equal(tools[5].inputSchema.properties.expected_run_epochs.additionalProperties.type, "string");
    assert.deepEqual(tools[6]._meta["openai/extensions"], { "mentions/search": { preload: true } });
    assert.equal(tools[7]._meta.ui.resourceUri, panelUri);
    assert.deepEqual(tools[7]._meta["openai/ui"], { entrypoints: [{ type: "thread" }], availableDisplayModes: ["fullscreen"] });
    assert.equal(tools[7].inputSchema.properties.run_epochs.maxProperties, 25);

    const uri = "larva://personas/worker";
    const { result: { resources } } = await c.request("resources/list", {}, "length");
    assert.deepEqual(resources.map((resource: { uri: string }) => resource.uri), [panelUri, widgetUri, uri]);
    const { result: { resourceTemplates } } = await c.request("resources/templates/list");
    assert.equal(resourceTemplates[0].uriTemplate, "larva://personas/{persona_id}");
    const { result: { contents: [persona] } } = await c.request("resources/read", { uri }, "length");
    assert.equal(persona.mimeType, "text/markdown");
    assert.match(persona.text, /Worker é/);
    assert.match(persona.text, /local\/one/);
    assert.doesNotMatch(persona.text, /Private prompt/);
    for (const [appUri, modes] of [[panelUri, ["fullscreen"]], [widgetUri, ["inline", "fullscreen"]]]) {
      const { result: { contents: [app] } } = await c.request("resources/read", { uri: appUri });
      assert.equal(app.mimeType, "text/html;profile=mcp-app");
      assert.deepEqual(app._meta["openai/ui"].availableDisplayModes, modes);
      assert.match(app.text, /larva_subagent_panel/);
    }
    assert.equal((await c.request("resources/read", { uri: "larva://personas/%zz" })).error.code, -32602);
    assert.equal((await c.request("resources/read", { uri: "larva://personas/absent" })).error.data.code, "LARVA_PERSONA_NOT_FOUND");
    const mention = await c.call("search_mentions", { query: "@larva:wo", preload: true });
    assert.equal(mention.content[0].uri, uri);
    const p = (await c.call("larva_personas", { query: "local/one" })).structuredContent.personas;
    assert.equal(p[0].id, "worker"); assert.equal(p[0].prompt, undefined);
    for (const [name, args] of [
      ["larva_subagent_activity", { session_path: "/unused.jsonl" }],
      ["larva_subagent_cancel", { task_ids: ["/unused.jsonl"], reason: 1 }],
    ] as const) {
      const reply = await c.call(name, args);
      assert.equal(reply.isError, true);
      assert.equal(reply.structuredContent.error.code, "LARVA_BAD_INPUT");
    }
    const absent = await c.call("larva_subagent_cancel", { task_ids: ["/unused.jsonl"], reason: "not tracked" });
    assert.equal(absent.isError, false);
    assert.equal(absent.structuredContent.results[0].outcome, "not_found");
    c.child.stdin.end();
    assert.deepEqual(await c.exit, { code: 0, signal: null, stderr: "" });
  });
}));

test("MCP roots bridge uses the initiating framing and requires one usable workspace", () => fixture(async f => {
  await withServer(f, await f.bundle(), async c => {
    await c.request("initialize", { ...init, capabilities: {} });
    const denied = async (framing: Framing = "line") => {
      const reply = await c.call("larva_subagent", input, framing);
      assert.equal(reply.isError, true);
      assert.equal(reply.structuredContent.error.code, "LARVA_CWD_REQUIRED");
    };
    await denied();
    assert.deepEqual(c.rootsRequests, []);
    await c.request("initialize", init);
    const good = { uri: pathToFileURL(f.work).href };
    for (const roots of [[], [good, { uri: "file:///missing" }], [{ uri: "https://example.com/" }], [null]]) {
      c.setRoots(roots);
      await denied();
    }
    c.setRoots([good]);
    const reply = await c.call("larva_subagent", { ...input, task: "complete-é", wait_for_completion: true }, "length");
    assert.equal(reply.isError, false);
    const terminal = reply.structuredContent;
    assert.equal(terminal.result_text, "result: complete-é");
    assert.deepEqual(c.rootsRequests, ["line", "line", "line", "line", "length"]);
    const { result: { tools } } = await c.request("tools/list");
    const schema = tools.find((tool: { name: string }) => tool.name === "larva_subagent_status").inputSchema;
    const validator = compile(schema);
    const { task_id } = terminal;
    const statusCases = [
      [{ task_id, scope: "recent" }, false], [{ task_id, limit: 1 }, false], [{ task_id }, true], [{ scope: "recent", limit: 1 }, true],
    ] as const;
    for (const [args, valid] of statusCases) {
      assert.equal(validator.check(args), valid, JSON.stringify(args));
      const status = await c.call("larva_subagent_status", args);
      assert.equal(status.isError, !valid, JSON.stringify(args));
      if (valid) assert.equal(status.structuredContent.runs[0].cwd, f.work);
      else assert.deepEqual(status.structuredContent.error, { code: "LARVA_BAD_INPUT", message: "Invalid arguments for larva_subagent_status." });
    }
    const activity = await c.call("larva_subagent_activity", { task_id: terminal.task_id });
    assert.equal(activity.structuredContent.status, "success");
    // An unanswered roots request must not hold shutdown open for the request timeout.
    c.ignoreRoots();
    const pending = c.call("larva_subagent", input);
    const disconnected = assert.rejects(pending, /MCP exited \(0\/null\)/);
    await c.request("ping");
    c.child.stdin.end();
    assert.equal((await c.exit).code, 0);
    await disconnected;
  });
}));

test("MCP wait applies one deadline to readiness and output; panel pins and evicts by run epoch", { timeout: 18_000 }, () => fixture(async f => {
  await withServer(f, await f.bundle(), async c => {
    const call = async (name: string, args: object) => {
      const result = await c.call(name, args);
      assert.equal(result.isError, false, JSON.stringify(result.structuredContent));
      return result.structuredContent;
    };
    const first = await call("larva_subagent", { ...input, cwd: f.work, task: "hold-output" });
    assert.equal(first.status, "accepted");
    const { task_id, run_epoch } = first;
    const task_ids = [task_id];
    const pid = Number(await readFile(`${task_id}.pid`, "utf8"));
    assert.equal((await call("larva_subagent_wait", { task_ids, timeout_ms: 0 })).timed_out, true);
    const start = performance.now();
    const waiting = call("larva_subagent_wait", { task_ids, timeout_ms: 500 });
    await delay(250);
    process.kill(pid, "SIGUSR2");
    const snapshot = await waiting;
    const elapsed = performance.now() - start;
    assert.ok(elapsed >= 430 && elapsed < 680, `single 500ms deadline took ${elapsed}ms`);
    assert.equal(snapshot.ready, true);
    assert.equal(snapshot.terminal_outputs[task_id].output_state, "pending");
    process.kill(pid, "SIGWINCH");
    const ready = await call("larva_subagent_wait", { task_ids, return_when: "any" });
    assert.equal(ready.terminal_outputs[task_id].result_text, "result: hold-output");
    const again = await call("larva_subagent_wait", { task_ids, timeout_ms: 0 });
    assert.deepEqual(again.terminal_outputs, ready.terminal_outputs);
    const settle = async () => call("larva_subagent_cancel", { task_ids, reason: "Join completed ownership cleanup" });
    await settle();
    const pinned = (epoch: string) => call("larva_subagent_panel", { task_id, run_epochs: { [task_id]: epoch } });
    const resume = (n: number) => call("larva_subagent", { ...input, task_id, task: `complete-${n}`, wait_for_completion: true });
    const newer = await resume(2);
    assert.notEqual(newer.run_epoch, run_epoch);
    assert.equal((await pinned(run_epoch)).terminal_outputs[task_id].result_text, "result: hold-output");
    assert.equal((await call("larva_subagent_panel", { task_id })).runs[0].run_epoch, newer.run_epoch);
    await settle();
    for (let n = 3; n <= 26; n++) { await resume(n); await settle(); }
    const sessions = dirname(task_id), moved = join(sessions, "moved.jsonl"), dirAlias = join(sessions, "alias-dir");
    await rename(task_id, moved);
    await symlink(sessions, dirAlias, "dir");
    await symlink(moved, task_id);
    for (const id of [task_id, join(dirAlias, "missing.jsonl")]) {
      const result = await c.call("larva_subagent_panel", { run_epochs: { [id]: newer.run_epoch } });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.error.code, "LARVA_SESSION_INVALID");
    }
    await rm(task_id);
    assert.deepEqual(await pinned(run_epoch), { runs: [], startup_failures: [], terminal_outputs: {} });
    assert.equal((await pinned(newer.run_epoch)).terminal_outputs[task_id].result_text, "result: complete-2");
    c.child.stdin.end();
    assert.equal((await c.exit).code, 0);
  });
}));

for (const how of ["EOF", "SIGTERM"] as const) {
  test(`MCP cancel preserves cleanup evidence and keeps serving; unsettled ${how} exits 1`, () => fixture(async f => {
    await withServer(f, await f.bundle(), async c => {
      const { structuredContent: first } = await c.call("larva_subagent", { ...input, cwd: f.work });
      const { structuredContent: second } = await c.call("larva_subagent", { ...input, cwd: f.work });
      assert.equal(first.status, "accepted"); assert.equal(second.status, "accepted");
      const { capsule_root } = JSON.parse(await readFile(`${first.task_id}.lock/lease.json`, "utf8"));
      // A live descendant PID is deliberately retained through shutdown. No unrelated process is signalled.
      const evidence = join(capsule_root, "descendants", "unconfirmed.json");
      await writeFile(evidence, JSON.stringify({ pid: process.pid }));
      const cancelled = await c.call("larva_subagent_cancel", { task_ids: [first.task_id], reason: "cancel", expected_run_epochs: { [first.task_id]: first.run_epoch } });
      assert.equal(cancelled.isError, true);
      assert.deepEqual(cancelled.structuredContent.results, [{ task_id: first.task_id, outcome: "cleanup_unconfirmed" }]);
      assert.equal((await c.call("larva_subagent_status", { task_id: second.task_id })).structuredContent.runs[0].status, "running");
      if (how === "EOF") c.child.stdin.end(); else c.child.kill(how);
      assert.deepEqual(await c.exit, { code: 1, signal: null, stderr: "" });
      await access(evidence);
      await access(join(capsule_root, "owner.json"));
      await access(`${first.task_id}.lock/lease.json`);
      await assert.rejects(access(`${second.task_id}.lock`), { code: "ENOENT" });
    });
  }));
}

test("root CLI executes commands and reserves MCP stdout for JSON-RPC", () => fixture(async f => {
  const run = (...args: string[]) => exec(process.execPath, [cli, ...args], { cwd: f.host, env: f.env, timeout: 4000 });
  assert.equal((await run("--version")).stdout, `${version}\n`);
  assert.match((await run("--help")).stdout, /larva persona validate/);
  const source = join(f.home, "sample.json");
  await writeFile(source, JSON.stringify({ id: "sample", description: "Sample persona", prompt: "Sample prompt", model: "local/one" }));
  const command = async (...args: string[]) => {
    const { stdout, stderr } = await run(...args, "--json");
    assert.equal(stderr, "");
    const envelope = JSON.parse(stdout);
    assert.equal(envelope.ok, true);
    return envelope.data;
  };
  assert.equal((await command("persona", "validate", source))[0].id, "sample");
  assert.deepEqual((await command("persona", "put", source)).committed_ids, ["sample"]);
  assert.equal((await command("persona", "get", "sample")).prompt, "Sample prompt");
  assert.deepEqual((await command("persona", "list")).map((p: { id: string }) => p.id), ["sample", "worker"]);
  assert.deepEqual((await command("persona", "rm", "sample")).removed_ids, ["sample"]);
  assert.equal((await command("doctor")).ok, true);
  assert.equal((await command("gc", "--dry-run")).deleted_sessions, 0);
  await assert.rejects(run("mcp", "--json"), { code: 2, stdout: "", stderr: /LARVA_CLI_USAGE/ });
  await withServer(f, cli, async c => {
    const completed = await c.call("larva_subagent", { ...input, cwd: f.work, task: "complete from source", wait_for_completion: true });
    assert.equal(completed.structuredContent.status, "success");
    const live = await c.call("larva_subagent", { ...input, cwd: f.work });
    assert.equal(live.structuredContent.status, "accepted");
    const pending = c.call("larva_subagent_wait", {
      task_ids: [completed.structuredContent.task_id], return_when: "first_error", timeout_ms: 86_400_000,
    });
    const disconnected = assert.rejects(pending, /MCP exited \(0\/null\)/);
    assert.deepEqual((await c.request("ping")).result, {});
    c.child.kill("SIGINT");
    assert.deepEqual(await c.exit, { code: 0, signal: null, stderr: "" });
    await disconnected;
    await assert.rejects(access(`${live.structuredContent.task_id}.lock`), { code: "ENOENT" });
  }, ["mcp"]);
}));
