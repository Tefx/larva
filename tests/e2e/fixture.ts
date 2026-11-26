import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const dist = join(repo, "dist");
const models = ["parent", "worker", "leaf", "native", "mapped-parent", "mapped-worker"];

type Tool = { name: string; input: object };
export const tool = (name: string, input: object): Tool => ({ name, input });
export type Answer = string | Tool[];
type Payload = { model: string; messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] };
type Request = {
  payload: Payload; last: string; reply(answer: Answer): void; waitClosed(): Promise<void>;
};

// One event-driven journal for the transport and provider; the race with process
// exit makes a startup failure distinguishable from a missing response.
function journal<T>(describe: () => string = () => "") {
  const entries: T[] = [], events = new EventEmitter();
  events.setMaxListeners(0);
  return {
    entries,
    push(value: T) { entries.push(value); events.emit("entry", value); },
    onEntry(listener: (value: T) => void) { events.on("entry", listener); },
    async find<R>(description: string, select: () => R | undefined, until = AbortSignal.timeout(10_000)): Promise<R> {
      for (;;) {
        const value = select();
        if (value !== undefined) return value;
        try { await once(events, "entry", { signal: until }); }
        catch { assert.fail(`No ${description}: ${describe()}`); }
      }
    },
  };
}

function sse(response: ServerResponse, model: string, answer: Answer, id: string) {
  const delta = typeof answer === "string" ? { role: "assistant", content: answer } : {
    role: "assistant", tool_calls: answer.map(({ name, input }, index) => ({
      index, id: `${id}-${index}`, type: "function", function: { name, arguments: JSON.stringify(input) },
    })),
  };
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model,
    choices: [{ index: 0, delta, finish_reason: typeof answer === "string" ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
}

type SetupOptions = { modelsOnly?: boolean; aliasedHome?: boolean };

async function setup(root: string, cleanup: (() => Promise<unknown>)[], options: SetupOptions) {
  const home = join(root, "larva"), agent = join(root, "agent"), cwd = join(root, "workspace-é"),
    host = join(root, "mcp-cwd"), cache = join(root, ".codex", "plugins", "cache", "larva", "0.9.0"),
    sessions = join(home, "state", "sessions");
  const checkout = resolve(repo.split(`${sep}.vectl${sep}worktrees${sep}`)[0]);
  assert.ok(root !== checkout && !root.startsWith(checkout + sep), "external cache must not be under the repository");
  await Promise.all([agent, cwd, join(host, ".pi"), cache, sessions, join(home, "personas")]
    .map(dir => mkdir(dir, { recursive: true, mode: 0o700 })));
  await writeFile(join(host, ".pi", "settings.json"), "not JSON: MCP must not consult this directory");
  await writeFile(join(agent, "settings.json"), JSON.stringify({ defaultProjectTrust: "decline", retry: { enabled: false } }));
  const personaFile = (name: string) => join(home, "personas", `${name}.json`);
  for (const [id, can_spawn] of [["parent", ["worker"]], ["worker", true], ["leaf", false]] as const) {
    await writeFile(personaFile(id), JSON.stringify({ id, description: `E2E ${id}`, prompt: `E2E identity ${id}`,
      model: `fixture/${id}`, thinking: id === "parent" ? "low" : "off", can_spawn }));
  }
  await writeFile(join(home, "model-map.mapped.json"), JSON.stringify({ models: {
    "fixture/parent": { provider: "fixture", model_id: "mapped-parent" },
    "fixture/worker": { provider: "fixture", model_id: "mapped-worker" },
  } }));
  const requests: ReturnType<typeof journal<Request>> = journal<Request>(() => JSON.stringify(requests.entries.map(({ payload, last }) => [payload.model, last])).slice(-6000));
  const providerErrors: unknown[] = [];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, "/v1/chat/completions");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const payload: Payload = JSON.parse(Buffer.concat(chunks).toString());
      assert.ok(models.includes(payload.model));
      const last = payload.messages.at(-1);
      assert.ok(last);
      const id = `e2e-${requests.entries.length}`;
      requests.push({ payload, last: typeof last.content === "string" ? last.content : JSON.stringify(last.content),
        reply: answer => sse(response, payload.model, answer, id), async waitClosed() {
          if (response.destroyed) return;
          try { await once(response, "close", { signal: AbortSignal.timeout(5_000) }); }
          catch { assert.fail(`Provider socket remained open for ${id}: ${JSON.stringify(last.content)}`); }
        } });
    } catch (error) { providerErrors.push(error); response.writeHead(400).end(); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()));
    assert.deepEqual(providerErrors, []);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const provider = join(agent, "provider.mjs"), modelCatalog = join(agent, "models.json");
  const providerConfig = { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "fixture-only",
    models: models.map(id => ({ id, name: id, reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16_384, maxTokens: 2_048 })) };
  if (options.modelsOnly) await writeFile(modelCatalog, JSON.stringify({ providers: { fixture: providerConfig } }));
  else await writeFile(provider, `export default pi => {
    pi.registerProvider('fixture', ${JSON.stringify(providerConfig)});
    // RPC does not expose the interactive slash dispatcher. Exercise the same
    // native reload API the TUI uses, without reimplementing reload handling.
    pi.registerCommand('reload', { handler: (_, ctx) => ctx.reload() });
  };`);
  const config = async (fields: object) => writeFile(join(home, "config.json"), JSON.stringify({
    subagent: { extension_sources: options.modelsOnly ? [] : [provider] }, ...fields,
  }));
  await config({});
  for (const file of ["mcp-server.mjs", "pi-extension.js", "child-rpc-preload.mjs", "timeline-worker.mjs"]) {
    await copyFile(join(dist, file), join(cache, file));
  }
  await writeFile(join(cache, "package.json"), '{"type":"module"}\n');
  const piScript = await realpath(join(repo, "node_modules", ".bin", "pi"));
  const configuredHome = options.aliasedHome ? join(root, "larva-link") : home;
  if (options.aliasedHome) await symlink(home, configuredHome, "dir");
  const env = { HOME: root, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: root,
    XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "xdg-cache"), XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "xdg-state"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_CODING_AGENT_DIR: agent,
    LARVA_HOME: configuredHome, LARVA_PI_CLI_SCRIPT: piScript };
  const cli = (...args: string[]) => start([join(dist, "cli.mjs"), ...args], host, env, cleanup);
  return { home, configuredHome, cwd, host, sessions, personaFile, config, modelCatalog, requests: requests.entries,
    provider(from: number, text: string, timeout?: number) {
      return requests.find(`provider request containing ${text}`, () => requests.entries.slice(from).find(r => r.last.includes(text)),
        timeout === undefined ? undefined : AbortSignal.timeout(timeout));
    },
    pi(args: string[] = []) {
      return piClient(start([piScript, "--mode", "rpc", "--no-extensions", ...(options.modelsOnly ? [] : ["-e", provider]), "-e", join(dist, "pi-extension.js"),
        "--model", "fixture/native", ...args], cwd, env, cleanup));
    },
    mcp() { return mcpClient(start([join(cache, "mcp-server.mjs")], host, env, cleanup)); },
    cliMcp() { return mcpClient(cli("mcp")); },
    doctor() { return cli("doctor", "--json"); },
    gc(dryRun = false) { return cli("gc", "--max-age", "1", "--json", ...(dryRun ? ["--dry-run"] : [])); },
  };
}

type Fixture = Awaited<ReturnType<typeof setup>>;
export async function fixture(fn: (f: Fixture) => Promise<void>, options: SetupOptions = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "larva-e2e-")));
  const cleanup: (() => Promise<unknown>)[] = [], errors: unknown[] = [];
  try { await fn(await setup(root, cleanup, options)); }
  catch (error) { errors.push(error); }
  finally {
    for (const close of cleanup.reverse()) {
      try { await close(); } catch (error) { errors.push(error); }
    }
    try { await rm(root, { recursive: true, force: true }); }
    catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "E2E journey and/or teardown failed");
}

function start(args: string[], cwd: string, env: NodeJS.ProcessEnv, cleanup: (() => Promise<unknown>)[]) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: "pipe" });
  let stderr = "", stdout = "";
  const transcript = () => `${stderr}\n${stdout.slice(-6000)}`;
  const frames = journal<ReturnType<typeof JSON.parse>>(transcript);
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    stdout = (stdout + line + "\n").slice(-32_768);
    try { frames.push(JSON.parse(line)); } catch { frames.push({ raw: line }); }
  });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr = (stderr + chunk).slice(-8192); });
  child.stdin.on("error", () => {});
  const exit = once(child, "close").then(([code, signal]) => ({ code, signal, stderr }));
  void exit.catch(() => {}); // Handles spawn failure even before a test awaits exit.
  const exited = async () => {
    const timer = AbortSignal.timeout(10_000);
    if (child.exitCode === null && child.signalCode === null) {
      try { await once(child, "close", { signal: timer }); }
      catch { assert.fail(`No process exit: ${transcript()}`); }
    }
    return exit;
  };
  const close = async () => {
    child.stdin.end();
    const kill = setTimeout(() => child.kill("SIGKILL"), 7_000);
    try { return await exit; }
    finally { clearTimeout(kill); lines.close(); }
  };
  cleanup.push(close);
  const send = (frame: object) => child.stdin.write(`${JSON.stringify(frame)}\n`);
  const find = async <T>(description: string, select: () => T | undefined, timeout?: number) => {
    const cancel = new AbortController();
    const until = AbortSignal.any([cancel.signal, AbortSignal.timeout(timeout ?? 10_000)]);
    try {
      return await Promise.race([frames.find(description, select, until), exit.then(({ code, signal }) => {
        const last = select();
        if (last !== undefined) return last;
        assert.fail(`Process exited (${code}/${signal}) before ${description}: ${transcript()}`);
      })]);
    } finally { cancel.abort(); }
  };
  let sequence = 0;
  const request = (frame: object, timeout?: number) => {
    const id = `rpc-${++sequence}`;
    send({ id, ...frame });
    return find(id, () => frames.entries.find(entry => entry.id === id && entry.method === undefined), timeout);
  };
  return { child, frames: frames.entries, onFrame: frames.onEntry, exited, close, send, find, request };
}

type Transport = ReturnType<typeof start>;
function piClient(p: Transport) {
  const rpc = async (type: string, fields?: object) => {
    const frame = await p.request({ type, ...fields });
    assert.equal(frame.success, true, JSON.stringify(frame));
    return frame.data;
  };
  const frame = (from: number, type: string, where: (entry: ReturnType<typeof JSON.parse>) => boolean = () => true, timeout?: number) =>
    p.find(type, () => p.frames.slice(from).find(entry => entry.type === type && where(entry)), timeout);
  const prompt = async (message: string, disposition = "started") => {
    const from = p.frames.length;
    assert.equal((await rpc("prompt", { message })).disposition, disposition, message);
    return from;
  };
  const outcome = (from: number, action: string) => p.find(action, () => p.frames.slice(from)
    .filter(entry => entry.statusKey === "larva-outcome").map(entry => JSON.parse(entry.statusText))
    .find(entry => entry.action === action)?.data);
  return { ...p, rpc, prompt, frame, outcome,
    async command(message: string, action = message.slice(1).split(" ")[0]) { return outcome(await prompt(message, "handled"), action); },
    async reload() {
      const from = await prompt("/reload", "handled");
      const errors = p.frames.slice(from).filter(e => e.type === "extension_error");
      assert.deepEqual(errors, []);
      return outcome(from, "reload");
    },
    async route() { const s = await rpc("get_state"); return [s.model.provider, s.model.id, s.thinkingLevel]; },
    async settled(from: number, timeout?: number) { assert.equal((await frame(from, "agent_settled", undefined, timeout)).aborted, false); },
    async toolResult(from: number, name: string) { return (await frame(from, "tool_execution_end", e => e.toolName === name)).result.details; },
  };
}

function mcpClient(p: Transport) {
  let roots: { uri: string }[] = [];
  const request = async (method: string, params: object = {}, timeout?: number) => {
    const response = await p.request({ jsonrpc: "2.0", method, params }, timeout);
    assert.equal(response.jsonrpc, "2.0");
    assert.equal(response.error, undefined, JSON.stringify(response));
    return response.result;
  };
  // roots/list can arrive while tools/call is pending, so service it independently.
  let rootsCalls = 0;
  p.onFrame(request => {
    if (request.method !== "roots/list") return;
    rootsCalls++;
    p.send({ jsonrpc: "2.0", id: request.id, result: { roots } });
  });
  const call = async (name: string, args: object, timeout?: number) => request("tools/call", { name, arguments: args }, timeout);
  return { ...p, request, call, setRoots(...values: string[]) { roots = values.map(uri => ({ uri })); }, rootsCalls: () => rootsCalls,
    async initialize() {
      const init = await request("initialize", { protocolVersion: "2025-11-25", capabilities: { roots: {} }, clientInfo: { name: "e2e", version: "1" } });
      assert.equal(init.serverInfo.version, "0.9.0");
      p.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    },
    async ok(name: string, args: object, timeout?: number) {
      const result = await call(name, args, timeout);
      assert.equal(result.isError, false, JSON.stringify(result));
      return result.structuredContent;
    },
    async error(name: string, args: object, code: string) {
      const result = await call(name, args);
      assert.equal(result.isError, true, JSON.stringify(result));
      assert.equal(result.structuredContent.error.code, code, JSON.stringify(result));
    },
  };
}
