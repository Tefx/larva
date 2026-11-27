import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
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
const settled = () => {
  send({type:'message_end', message:{role:'assistant', stopReason:'stop', content:[]}});
  send({type:'agent_settled', aborted:false});
};
let task, outputRequest, outputReleased = false;
const reply = (q, data) => send({type:'response', id:q.id, command:q.type, success:true, data});
const output = q => reply(q, {text:task === 'complete-path' ? process.env.PATH : 'result: '+task});
process.on('SIGUSR2', settled);
process.on('SIGWINCH', () => { outputReleased = true; if (outputRequest) output(outputRequest); });
createInterface({input:process.stdin}).on('line', line => {
  const q = JSON.parse(line);
  switch (q.type) {
    case 'get_state': return reply(q, {model:{provider,id:model}, sessionFile:id, persona_id, thinkingLevel:arg('--thinking')});
    case 'switch_session': return reply(q, {cancelled:false});
    case 'prompt': task = q.message; reply(q, {disposition:'started'});
      if (task.startsWith('complete')) settled();
      if (task === 'abort-task') send({type:'agent_settled', aborted:true});
      return;
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
  const env: NodeJS.ProcessEnv = { HOME: home, PATH: process.env.PATH, LARVA_HOME: home, PI_CODING_AGENT_DIR: agent, LARVA_PI_CLI_SCRIPT: join(pi, "cli.mjs") };
  return { home, work, host, env, async bundle() {
    for (const name of ["mcp-server.mjs", "child-rpc-preload.mjs"]) await copyFile(join(repo, "dist", name), join(home, name));
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
  const pending = new Map<number | string, PromiseWithResolvers<Reply>>();
  const rootsRequests: Framing[] = [];
  const replies: Reply[] = [];
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
      } else {
        const reply: Reply = { framing, message };
        replies.push(reply);
        pending.get(message.id)?.resolve(reply);
      }
    }
  });
  const exit = close.then(([code, signal]) => {
    for (const reply of pending.values()) reply.reject(new Error(`MCP exited (${code}/${signal}): ${stderr}`));
    return { code, signal, stderr };
  });
  // Give cleanup a hard bound even after a failing assertion or transport regression.
  const kill = setTimeout(() => child.kill("SIGKILL"), 20_000);
  void exit.finally(() => clearTimeout(kill));
  async function request(method: string, params: object = {}, framing: Framing = "line",
    { id = ++nextId, splitUnicode = false }: { id?: number | string; splitUnicode?: boolean } = {},
  ) {
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
  return { child, exit, request, call, send, get nextRequestId() { return nextId + 1; }, rootsRequests, replies, setRoots(value: unknown) { roots = value; }, ignoreRoots() { respondToRoots = false; } };
}

const cli = join(repo, "src", "cli.ts");
const server = join(repo, "src", "mcp-server.ts");
const init = { protocolVersion: "2025-11-25", capabilities: { roots: {} }, clientInfo: { name: "tést", version: "1" } };

test("standalone MCP serves both framings, closed tool schemas, byte-exact instructions, and Codex resources", () => fixture(async f => {
  await withServer(f, server, async c => {
    const skill = await readFile(join(repo, "plugins/codex/skills/larva-subagent/SKILL.md"));
    const { result: initialized } = await c.request("initialize", init, "length", { splitUnicode: true });
    assert.deepEqual(Buffer.from(initialized.instructions), skill);
    assert.equal(initialized.serverInfo.version, version);
    assert.equal(initialized.protocolVersion, "2025-11-25");
    for (const protocolVersion of ["2026-07-28", "unsupported"]) {
      assert.equal((await c.request("initialize", { ...init, protocolVersion })).result.protocolVersion, "2026-07-28");
    }
    assert.deepEqual(initialized.capabilities, { tools: {}, resources: {} });
    const { result: { tools } } = await c.request("tools/list");
    const model = ["larva_personas", "larva_subagent", "larva_subagent_wait", "larva_subagent_status", "larva_subagent_activity", "larva_subagent_cancel"];
    assert.deepEqual(tools.map((tool: { name: string }) => tool.name), [...model, "search_mentions", "larva_subagent_panel"]);
    function assertClosedObjects(schema: unknown, path: string): void {
      if (schema === null || typeof schema !== "object") return;
      if ("type" in schema && schema.type === "object") {
        assert.equal("additionalProperties" in schema && schema.additionalProperties, false, path);
      }
      for (const [key, child] of Object.entries(schema)) assertClosedObjects(child, `${path}/${key}`);
    }
    for (const tool of tools) {
      assert.deepEqual(tool._meta.ui.visibility, model.includes(tool.name) ? ["model", "app"] : ["app"]);
      assert.equal(tool.inputSchema.type, "object");
      assertClosedObjects(tool.inputSchema, `MCP/${tool.name}`);
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
    for (const [name, schema] of piSchemas) assertClosedObjects(schema, `Pi/${name}`);
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
    const cancelGuards = tools[5].inputSchema.properties.expected_run_epochs;
    assert.equal(cancelGuards.type, "array");
    assert.equal(cancelGuards.maxItems, 25);
    assert.deepEqual(cancelGuards.items.required, ["task_id", "run_epoch"]);
    assert.deepEqual(tools[6]._meta["openai/extensions"], { "mentions/search": { preload: true } });
    assert.equal(tools[7]._meta.ui.resourceUri, panelUri);
    assert.deepEqual(tools[7]._meta["openai/ui"], { entrypoints: [{ type: "thread" }], availableDisplayModes: ["fullscreen"] });
    const pins = tools[7].inputSchema.properties.run_epochs;
    assert.deepEqual(pins.items, cancelGuards.items);
    assert.equal(pins.minItems, 1);
    assert.equal(pins.maxItems, cancelGuards.maxItems);

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
    assert.equal(mention.content.find((item: { type: string }) => item.type === "resource_link").uri, uri);
    assert.match(mention.content[0].text, /matching Persona resources/);
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
    const cancel = "larva_subagent_cancel", task_id = "/unused.jsonl", guard = { task_id, run_epoch: "first" };
    const cancelArgs = { task_ids: [task_id], reason: "not tracked" };
    const validator = compile(piSchemas.get(cancel)!);
    for (const [expected_run_epochs, shapeValid, admitted] of [
      [[], true, true], [[guard], true, true],
      [[guard, { ...guard, run_epoch: "second" }], true, false],
      [[{ ...guard, task_id: "/unrequested.jsonl" }], true, false],
      [[{ ...guard, extra: true }], false, false], [{ [task_id]: guard.run_epoch }, false, false],
    ] as const) {
      const args = { ...cancelArgs, expected_run_epochs };
      assert.equal(validator.check(args), shapeValid, JSON.stringify(args));
      const reply = await c.call(cancel, args);
      assert.equal(reply.isError, !admitted, JSON.stringify(args));
      if (!admitted) assert.equal(reply.structuredContent.error.code, "LARVA_BAD_INPUT");
    }
    const absent = await c.call(cancel, { ...cancelArgs, expected_run_epochs: [] });
    assert.equal(absent.isError, false);
    assert.equal(absent.structuredContent.results[0].outcome, "not_found");
    c.child.stdin.end();
    assert.deepEqual(await c.exit, { code: 0, signal: null, stderr: "" });
  });
}));

test("MCP EOF drains accepted replies and rejects incomplete frames", () => fixture(async f => {
  await withServer(f, server, async c => {
    const replies = [c.request("initialize", init, "length"), c.request("resources/list"), c.request("ping")];
    c.child.stdin.end();
    const [initialized, resources, ping] = await Promise.all(replies);
    assert.equal(initialized.result.protocolVersion, "2025-11-25");
    assert.equal(resources.result.resources.length, 3);
    assert.deepEqual(ping.result, {});
    assert.equal((await c.exit).code, 0);
  });
  for (const truncated of ["{", "Content-Length: 8\r\n", "Content-Length: 8\r\n\r\n{}"]) {
    await withServer(f, server, async c => {
      c.child.stdin.end(truncated);
      assert.equal((await c.exit).code, 1);
    });
  }
}));

test("MCP paginates resources and cancels only the specified request", () => fixture(async f => {
  await Promise.all(Array.from({ length: 55 }, (_, i) => {
    const id = `worker-${String(i).padStart(2, "0")}`;
    return writeFile(join(f.home, "personas", `${id}.json`), JSON.stringify({ id, description: id, prompt: "Private", model: "local/one" }));
  }));
  await withServer(f, server, async c => {
    await c.request("initialize", init);
    const { result: first } = await c.request("resources/list");
    assert.ok(first.nextCursor);
    const { result: last } = await c.request("resources/list", { cursor: first.nextCursor });
    const uris = [...first.resources, ...last.resources].map(resource => resource.uri);
    assert.equal(last.nextCursor, undefined);
    assert.equal(uris.length, 58);
    assert.equal(new Set(uris).size, uris.length);
    assert.deepEqual(uris.slice(0, 3), [panelUri, widgetUri, "larva://personas/worker"]);
    assert.equal(uris.at(-1), "larva://personas/worker-54");
    assert.equal((await c.request("resources/list", { cursor: 3 })).error.code, -32602);

    c.ignoreRoots();
    const id = c.nextRequestId;
    const pending = c.call("larva_subagent", input);
    const exited = assert.rejects(pending, /MCP exited \(0\/null\)/);
    await c.request("ping");
    assert.equal(c.rootsRequests.length, 1, "the request must reach the roots bridge before cancellation");
    c.send({ method: "notifications/cancelled", params: { requestId: id } }, "length");
    assert.deepEqual((await c.request("ping")).result, {});
    assert.equal(c.replies.some(({ message }) => message.id === id), false);
    const live = await c.call("larva_subagent", { ...input, cwd: f.work });
    assert.equal(live.isError, false);
    c.child.stdin.end();
    assert.equal((await c.exit).code, 0);
    await exited;
  });
}));

for (const [name, count, framing] of [["larva_personas", 9, "line"], ["search_mentions", 3, "length"]] as const) {
  test(`MCP isolates oversized ${name} replies without interrupting an owned child`, () => fixture(async f => {
    const description = "é".repeat(485_000);
    // Each source is valid and under 1 MiB. The persona list sends nine
    // descriptions; mention links carry each of three descriptions four times.
    for (let i = 0; i < count; i++) {
      const id = `catalog-${i}`;
      const source = JSON.stringify({ id, description, prompt: "Private", model: "local/one" });
      assert.ok(Buffer.byteLength(source) < 1024 * 1024);
      await writeFile(join(f.home, "personas", `${id}.json`), source);
    }
    await withServer(f, framing === "length" ? await f.bundle() : server, async c => {
      const { isError, structuredContent: { task_id, status } } = await c.call("larva_subagent", { ...input, cwd: f.work });
      assert.equal(isError, false);
      assert.equal(status, "accepted");
      const pid = Number(await readFile(`${task_id}.pid`, "utf8"));
      const small = await c.call(name, { query: "catalog-0" }, framing);
      assert.equal(small.isError, false);
      const matches = name === "larva_personas" ? small.structuredContent.personas : small.structuredContent.items;
      assert.equal(matches.length, 1);
      assert.ok(matches[0].description === description, "in-budget results retain the full description");

      const id = c.nextRequestId;
      const reply = await c.request("tools/call", { name, arguments: { query: "catalog-" } }, framing);
      assert.equal(reply.id, id);
      assert.equal(reply.error, undefined);
      assert.equal(reply.result.isError, true);
      assert.match(reply.result.content[0].text, /response.*limit.*narrow the query/i);
      assert.equal(reply.result.structuredContent.error.details.matches, count);
      assert.ok(encode(reply, framing).length < 1024);
      assert.deepEqual((await c.request("ping", {}, framing)).result, {});
      assert.equal((await c.call("larva_subagent_status", { task_id })).structuredContent.runs[0].status, "running");
      process.kill(pid, "SIGUSR2");
      const settled = await c.call("larva_subagent_wait", { task_ids: [task_id] });
      assert.equal(settled.structuredContent.terminal_outputs[task_id].result_text, `result: ${input.task}`);
      c.child.stdin.end();
      assert.deepEqual(await c.exit, { code: 0, signal: null, stderr: "" });
    });
  }));
}

test("MCP admits IDs by encoded byte length and correlates reply overflow in both framings", () => fixture(async f => {
  const cap = 8 * 1024 * 1024, idCap = 1024;
  const id = 'é"'.repeat(255) + "é";
  assert.equal(Buffer.byteLength(JSON.stringify(id)), idCap);
  const overLimit = id + "x";
  assert.equal(Buffer.byteLength(JSON.stringify(overLimit)), idCap + 1);
  const ping = { jsonrpc: "2.0", id: "", method: "ping" };

  // Eight admissible files yield a catalog whose reply fits with a numeric ID
  // but runs out of room when the transport adds the maximum string ID.
  const count = 8;
  const description = "é".repeat((cap / count - 240) / 2);
  for (let i = 0; i < count; i++) {
    const id = `catalog-${i}`;
    const source = JSON.stringify({ id, description, prompt: "Private", model: "local/one" });
    assert.ok(Buffer.byteLength(source) < 1024 * 1024);
    await writeFile(join(f.home, "personas", `${id}.json`), source);
  }
  for (const framing of ["line", "length"] as const) {
    await withServer(f, framing === "line" ? server : await f.bundle(), async c => {
      const { isError, structuredContent: { task_id, status } } = await c.call("larva_subagent", { ...input, cwd: f.work }, framing);
      assert.equal(isError, false);
      assert.equal(status, "accepted");
      assert.deepEqual(await c.request("ping", {}, framing, { id }), { jsonrpc: "2.0", id, result: {} });

      const params = { name: "larva_personas", arguments: { query: "catalog-" } };
      const numeric = await c.request("tools/call", params, framing);
      assert.equal(numeric.result.isError, false);
      assert.equal(numeric.result.structuredContent.personas.length, count);
      assert.ok(encode(numeric, framing).length <= cap);
      assert.ok(encode({ ...numeric, id }, framing).length > cap);
      const overflow = await c.request("tools/call", params, framing, { id });
      assert.deepEqual(overflow, { jsonrpc: "2.0", id, error: { code: -32603, message: "Response exceeds the transport limit." } });
      assert.ok(encode(overflow, framing).length <= cap);

      const nearFrameCap = "x".repeat(cap - encode(ping, framing).length - 64);
      const before = c.replies.length;
      for (const id of [overLimit, nearFrameCap]) c.send({ id, method: ping.method }, framing);
      assert.deepEqual((await c.request("ping", {}, framing)).result, {});
      const rejected = c.replies.slice(before, -1);
      assert.equal(rejected.length, 2);
      for (const reply of rejected) {
        assert.equal(reply.framing, framing);
        assert.deepEqual(reply.message.error, { code: -32600, message: "Invalid Request" });
        assert.equal(reply.message.id, null);
        assert.equal(reply.message.result, undefined);
      }
      const small = await c.call("larva_personas", { query: "catalog-0" }, framing);
      assert.equal(small.isError, false);
      const matches = small.structuredContent.personas;
      assert.equal(matches.length, 1);
      assert.ok(matches[0].description === description, "in-budget results retain the full description");
      assert.equal((await c.call("larva_subagent_status", { task_id }, framing)).structuredContent.runs[0].status, "running");
      c.child.stdin.end();
      assert.deepEqual(await c.exit, { code: 0, signal: null, stderr: "" });
      await assert.rejects(access(`${task_id}.lock`), { code: "ENOENT" });
    });
  }
}));

test("MCP bounds the activity envelope and marks partial inspection and cancelled completion as errors", () => fixture(async f => {
  await withServer(f, server, async c => {
    const cancelled = await c.call("larva_subagent", { ...input, task: "abort-task", cwd: f.work, wait_for_completion: true });
    assert.equal(cancelled.structuredContent.status, "cancelled");
    assert.equal(cancelled.isError, true);
    const task_id = join(f.home, "state", "sessions", "recorded.jsonl");
    const payload = { example: "é".repeat(4000) };
    await writeFile(task_id, [
      JSON.stringify({ type: "session", id: "activity-fixture", version: 3, cwd: f.work }),
      JSON.stringify({ type: "message", id: "row", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: {
        role: "assistant", content: [{ type: "toolCall", id: "read", name: "read", arguments: payload }],
      } }),
      "malformed row", "",
    ].join("\n"));
    const read = (args: object) => c.call("larva_subagent_activity", { task_id, ...args });
    const args = { tool_call_id: "read", segment_part: "args", length: 4000 };
    const first = await read(args);
    assert.equal(first.isError, false);
    assert.equal(first.content[0].text, "Recorded tool call details.");
    assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 8192);
    let page = first.structuredContent.call.segment;
    let text = page.text;
    assert.equal(page.has_more, true);
    for (let i = 0; page.has_more; i++) {
      assert.ok(i < 10 && page.continuation_offset > page.offset);
      const next = await read({ ...args, offset: page.continuation_offset, source_version: page.source_version });
      assert.equal(next.isError, false);
      assert.ok(Buffer.byteLength(JSON.stringify(next)) <= 8192);
      page = next.structuredContent.call.segment;
      text += page.text;
    }
    assert.equal(text, JSON.stringify(payload));
    const partial = await read({ tool_call_id: "unobserved" });
    assert.equal(partial.structuredContent.status, "partial");
    assert.equal(partial.isError, true);
  });
}));

test("MCP appends existing GUI PATH fallbacks without duplicating a supplied directory", () => fixture(async f => {
  const local = join(f.home, ".local", "bin"), configured = join(f.home, ".pi", "agent", "bin");
  await Promise.all([local, configured].map(dir => mkdir(dir, { recursive: true })));
  const script = f.env.LARVA_PI_CLI_SCRIPT!;
  await chmod(script, 0o700);
  await symlink(script, join(local, "pi"));
  delete f.env.LARVA_PI_CLI_SCRIPT;
  f.env.PATH = configured;
  const expected = [configured, local];
  for (const dir of ["/opt/homebrew/bin", "/usr/local/bin"]) {
    if ((await stat(dir).catch(() => undefined))?.isDirectory()) expected.push(dir);
  }
  await withServer(f, server, async c => {
    const { isError, structuredContent } = await c.call("larva_subagent", { ...input, task: "complete-path", cwd: f.work, wait_for_completion: true });
    assert.equal(isError, false, JSON.stringify(structuredContent));
    assert.equal(structuredContent.status, "success");
    assert.equal(structuredContent.result_text, expected.join(delimiter));
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
    const guard = { task_id, run_epoch };
    const slice = { task_id, run_epoch, source: "prompt" };
    for (const args of [{ slice, task_id }, { slice, run_epochs: [guard] }, { slice, scope: "recent" }, { slice, limit: 1 },
      { slice: { ...slice, offset: -1 } }, { run_epochs: [guard], task_id }, { run_epochs: [guard], scope: "disk" },
      { run_epochs: [] }, { run_epochs: { [task_id]: run_epoch } },
      { run_epochs: [guard, { ...guard, run_epoch: "other" }] }, { run_epochs: [{ ...guard, extra: true }] },
      { task_id, run_epochs: [{ ...guard, task_id: join(dirname(task_id), "unrequested.jsonl") }] },
      { run_epochs: Array(26).fill(guard) }]) {
      const reply = await c.call("larva_subagent_panel", args);
      assert.equal(reply.isError, true);
      assert.equal(reply.structuredContent.error.code, "LARVA_BAD_INPUT");
    }
    const panelSlice = await call("larva_subagent_panel", { slice });
    assert.equal(panelSlice.slice.state, "ok");
    assert.equal(panelSlice.slice.text, "hold-output");
    const pinned = (epoch: string) => call("larva_subagent_panel", { run_epochs: [{ task_id, run_epoch: epoch }] });
    const resume = (n: number) => call("larva_subagent", { ...input, task_id, task: `complete-${n}`, wait_for_completion: true });
    const newer = await resume(2);
    assert.notEqual(newer.run_epoch, run_epoch);
    const original = await pinned(run_epoch);
    assert.equal(original.runs[0].result_text, "result: hold-output");
    assert.equal(original.terminal_outputs, undefined);
    assert.equal((await call("larva_subagent_panel", { task_id })).runs[0].run_epoch, newer.run_epoch);
    await settle();
    for (let n = 3; n <= 26; n++) { await resume(n); await settle(); }
    const sessions = dirname(task_id), moved = join(sessions, "moved.jsonl"), dirAlias = join(sessions, "alias-dir");
    await rename(task_id, moved);
    await symlink(sessions, dirAlias, "dir");
    await symlink(moved, task_id);
    const corrupted = [task_id, join(dirAlias, "missing.jsonl")];
    const badRows = await call("larva_subagent_panel", { run_epochs: corrupted.map(task_id => ({ task_id, run_epoch: newer.run_epoch })) });
    assert.deepEqual(badRows.runs, []);
    assert.deepEqual(badRows.row_errors.map((row: { error: { code: string } }) => row.error.code), corrupted.map(() => "LARVA_SESSION_INVALID"));
    await rm(task_id);
    assert.deepEqual(await pinned(run_epoch), { runs: [], startup_failures: [], row_errors: [] });
    const mixed = await call("larva_subagent_panel", { run_epochs: [{ task_id, run_epoch: newer.run_epoch },
      { task_id: corrupted[1], run_epoch: newer.run_epoch }] });
    assert.equal(mixed.runs[0].result_text, "result: complete-2");
    assert.equal(mixed.row_errors[0].task_id, corrupted[1]);
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
      const cancelled = await c.call("larva_subagent_cancel", { task_ids: [first.task_id], reason: "cancel", expected_run_epochs: [{ task_id: first.task_id, run_epoch: first.run_epoch }] });
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
