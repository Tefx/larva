#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const extensionPath = join(root, "contrib/pi-extension/larva.ts");
const extensionUrl = pathToFileURL(extensionPath).href;
const preloadPath = join(root, "contrib/pi-extension/child-rpc-frame-preload.mjs");
const preloadUrl = pathToFileURL(preloadPath).href;
const piPackageRoot = join(root, "contrib/pi-extension/node_modules/@earendil-works/pi-coding-agent");
const outputGuardPath = join(piPackageRoot, "dist/core/output-guard.js");
const outputGuardUrl = pathToFileURL(outputGuardPath).href;
const RPC_LIMIT = 1_048_576;
const CAPABILITY = "larva-child-rpc-frame-preload-v1";
const CAPABILITY_FIELD = "larvaChildRpcFrame";
const RAW_HISTORY = "RAW_REAL_PI_HISTORY_MUST_NOT_ESCAPE";
const RAW_FINAL = "RAW_REAL_PI_FINAL_MUST_ONLY_EXIST_IN_ARTIFACT";
const RAW_FAILURE = "RAW_PROVIDER_FAILURE_PRIVATE_DETAIL";
const SHORT_FINAL = "real Pi bounded inline final";

function waitForClose(child) {
  return new Promise((resolveClose, rejectClose) => {
    child.once("error", rejectClose);
    child.once("close", (code, signal) => resolveClose({ code, signal }));
  });
}

async function readJsonLines(path) {
  try {
    const text = await readFile(path, "utf8");
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line.endsWith("\r") ? line.slice(0, -1) : line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function runActualPiWriterProbe(runtimeDir) {
  const artifactDir = join(runtimeDir, "writer-artifacts");
  const outboundTrace = join(runtimeDir, "writer-outbound.jsonl");
  await mkdir(artifactDir, { recursive: true });
  const source = `
    const guard = await import(${JSON.stringify(outputGuardUrl)});
    guard.takeOverStdout();
    const extension = await import(${JSON.stringify(extensionUrl)} + "?actual-writer=" + Date.now());
    extension.installChildRpcFrameWriterForTests(process.env);
    const hugeHistory = ${JSON.stringify(RAW_HISTORY)} + ":" + "h".repeat(1_200_000);
    const hugeFinal = ${JSON.stringify(RAW_FINAL)} + ":\\nquote=\\\" slash=\\\\ unicode=中文🙂\\n" + "f".repeat(1_220_000);
    const emit = (value, ending = "\\n") => guard.writeRawStdout(JSON.stringify(value) + ending);
    emit({ id: "state", type: "response", command: "get_state", success: true, data: { sessionFile: "/tmp/real-pi.jsonl", text: "left middle right" } });
    emit({ type: "message_update", channel: "assistant", assistantMessageEvent: { delta: hugeHistory }, message: hugeHistory });
    emit({ type: "agent_end", willRetry: true, messages: [{ role: "assistant", content: [{ type: "text", text: hugeHistory }], stopReason: "error", errorMessage: "provider failed", diagnostics: [{ type: "provider_transport_failure", private: ${JSON.stringify(RAW_FAILURE)} + hugeHistory }] }] });
    emit({ type: "agent_settled" });
    emit({ id: "short", type: "response", command: "get_last_assistant_text", success: true, data: { text: ${JSON.stringify(SHORT_FINAL)} } }, "\\r\\n");
    emit({ id: "large", type: "response", command: "get_last_assistant_text", success: true, data: { text: hugeFinal } });
    await guard.waitForRawStdoutBackpressure();
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    cwd: root,
    env: {
      ...process.env,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${preloadUrl}`].filter(Boolean).join(" "),
      LARVA_PI_CHILD_RPC_FRAME_BOUND: "1",
      LARVA_PI_SUBAGENT_ARTIFACT_DIR: artifactDir,
      LARVA_PI_CHILD_RPC_OUTBOUND_TRACE_FILE: outboundTrace,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const closed = await waitForClose(child);
  assert.equal(closed.code, 0, `actual Pi writer probe failed: ${Buffer.concat(stderr).toString("utf8")}`);
  const wire = Buffer.concat(stdout);
  const rawRecords = wire.toString("utf8").split("\n").filter(Boolean);
  const recordBuffers = rawRecords.map((record) => Buffer.from(record.endsWith("\r") ? record.slice(0, -1) : record, "utf8"));
  const frames = recordBuffers.map((record) => JSON.parse(record.toString("utf8")));
  assert.equal(frames.length, 6, "actual writer probe must enumerate all six records");
  const maxBytes = Math.max(...recordBuffers.map((record) => record.byteLength));
  assert.ok(maxBytes <= RPC_LIMIT, `actual Pi writeRawStdout emitted ${maxBytes} bytes`);
  const stateFrame = frames.find((frame) => frame.id === "state");
  assert.deepEqual(stateFrame.data[CAPABILITY_FIELD], { capability: CAPABILITY, max_record_bytes: RPC_LIMIT, framing: "lf-only", terminal: "agent_settled" });
  assert.equal(stateFrame.data.text, "left middle right");
  const compactEnd = frames.find((frame) => frame.type === "agent_end");
  assert.equal(compactEnd.willRetry, true);
  assert.equal(compactEnd.messages, undefined);
  assert.equal(compactEnd.terminal_projection.status, "failure");
  assert.equal(compactEnd.terminal_projection.error.code, "LARVA_CHILD_RUNTIME_FAILED");
  assert.equal(compactEnd.terminal_projection.error.type, "provider_transport_failure");
  assert.ok(compactEnd.terminal_projection.error.message.length <= 700);
  assert.equal(frames.find((frame) => frame.id === "short").data.text, SHORT_FINAL);
  const largeDelivery = frames.find((frame) => frame.id === "large").data.output_delivery;
  assert.equal(largeDelivery.status, "artifactized");
  assert.equal(largeDelivery.limit, RPC_LIMIT);
  const artifactBytes = await readFile(largeDelivery.manifest.path);
  assert.equal((await stat(largeDelivery.manifest.path)).mode & 0o777, 0o600);
  assert.equal(artifactBytes.byteLength, largeDelivery.manifest.bytes);
  assert.equal(createHash("sha256").update(artifactBytes).digest("hex"), largeDelivery.manifest.sha256);
  assert.ok(artifactBytes.toString("utf8").startsWith(RAW_FINAL));
  const publicWire = wire.toString("utf8");
  assert.equal(publicWire.includes(RAW_HISTORY), false);
  assert.equal(publicWire.includes(RAW_FAILURE), false);
  assert.equal(publicWire.includes(RAW_FINAL), false);
  const outbound = await readJsonLines(outboundTrace);
  assert.ok(outbound.length >= 4);
  assert.equal(JSON.stringify(outbound).includes(RAW_HISTORY), false);
  assert.equal(JSON.stringify(outbound).includes(RAW_FINAL), false);
  return { record_count: frames.length, max_utf8_bytes: maxBytes, marker: stateFrame.data[CAPABILITY_FIELD], artifact: largeDelivery.manifest };
}

async function makeFakeLarvaCli(runtimeDir) {
  const cli = join(runtimeDir, "fake-larva-cli.mjs");
  await writeFile(cli, `
const [, , command, id, flag] = process.argv;
if (command === "resolve" && flag === "--json") {
  process.stdout.write(JSON.stringify({ data: { id, description: id, prompt: id, model: "loopback/model", capabilities: {}, spec_version: "0.1.0", spec_digest: "sha256:" + id, can_spawn: true } }));
  process.exit(0);
}
process.exit(3);
`, "utf8");
  return cli;
}

async function makeFakePi(runtimeDir) {
  const fakePi = join(runtimeDir, "fake-pi.mjs");
  await writeFile(fakePi, `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const extension = await import(pathToFileURL(process.env.LARVA_PI_EXTENSION_ENTRY).href + "?loopback-child=" + Date.now());
extension.installChildRpcFrameWriterForTests(process.env);
const sessionDir = process.argv[process.argv.indexOf("--session-dir") + 1];
await mkdir(sessionDir, { recursive: true });
const sessionFile = join(sessionDir, "loopback.jsonl");
await writeFile(sessionFile, "{}\\n", "utf8");
let scenario = "";
let settled = false;
const huge = (prefix) => prefix + ":" + "x".repeat(1_220_000);
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "get_state") return send({ id: message.id, type: "response", command: "get_state", success: true, data: { sessionFile, model: { provider: "loopback", id: "model" }, thinkingLevel: "medium" } });
  if (message.type === "prompt") {
    scenario = message.message;
    if (scenario === "delayed-prompt-ack") {
      return setTimeout(() => {
        send({ id: message.id, type: "response", command: "prompt", success: true, data: {} });
        settled = true;
        send({ type: "agent_settled" });
      }, 10_500);
    }
    send({ id: message.id, type: "response", command: "prompt", success: true, data: {} });
    if (scenario === "inline") send({ type: "tool_execution_end", toolCallId: "huge-tool", toolName: "read", success: true, output: huge(${JSON.stringify(RAW_HISTORY)}) });
    if (scenario === "retry") send({ type: "agent_end", willRetry: true, messages: [{ role: "assistant", content: [{ type: "text", text: "retry" }], stopReason: "error", errorMessage: "retry failure", diagnostics: [{ type: "provider_transport_failure" }] }] });
    if (scenario === "failure") {
      send({ type: "agent_end", willRetry: false, messages: [{ role: "assistant", content: [{ type: "text", text: "failed" }], stopReason: "error", errorMessage: "bounded provider failure", diagnostics: [{ type: "provider_transport_failure" }] }] });
      settled = true;
      return setTimeout(() => send({ type: "agent_settled" }), 20);
    }
    setTimeout(() => {
      if (scenario === "retry") send({ type: "agent_end", willRetry: false, messages: [{ role: "assistant", content: [{ type: "text", text: "retry recovered" }], stopReason: "stop" }] });
      settled = true;
      send({ type: "agent_settled" });
    }, 20);
    return;
  }
  if (message.type === "get_last_assistant_text") {
    if (scenario === "post-success-anomaly") {
      process.stdout.write("{malformed-after-settled\\n");
      return setTimeout(() => process.exit(0), 5);
    }
    const text = scenario === "artifact" ? huge(${JSON.stringify(RAW_FINAL)}) : scenario === "retry" && settled ? "retry settled final" : ${JSON.stringify(SHORT_FINAL)};
    send({ id: message.id, type: "response", command: "get_last_assistant_text", success: true, data: { text } });
    setTimeout(() => process.exit(0), 5);
  }
});
`, "utf8");
  await chmod(fakePi, 0o755);
  return fakePi;
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}

function terminalMetadata(surface) {
  return {
    task_id: surface.task_id,
    persona_id: surface.persona_id,
    status: surface.status,
    execution_status: surface.execution_status ?? surface.status,
    delivery_status: surface.delivery_status,
    phase: surface.phase,
    result_pending: surface.result_pending,
    error: surface.error,
    child_output_truncated: surface.child_output_truncated ?? false,
    full_output_artifact: surface.full_output_artifact ?? null,
  };
}

async function runPublicScenario(mod, base, scenario) {
  const scenarioDir = join(base.runtimeDir, scenario);
  const sessionDir = join(scenarioDir, "sessions");
  const traceFile = join(scenarioDir, "trace.jsonl");
  const artifactDir = join(scenarioDir, "artifacts");
  await mkdir(scenarioDir, { recursive: true });
  const callbacks = [];
  const env = {
    LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, base.fakeCli]),
    LARVA_PI_REAL_BIN: base.fakePi,
    LARVA_PI_EXTENSION_FLAG: "-e",
    LARVA_PI_EXTENSION_ENTRY: extensionPath,
    LARVA_PI_LAUNCHED: "1",
    LARVA_PI_CHILD_SESSION_DIR: sessionDir,
    LARVA_PI_CHILD_RPC_TRACE_FILE: traceFile,
    LARVA_PI_SUBAGENT_ARTIFACT_DIR: artifactDir,
  };
  const accepted = await mod.larva_subagent({ persona_id: "child", task: scenario }, { env, sendMessage: async (message) => callbacks.push(message) });
  assert.equal(accepted.status, "accepted", `${scenario}: must be accepted`);
  const callback = await waitFor(() => callbacks[0] ?? null, `${scenario} callback`);
  const wait = await mod.larva_subagent_wait({ task_ids: [accepted.task_id], return_when: "all", timeout_ms: 5_000 }, { env });
  const select = await mod.larva_subagent_select({ task_ids: [accepted.task_id], timeout_ms: 0 }, { env });
  const callbackSurface = callback.details;
  const waitSurface = wait.details.terminal_result;
  const selectSurface = select.details.terminal_result;
  assert.deepEqual(terminalMetadata(waitSurface), terminalMetadata(callbackSurface));
  assert.deepEqual(terminalMetadata(selectSurface), terminalMetadata(callbackSurface));
  const status = mod.larva_subagent_status({ task_id: accepted.task_id });
  const events = mod.larva_subagent_events({ task_ids: [accepted.task_id], limit: 100 }).details;
  const presentation = mod.subagentPresentationLogForTests().filter((entry) => entry.task_id === accepted.task_id);
  const trace = await readJsonLines(traceFile);
  const publicJson = JSON.stringify({ callbackSurface, waitSurface, selectSurface, status, events, presentation, trace });
  assert.equal(publicJson.includes(RAW_HISTORY), false, `${scenario}: history leaked`);
  assert.equal(publicJson.includes(RAW_FINAL), false, `${scenario}: final leaked`);
  return { accepted, callbackSurface, waitSurface, selectSurface, status, events, presentation, trace };
}

async function runParentSurfaceProbe(runtimeDir) {
  const mod = await import(`${extensionUrl}?real-parent=${Date.now()}`);
  mod.resetSubagentPresentationStateForTests();
  const fakeCli = await makeFakeLarvaCli(runtimeDir);
  const fakePi = await makeFakePi(runtimeDir);
  const ctx = { env: { LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, fakeCli]) }, ui: { setStatus: () => undefined }, modelRegistry: { find: () => ({ provider: "loopback", modelId: "model" }) } };
  const pi = { getAllTools: () => ["larva_subagent"], setActiveTools: () => true, setModel: () => true, registerCommand: () => undefined, registerTool: () => undefined, on: () => undefined };
  assert.equal((await mod.handlePersonaCommand("parent", ctx, pi)).ok, true);
  const base = { runtimeDir, fakeCli, fakePi };
  const inline = await runPublicScenario(mod, base, "inline");
  assert.equal(inline.callbackSurface.status, "success");
  assert.equal(inline.callbackSurface.delivery_status, "inline");
  assert.equal(inline.callbackSurface.result_text, SHORT_FINAL);
  const artifact = await runPublicScenario(mod, base, "artifact");
  assert.equal(artifact.callbackSurface.status, "success");
  assert.equal(artifact.callbackSurface.delivery_status, "artifactized");
  const manifest = artifact.callbackSurface.full_output_artifact;
  const artifactBytes = await readFile(manifest.path);
  assert.equal((await stat(manifest.path)).mode & 0o777, 0o600);
  assert.equal(artifactBytes.byteLength, manifest.bytes);
  assert.equal(createHash("sha256").update(artifactBytes).digest("hex"), manifest.sha256);
  assert.ok(artifactBytes.toString("utf8").startsWith(RAW_FINAL));
  const retry = await runPublicScenario(mod, base, "retry");
  assert.equal(retry.callbackSurface.status, "success");
  assert.equal(retry.callbackSurface.result_text, "retry settled final");
  const failure = await runPublicScenario(mod, base, "failure");
  assert.equal(failure.callbackSurface.status, "failed");
  assert.equal(failure.callbackSurface.error.code, "LARVA_CHILD_RUNTIME_FAILED");
  assert.ok(failure.callbackSurface.error.message.length <= 700);
  const anomaly = await runPublicScenario(mod, base, "post-success-anomaly");
  assert.equal(anomaly.callbackSurface.status, "success");
  assert.equal(anomaly.callbackSurface.execution_status, "success");
  assert.equal(anomaly.callbackSurface.delivery_status, "failed");
  assert.equal(anomaly.callbackSurface.error, null);
  const delayedPromptAck = await runPublicScenario(mod, base, "delayed-prompt-ack");
  assert.equal(delayedPromptAck.callbackSurface.status, "success");
  assert.equal(delayedPromptAck.callbackSurface.result_text, SHORT_FINAL);
  return { inline: terminalMetadata(inline.callbackSurface), artifact: terminalMetadata(artifact.callbackSurface), retry: terminalMetadata(retry.callbackSurface), failure: terminalMetadata(failure.callbackSurface), anomaly: terminalMetadata(anomaly.callbackSurface), delayed_prompt_ack: terminalMetadata(delayedPromptAck.callbackSurface) };
}

function runDecoderProbe(mod) {
  const utf8 = Buffer.from(`${JSON.stringify({ text: "left middle right🙂" })}\n`, "utf8");
  const split = [utf8.subarray(0, 9), utf8.subarray(9, utf8.length - 2), utf8.subarray(utf8.length - 2)];
  const decoded = mod.decodeChildRpcJsonlChunksForTests(split);
  assert.equal(decoded.error, null);
  assert.deepEqual(decoded.records, [{ text: "left middle right🙂" }]);
  const crlf = mod.decodeChildRpcJsonlChunksForTests([Buffer.from(`${JSON.stringify({ ok: true })}\r\n`)]);
  assert.equal(crlf.error, null);
  assert.deepEqual(crlf.records, [{ ok: true }]);
  assert.equal(mod.decodeChildRpcJsonlChunksForTests([Buffer.from("{bad}\n")]).error?.message, "Child emitted malformed JSONL.");
  assert.equal(mod.decodeChildRpcJsonlChunksForTests([Buffer.from([0xff, 0x0a])]).error?.message, "Child emitted invalid UTF-8 JSONL.");
  assert.equal(mod.decodeChildRpcJsonlChunksForTests([Buffer.from("{}")]).error?.message, "Child emitted unterminated JSONL.");
  const oversized = mod.decodeChildRpcJsonlChunksForTests([Buffer.alloc(RPC_LIMIT + 1, 0x78)]);
  assert.equal(oversized.records.length, 0);
  assert.match(oversized.error?.message ?? "", /oversized JSONL frame/);
  return { lf_only_unicode_separators: true, crlf: true, split_utf8: true, malformed_bounded: true, oversized_preparse: true };
}

async function main() {
  const runtimeDir = await mkdtemp(join(tmpdir(), "larva-real-pi-0841-"));
  try {
    const packageJson = JSON.parse(await readFile(join(piPackageRoot, "package.json"), "utf8"));
    assert.equal(packageJson.version, "0.84.1", "real seam proof requires exact Pi 0.84.1");
    const guardSource = await readFile(outputGuardPath, "utf8");
    assert.match(guardSource, /function takeOverStdout/);
    assert.match(guardSource, /function writeRawStdout/);
    const writer = await runActualPiWriterProbe(runtimeDir);
    const mod = await import(`${extensionUrl}?decoder=${Date.now()}`);
    const decoder = runDecoderProbe(mod);
    const publicSurfaces = await runParentSurfaceProbe(runtimeDir);
    console.error(JSON.stringify({ pi_version: packageJson.version, actual_writer: { module: outputGuardPath, ...writer }, decoder, public_surfaces: publicSurfaces }));
    console.log("subagent real Pi 0.84.1 writeRawStdout regression: PASS");
  } finally {
    await rm(runtimeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
}

try {
  await main();
} catch (error) {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
}
