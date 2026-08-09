#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as moduleApi from "node:module";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const extensionUrl = pathToFileURL(join(root, "contrib/pi-extension/larva.ts"));
const RPC_LIMIT = 1_048_576;
const RAW_FINAL_PREFIX = "RAW_OVERSIZED_FINAL_SHOULD_ONLY_EXIST_IN_ARTIFACT";
const RAW_TOOL_PREFIX = "RAW_OVERSIZED_TOOL_PAYLOAD_MUST_NOT_ESCAPE";
const RAW_ASSISTANT_PREFIX = "RAW_OVERSIZED_ASSISTANT_DELTA_MUST_BE_BOUNDED";
const RAW_THINKING_PREFIX = "RAW_OVERSIZED_THINKING_MUST_STAY_HIDDEN";
const SHORT_FINAL = "controlled short final";

async function installPiTuiStub(dir) {
  const stub = join(dir, "pi-tui-stub.mjs");
  const loader = join(dir, "pi-tui-loader.mjs");
  await writeFile(stub, `
export class Input { constructor() { this.value = ""; } handleInput(data) { this.value += data; return true; } render() { return this.value; } }
export const Key = { escape: "escape", enter: "enter", down: "down", up: "up", pageDown: "pagedown", pageUp: "pageup", home: "home", end: "end", left: "left", right: "right", ctrl: (key) => "ctrl+" + key, ctrlAlt: (key) => "ctrl+alt+" + key };
export class Markdown { constructor(source) { this.source = String(source ?? ""); } render(width) { return wrapTextWithAnsi(this.source, width || 80); } }
export class SelectList { constructor(items = []) { this.items = items; this.selectedIndex = 0; } setItems(items = []) { this.items = items; this.selectedIndex = 0; } handleInput() { return false; } selectedItem() { return this.items[this.selectedIndex] ?? null; } render() { return this.items.map((item) => String(item?.label ?? item?.value ?? "")); } }
export function matchesKey(data, key) { return data === key; }
export function visibleWidth(value) { return String(value ?? "").replace(/\\x1b\\[[0-9;]*m/g, "").length; }
export function truncateToWidth(value, width, suffix = "", pad = false) { const text = String(value ?? ""); const limit = Math.max(0, Number(width) || 0); const truncated = text.length > limit ? text.slice(0, Math.max(0, limit - String(suffix).length)) + suffix : text; return pad ? truncated.padEnd(limit, " ") : truncated; }
export function wrapTextWithAnsi(value, width) { const text = String(value ?? ""); const limit = Math.max(1, Number(width) || 80); const lines = []; for (const rawLine of text.split(/\\r?\\n/)) { if (rawLine.length === 0) { lines.push(""); continue; } for (let index = 0; index < rawLine.length; index += limit) lines.push(rawLine.slice(index, index + limit)); } return lines; }
`, "utf8");
  const stubUrl = pathToFileURL(stub).href;
  if (typeof moduleApi.registerHooks === "function") {
    moduleApi.registerHooks({ resolve(specifier, context, nextResolve) { if (specifier === "@earendil-works/pi-tui") return { url: stubUrl, shortCircuit: true }; return nextResolve(specifier, context); } });
    return;
  }
  await writeFile(loader, `
const stubUrl = ${JSON.stringify(stubUrl)};
export async function resolve(specifier, context, nextResolve) { if (specifier === "@earendil-works/pi-tui") return { url: stubUrl, shortCircuit: true }; return nextResolve(specifier, context); }
`, "utf8");
  moduleApi.register(pathToFileURL(loader).href);
}

async function importFresh() {
  return await import(`${extensionUrl.href}?rpc-oversize=${Date.now()}-${Math.random()}`);
}

async function makeFakeLarvaCli(dir) {
  const cli = join(dir, "fake-larva-cli.mjs");
  await writeFile(cli, `
const [, , command, personaId, jsonFlag] = process.argv;
if (command === "resolve" && jsonFlag === "--json") {
  process.stdout.write(JSON.stringify({ data: { id: personaId, description: "Persona " + personaId, prompt: "Prompt for " + personaId, model: "provider/model", capabilities: {}, spec_version: "0.1.0", spec_digest: "sha256:" + personaId, can_spawn: true } }));
  process.exit(0);
}
process.exit(3);
`, "utf8");
  return cli;
}

async function makeFakePi(dir) {
  const fakePi = join(dir, "fake-pi-rpc-stream.mjs");
  await writeFile(fakePi, `#!/usr/bin/env node
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const extension = await import(pathToFileURL(process.env.LARVA_PI_EXTENSION_ENTRY).href + "?child-writer=" + Date.now());
extension.installChildRpcFrameWriterForTests(process.env);

const sessionDirIndex = process.argv.indexOf("--session-dir");
const sessionDir = sessionDirIndex >= 0 ? process.argv[sessionDirIndex + 1] : process.cwd();
const sessionFile = join(sessionDir, "child-session.jsonl");
const commandTrace = process.env.LARVA_TEST_PARENT_COMMAND_TRACE;
const huge = (prefix) => prefix + ":\\nquote=\\\" slash=\\\\ unicode=中文🙂\\n" + "x".repeat(1_220_000);
const finals = {
  "oversized-final": huge(${JSON.stringify(RAW_FINAL_PREFIX)}),
  "terminal-late-oversized": huge(${JSON.stringify(RAW_FINAL_PREFIX)} + ":late"),
  "artifact-failure": huge(${JSON.stringify(RAW_FINAL_PREFIX)} + ":write-failure"),
};
let scenario = "";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (commandTrace) await appendFile(commandTrace, line + "\\n", "utf8");
  const message = JSON.parse(line);
  if (message.type === "get_state") {
    await mkdir(sessionDir, { recursive: true });
    await writeFile(sessionFile, "", "utf8");
    send({ id: message.id, type: "response", command: "get_state", success: true, data: { sessionFile, model: { provider: "provider", id: "model" }, thinkingLevel: process.env.LARVA_PI_CHILD_REQUESTED_THINKING || "high" } });
    return;
  }
  if (message.type === "switch_session") { send({ id: message.id, type: "response", command: "switch_session", success: true, data: {} }); return; }
  if (message.type === "prompt") {
    scenario = message.message;
    send({ id: message.id, type: "response", command: "prompt", success: true, data: {} });
    if (scenario === "oversized-tool") {
      send({ type: "tool_execution_start", toolCallId: "tool-big", toolName: "read", args: { path: "/tmp/proof", content: huge(${JSON.stringify(RAW_TOOL_PREFIX)}) } });
    } else if (scenario === "oversized-assistant") {
      send({ type: "message_update", channel: "assistant", assistantMessageEvent: { delta: huge(${JSON.stringify(RAW_ASSISTANT_PREFIX)}) }, message: huge("RAW_FULL_ASSISTANT_PARTIAL") });
    } else if (scenario === "oversized-thinking") {
      send({ type: "message_update", channel: "thinking", assistantMessageEvent: { type: "thinking_delta", delta: huge(${JSON.stringify(RAW_THINKING_PREFIX)}) }, message: huge("RAW_FULL_THINKING_PARTIAL") });
    } else if (scenario === "oversized-final" || scenario === "terminal-late-oversized" || scenario === "artifact-failure") {
      send({ type: "message_update", channel: "assistant", assistantMessageEvent: { delta: huge(${JSON.stringify(RAW_ASSISTANT_PREFIX)} + ":pre-terminal") }, message: huge("RAW_PRE_TERMINAL_PARTIAL") });
    }
    send({ type: "agent_settled", status: "success" });
    return;
  }
  if (message.type === "get_last_assistant_text") {
    if (scenario === "terminal-late-oversized") send({ type: "message_update", channel: "assistant", assistantMessageEvent: { delta: huge(${JSON.stringify(RAW_ASSISTANT_PREFIX)} + ":after-terminal") }, message: huge("RAW_LATE_PARTIAL") });
    send({ id: message.id, type: "response", command: "get_last_assistant_text", success: true, data: { text: finals[scenario] ?? ${JSON.stringify(SHORT_FINAL)} } });
  }
});
`, "utf8");
  await chmod(fakePi, 0o755);
  return fakePi;
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${label}`);
}

async function readJsonLines(path) {
  try {
    const text = await readFile(path, "utf8");
    return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function assertNoRawPayloadEscaped(mod, traceFrames, currentTaskId) {
  const presentation = mod.subagentPresentationLogForTests().filter((entry) => entry.task_id === currentTaskId);
  const events = mod.larva_subagent_events({ task_ids: [currentTaskId], limit: 100 }).details;
  const status = mod.larva_subagent_status({ task_id: currentTaskId });
  const publicJson = JSON.stringify({ traceFrames, presentation, events, status });
  for (const marker of [RAW_FINAL_PREFIX, RAW_TOOL_PREFIX, RAW_ASSISTANT_PREFIX, RAW_THINKING_PREFIX, "RAW_FULL_ASSISTANT_PARTIAL", "RAW_FULL_THINKING_PARTIAL", "RAW_LATE_PARTIAL"]) {
    if (publicJson.includes(marker)) {
      const at = publicJson.indexOf(marker);
      throw new Error(`raw oversized payload escaped bounded state: ${marker}: ${publicJson.slice(Math.max(0, at - 140), at + marker.length + 140)}`);
    }
  }
}

async function runScenario(mod, base, scenario, { blockArtifacts = false } = {}) {
  const scenarioDir = join(base.root, scenario);
  const sessionDir = join(scenarioDir, "sessions");
  const traceFile = join(scenarioDir, "child-rpc-trace.jsonl");
  const parentCommandTrace = join(scenarioDir, "parent-command-trace.jsonl");
  const outboundTrace = join(scenarioDir, "child-outbound-trace.jsonl");
  const artifactDir = blockArtifacts ? join(scenarioDir, "artifact-parent-file") : join(scenarioDir, "artifacts");
  await mkdir(scenarioDir, { recursive: true });
  if (blockArtifacts) await writeFile(artifactDir, "not a directory", "utf8");
  const callbacks = [];
  const env = {
    LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, base.fakeCli]),
    LARVA_PI_REAL_BIN: base.fakePi,
    LARVA_PI_EXTENSION_FLAG: "-e",
    LARVA_PI_EXTENSION_ENTRY: join(root, "contrib/pi-extension/larva.ts"),
    LARVA_PI_LAUNCHED: "1",
    LARVA_PI_CHILD_SESSION_DIR: sessionDir,
    LARVA_PI_CHILD_RPC_TRACE_FILE: traceFile,
    LARVA_PI_CHILD_RPC_OUTBOUND_TRACE_FILE: outboundTrace,
    LARVA_PI_SUBAGENT_ARTIFACT_DIR: artifactDir,
    LARVA_TEST_PARENT_COMMAND_TRACE: parentCommandTrace,
    ...(blockArtifacts ? { LARVA_PI_TEST_DISABLE_STANDARD_ARTIFACT_FALLBACKS: "1" } : {}),
  };
  const accepted = await mod.larva_subagent(
    { persona_id: "child", task: scenario },
    { env, sendMessage: async (message) => { callbacks.push(message); } },
  );
  assert.equal(accepted.status, "accepted", `${scenario}: child must be accepted before terminal observation: ${JSON.stringify(accepted)}`);
  const callback = await waitFor(() => callbacks[0] ?? null, `${scenario} callback`);
  const wait = await mod.larva_subagent_wait({ task_ids: [accepted.task_id], return_when: "all", timeout_ms: 5_000 }, { env });
  const select = await mod.larva_subagent_select({ task_ids: [accepted.task_id], timeout_ms: 0 }, { env });
  const traceFrames = await readJsonLines(traceFile);
  const commands = await readJsonLines(parentCommandTrace);
  const outboundFrames = await readJsonLines(outboundTrace);
  for (const command of commands) {
    assert.ok(Buffer.byteLength(JSON.stringify(command), "utf8") <= RPC_LIMIT, `${scenario}: parent command exceeded RPC byte limit`);
  }
  assert.ok(outboundFrames.length > 0, `${scenario}: controlled child must record bounded outbound frames`);
  assert.ok(outboundFrames.some((entry) => entry.frame?.oversized || entry.frame?.data?.output_delivery), `${scenario}: outbound proof must include bounded replacement metadata`);
  for (const entry of outboundFrames) {
    assert.ok(entry.encoded_bytes <= RPC_LIMIT, `${scenario}: controlled child outbound frame exceeded RPC byte limit: ${JSON.stringify(entry).slice(0, 500)}`);
    assert.ok(Buffer.byteLength(JSON.stringify(entry.frame), "utf8") <= RPC_LIMIT, `${scenario}: enumerated outbound frame exceeded RPC byte limit`);
  }
  assertNoRawPayloadEscaped(mod, traceFrames, accepted.task_id);
  return { accepted, callback, wait, select, traceFrames, outboundFrames };
}

function assertSeparatedTerminalState(result, deliveryStatus) {
  for (const surface of [result.callback.details, result.wait.details.terminal_result, result.select.details.terminal_result]) {
    assert.equal(surface.execution_status, "success");
    assert.equal(surface.delivery_status, deliveryStatus);
    assert.equal(surface.status, "success", "compatibility status remains execution-owned");
    assert.equal(surface.phase, "success", "compatibility phase remains execution-owned");
  }
}

async function main() {
  const runtimeDir = await mkdtemp(join(tmpdir(), "larva-pi-rpc-oversize-"));
  try {
    await installPiTuiStub(runtimeDir);
    const mod = await importFresh();
    mod.resetSubagentPresentationStateForTests();
    const fakeCli = await makeFakeLarvaCli(runtimeDir);
    const fakePi = await makeFakePi(runtimeDir);
    const base = { root: runtimeDir, fakeCli, fakePi };
    const ctx = { env: { LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, fakeCli]) }, ui: { setStatus: async () => undefined, notify: async () => undefined }, modelRegistry: { find: async () => ({ provider: "provider", modelId: "model" }) } };
    const pi = { getAllTools: async () => ["larva_subagent"], setActiveTools: async () => true, setModel: async () => true, registerCommand: () => undefined, registerTool: () => undefined, on: () => undefined };
    const parentPersona = await mod.handlePersonaCommand("parent", ctx, pi);
    assert.equal(parentPersona.ok, true, "parent persona must be active");

    for (const scenario of ["oversized-tool", "oversized-assistant", "oversized-thinking"]) {
      const result = await runScenario(mod, base, scenario);
      assertSeparatedTerminalState(result, "inline");
    }

    const finalResult = await runScenario(mod, base, "oversized-final");
    assertSeparatedTerminalState(finalResult, "artifactized");
    const manifest = finalResult.callback.details.full_output_artifact;
    assert.ok(manifest && typeof manifest.path === "string", "oversized final output must publish an artifact manifest");
    const artifactBytes = await readFile(manifest.path);
    assert.equal(artifactBytes.byteLength, manifest.bytes);
    assert.equal(createHash("sha256").update(artifactBytes).digest("hex"), manifest.sha256);
    assert.equal(artifactBytes.toString("utf8").split(/\r\n|\r|\n/).length, manifest.lines);
    assert.ok(artifactBytes.toString("utf8").startsWith(RAW_FINAL_PREFIX), "artifact must preserve exact decoded child output");
    assert.equal((await stat(manifest.path)).isFile(), true);

    const lateResult = await runScenario(mod, base, "terminal-late-oversized");
    assertSeparatedTerminalState(lateResult, "artifactized");

    const failedDelivery = await runScenario(mod, base, "artifact-failure", { blockArtifacts: true });
    assertSeparatedTerminalState(failedDelivery, "failed");
    assert.equal(failedDelivery.callback.details.error, null, "artifact failure cannot rewrite successful execution");
    assert.match(failedDelivery.callback.details.delivery_diagnostic.code, /^LARVA_CHILD_OUTPUT_/);

    const boundedOutbound = [...finalResult.outboundFrames, ...lateResult.outboundFrames, ...failedDelivery.outboundFrames];
    assert.ok(boundedOutbound.length >= 3, "bounded writer must emit controlled outbound evidence");
    for (const entry of boundedOutbound) {
      assert.ok(entry.encoded_bytes <= RPC_LIMIT, "writer-side diagnostic frame must stay within the limit");
      assert.equal(JSON.stringify(entry).includes(RAW_FINAL_PREFIX), false);
    }

    console.log("subagent child RPC memory bound regression: PASS");
  } finally {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await rm(runtimeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
        break;
      } catch (error) {
        if (attempt === 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
}
