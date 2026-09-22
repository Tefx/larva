// purpose: owned native Pi/loopback fixtures shared by acceptance journeys
// usage: import { createNativeFixture, NativeRpc } from this module
// effects: disposable files, loopback socket, exact owned process groups; no user config
// requires: locked local Pi 0.85.1 and Node 26.7.0
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
export const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const PACKAGE = join(ROOT, "contrib/pi-extension");
export const CLI = join(PACKAGE, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
export const CONTROL = join(ROOT, "tests/fixtures/pi/native-controls.ts");
export const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
export async function jsonLines(path) {
  try { return (await readFile(path, "utf8")).split("\n").filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
export async function directory(path) {
  try { return await readdir(path); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
export function cleanTestEnv(extra) {
  // Fixture isolation only. Product launch never calls this or imports this file.
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(LARVA_|PI_|XDG_|VIRTUAL_ENV$|UV_PROJECT_ENVIRONMENT$|PYTHONPATH$|NODE_OPTIONS$)/.test(key) || /API[_-]?KEY|TOKEN|SECRET|PASSWORD/i.test(key)) delete env[key];
  }
  return { ...env, ...extra };
}
export async function execute(command, args, options = {}) {
  const child = spawn(command, args, { ...options, stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
  if (options.input !== undefined) child.stdin.end(options.input);
  let stdout = "", stderr = "", timedOut = false;
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (c) => { stdout += c; });
  child.stderr.on("data", (c) => { stderr += c; });
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeout ?? 120000);
  try {
    const exit = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
    return { command, args, pid: child.pid, ...exit, timedOut, stdout, stderr };
  } finally { clearTimeout(timer); }
}
export class NativeRpc {
  frames = []; stderr = ""; closed = null; serial = 0; events = new EventEmitter();
  constructor(fixture, args = [], env = fixture.env) {
    this.fixture = fixture;
    this.child = spawn(process.execPath, [CLI, "--mode", "rpc", "--offline", "--approve", "--no-skills", "--no-prompt-templates", "--session-dir", fixture.sessions, "-e", CONTROL, ...args], { env, cwd: fixture.cwd, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    fixture.parents.push(this);
    this.child.stdout.setEncoding("utf8"); this.child.stderr.setEncoding("utf8");
    let buffer = "";
    this.child.stdout.on("data", (c) => {
      buffer += c;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (line.trim()) { try { this.frames.push(JSON.parse(line)); } catch { this.frames.push({ unparsed: line }); } }
      }
      this.events.emit("change");
    });
    this.child.stderr.on("data", (c) => { this.stderr += c; });
    this.child.on("error", (error) => { this.closed = { error: error.message }; this.events.emit("change"); });
    this.done = new Promise((resolve) => this.child.once("close", (code, signal) => { this.closed = { code, signal }; this.events.emit("change"); resolve(this.closed); }));
  }
  async until(predicate, timeout = 15000) {
    const check = () => predicate(this.frames);
    if (check()) return check();
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`Native RPC observation timed out (${timeout}ms): ${this.stderr.slice(-1000)}`)), timeout);
      const finish = (error, value) => { clearTimeout(timer); this.events.off("change", changed); error ? reject(error) : resolve(value); };
      const changed = () => { const value = check(); if (value) finish(null, value); else if (this.closed) finish(new Error(`Pi exited early: ${JSON.stringify(this.closed)} ${this.stderr}`)); };
      this.events.on("change", changed); changed();
    });
  }
  async command(type, data = {}, timeout = 15000) {
    const id = `native-${++this.serial}`;
    this.child.stdin.write(JSON.stringify({ id, type, ...data }) + "\n");
    const response = await this.until((frames) => frames.find((frame) => frame.id === id && frame.type === "response"), timeout);
    assert.equal(response.success, true, JSON.stringify(response));
    return response.data;
  }
  async prompt(message, timeout = 15000) {
    const from = this.frames.length;
    await this.command("prompt", { message }, timeout);
    await this.until((frames) => frames.slice(from).find((frame) => frame.type === "agent_settled"), timeout);
    return this.frames.slice(from);
  }
  async snapshot() { return await this.command("prompt", { message: "/audit-snapshot" }).then(() => jsonLines(join(this.fixture.root, "observations.jsonl"))).then((rows) => rows.filter((row) => row.event === "snapshot").at(-1)); }
  async stop() {
    if (this.closed) return this.closed;
    await this.command("prompt", { message: "/audit-stop" });
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 8000);
    try { const exit = await this.done; assert.deepEqual(exit, { code: 0, signal: null }); return exit; }
    finally { clearTimeout(timer); }
  }
}
export async function createNativeFixture() {
  const root = await mkdtemp(join(tmpdir(), "larva-native-journey-"));
  const fixture = { root, home: join(root, "home"), agent: join(root, "agent"), cwd: join(root, "project"), sessions: join(root, "sessions"), children: join(root, "children"), parents: [], errors: [], requests: [], requestEvents: new EventEmitter(), sockets: new Set(), respond: () => ({ text: "Deterministic protocol response." }) };
  for (const dir of [fixture.home, fixture.agent, fixture.cwd, fixture.sessions, fixture.children, join(root, "tmp")]) await mkdir(dir, { recursive: true });
  fixture.server = createServer(async (request, response) => {
    // Preserve code points across transport chunks when recording provider input.
    request.setEncoding("utf8");
    let raw = ""; for await (const chunk of request) raw += chunk;
    assert.equal(request.socket.remoteAddress, "127.0.0.1");
    const payload = JSON.parse(raw);
    const row = { url: request.url, payload }; fixture.requests.push(row); fixture.requestEvents.emit("request", row);
    let answer;
    try { answer = await fixture.respond(payload, row); }
    catch (error) { fixture.errors.push(error.stack); answer = { error: true }; }
    if (answer.error) { response.writeHead(400); response.end(JSON.stringify({ error: { message: "deliberate local provider failure" } })); return; }
    response.writeHead(200, { "content-type": "text/event-stream", connection: "close" }); response.flushHeaders();
    if (answer.hold) return;
    const delta = answer.tools ? { role: "assistant", tool_calls: answer.tools.map((tool, index) => ({ index, id: `call-${fixture.requests.length}-${index}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } })) } : { role: "assistant", content: answer.text ?? "Protocol response." };
    const chunk = (delta, finish_reason) => `data: ${JSON.stringify({ id: "native", object: "chat.completion.chunk", created: 0, model: payload.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    response.end(chunk(delta, null) + chunk({}, answer.tools ? "tool_calls" : "stop") + "data: [DONE]\n\n");
  });
  fixture.server.on("connection", (s) => { fixture.sockets.add(s); s.on("close", () => fixture.sockets.delete(s)); });
  await new Promise((resolve, reject) => { fixture.server.once("error", reject); fixture.server.listen(0, "127.0.0.1", resolve); });
  fixture.settings = { defaultProjectTrust: "yes", theme: "dark", lastChangelogVersion: "0.85.1", packages: [PACKAGE], defaultProvider: "native-loopback", defaultModel: "origin", defaultThinkingLevel: "low", compaction: { enabled: false, reserveTokens: 512, keepRecentTokens: 512 }, retry: { enabled: false } };
  await writeFile(join(fixture.agent, "settings.json"), JSON.stringify(fixture.settings));
  await writeFile(join(fixture.agent, "models.json"), JSON.stringify({ providers: { "native-loopback": { baseUrl: `http://127.0.0.1:${fixture.server.address().port}/v1`, api: "openai-completions", apiKey: "local-nonsecret", models: ["origin", "persona", "manual", "profile", "child"].map((id) => ({ id, name: id, reasoning: true, contextWindow: 32768, maxTokens: 2048 })) } } }));
  await writeFile(join(root, "model-map.json"), JSON.stringify({ models: { "openai/gpt-5.5": { provider: "native-loopback", model_id: "persona" } }, prefix_rules: [] }));
  await writeFile(join(root, "thinking-policy.json"), JSON.stringify({ schema_version: 1, default: "medium", personas: { child: "xhigh", startup: "high" } }));
  await writeFile(join(root, "subagent-runtime.json"), JSON.stringify({ schema_version: 1, extension_sources: [join(ROOT, "tests/fixtures/pi/native-child-observer.ts")] }));
  fixture.env = cleanTestEnv({ HOME: fixture.home, TMPDIR: join(root, "tmp"), PATH: `${dirname(process.execPath)}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`, SHELL: "/bin/sh", PI_CODING_AGENT_DIR: fixture.agent, PI_CODING_AGENT_SESSION_DIR: fixture.sessions, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", TERM: "xterm-256color", NATIVE_AUDIT_ROOT: root, LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, join(ROOT, "tests/fixtures/pi/fake-larva-cli.mjs")]), LARVA_PI_MODEL_MAP_FILE: join(root, "model-map.json"), LARVA_PI_THINKING_POLICY_FILE: join(root, "thinking-policy.json"), LARVA_PI_CHILD_SESSION_DIR: fixture.children, LARVA_PI_SUBAGENT_CONFIG_FILE: join(root, "subagent-runtime.json"), LARVA_PI_CHILD_RPC_TRACE_FILE: join(root, "child-trace.jsonl") });
  fixture.inspect = async () => {
    const traces = await jsonLines(join(root, "child-trace.jsonl"));
    const pids = traces.filter((row) => row.event === "child_spawn" && row.pid).map((row) => row.pid);
    const capsules = await directory(join(fixture.home, ".pi/larva/runtime"));
    const sessions = await directory(fixture.children);
    return { traces, pids, liveChildren: pids.filter(alive), capsules, sessions, settings: JSON.parse(await readFile(join(fixture.agent, "settings.json"), "utf8")) };
  };
  fixture.close = async () => {
    // Reap first, inspect before outer rm. Even a failed assertion owns its effects.
    for (const parent of fixture.parents) {
      if (!parent.closed) { try { process.kill(-parent.child.pid, "SIGTERM"); } catch {} }
      const timer = setTimeout(() => { try { process.kill(-parent.child.pid, "SIGKILL"); } catch {} }, 2000);
      await parent.done; clearTimeout(timer);
    }
    const before = await fixture.inspect();
    for (const pid of before.liveChildren) { try { process.kill(pid, "SIGKILL"); } catch {} }
    for (const socket of fixture.sockets) socket.destroy();
    await new Promise((resolve) => fixture.server.close(resolve));
    await rm(root, { recursive: true, force: true });
    return { ...before, parents: fixture.parents.map((p) => ({ pid: p.child.pid, exit: p.closed, alive: alive(p.child.pid) })), providerClosed: !fixture.server.listening, rootRemoved: true };
  };
  return fixture;
}
