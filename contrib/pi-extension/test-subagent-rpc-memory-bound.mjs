#!/usr/bin/env node
import assert from "node:assert/strict";
import * as moduleApi from "node:module";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const extensionUrl = pathToFileURL(join(root, "contrib/pi-extension/larva.ts"));
const RAW_MESSAGE_PREFIX = "RAW_GROWING_MESSAGE_UPDATE_PARTIAL_SHOULD_NOT_ESCAPE";
const DELTAS = ["safe-delta-0 ", "safe-delta-1 ", "safe-delta-2 ", "safe-delta-3 ", "safe-delta-4 "];

async function installPiTuiStub(dir) {
  const stub = join(dir, "pi-tui-stub.mjs");
  const loader = join(dir, "pi-tui-loader.mjs");
  await writeFile(stub, `
export class Input {
  constructor() { this.value = ""; }
  handleInput(data) { this.value += data; return true; }
  render() { return this.value; }
}
export const Key = {
  escape: "escape",
  enter: "enter",
  down: "down",
  up: "up",
  pageDown: "pagedown",
  pageUp: "pageup",
  home: "home",
  end: "end",
  left: "left",
  right: "right",
  ctrl: (key) => "ctrl+" + key,
  ctrlAlt: (key) => "ctrl+alt+" + key,
};
export class Markdown {
  constructor(source) { this.source = String(source ?? ""); }
  render(width) { return wrapTextWithAnsi(this.source, width || 80); }
}
export class SelectList {
  constructor(items = []) { this.items = items; this.selectedIndex = 0; }
  setItems(items = []) { this.items = items; this.selectedIndex = 0; }
  handleInput() { return false; }
  selectedItem() { return this.items[this.selectedIndex] ?? null; }
  render() { return this.items.map((item) => String(item?.label ?? item?.value ?? "")); }
}
export function matchesKey(data, key) { return data === key; }
export function visibleWidth(value) { return String(value ?? "").replace(/\\x1b\\[[0-9;]*m/g, "").length; }
export function truncateToWidth(value, width, suffix = "", pad = false) {
  const text = String(value ?? "");
  const limit = Math.max(0, Number(width) || 0);
  const truncated = text.length > limit ? text.slice(0, Math.max(0, limit - String(suffix).length)) + suffix : text;
  return pad ? truncated.padEnd(limit, " ") : truncated;
}
export function wrapTextWithAnsi(value, width) {
  const text = String(value ?? "");
  const limit = Math.max(1, Number(width) || 80);
  const lines = [];
  for (const rawLine of text.split(/\\r?\\n/)) {
    if (rawLine.length === 0) { lines.push(""); continue; }
    for (let index = 0; index < rawLine.length; index += limit) lines.push(rawLine.slice(index, index + limit));
  }
  return lines;
}
`, "utf8");
  const stubUrl = pathToFileURL(stub).href;
  if (typeof moduleApi.registerHooks === "function") {
    moduleApi.registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "@earendil-works/pi-tui") return { url: stubUrl, shortCircuit: true };
        return nextResolve(specifier, context);
      },
    });
    return;
  }
  await writeFile(loader, `
const stubUrl = ${JSON.stringify(stubUrl)};
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@earendil-works/pi-tui") return { url: stubUrl, shortCircuit: true };
  return nextResolve(specifier, context);
}
`, "utf8");
  moduleApi.register(pathToFileURL(loader).href);
}

async function importFresh() {
  return await import(`${extensionUrl.href}?rpc-memory-bound=${Date.now()}-${Math.random()}`);
}

async function makeFakeLarvaCli(dir) {
  const cli = join(dir, "fake-larva-cli.mjs");
  await writeFile(cli, `
const [, , command, personaId, jsonFlag] = process.argv;
if (command === "resolve" && jsonFlag === "--json") {
  process.stdout.write(JSON.stringify({ data: {
    id: personaId,
    description: "Persona " + personaId,
    prompt: "Prompt for " + personaId,
    model: "provider/model",
    capabilities: {},
    spec_version: "0.1.0",
    spec_digest: "sha256:" + personaId,
    can_spawn: true
  }}));
  process.exit(0);
}
process.exit(3);
`, "utf8");
  return cli;
}

async function makeFakePi(dir) {
  const fakePi = join(dir, "fake-pi-rpc-stream.mjs");
  await writeFile(fakePi, `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const sessionDirIndex = process.argv.indexOf("--session-dir");
const sessionDir = sessionDirIndex >= 0 ? process.argv[sessionDirIndex + 1] : process.cwd();
const sessionFile = join(sessionDir, "child-session.jsonl");
const rawPrefix = ${JSON.stringify(RAW_MESSAGE_PREFIX)};
const deltas = ${JSON.stringify(DELTAS)};
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const rl = createInterface({ input: process.stdin });

rl.on("line", async (line) => {
  const message = JSON.parse(line);
  if (message.type === "get_state") {
    await mkdir(sessionDir, { recursive: true });
    await writeFile(sessionFile, "", "utf8");
    send({ id: message.id, success: true, data: { sessionFile } });
    return;
  }
  if (message.type === "switch_session") {
    send({ id: message.id, success: true, data: {} });
    return;
  }
  if (message.type === "prompt") {
    send({ id: message.id, success: true, data: {} });
    for (let index = 0; index < deltas.length; index += 1) {
      const partial = rawPrefix + ":" + index + ":" + "x".repeat((index + 1) * 12000);
      send({
        type: "message_update",
        channel: "assistant",
        assistantMessageEvent: { delta: deltas[index] },
        message: partial
      });
    }
    send({ type: "agent_end" });
    return;
  }
  if (message.type === "get_last_assistant_text") {
    send({ id: message.id, success: true, data: { text: deltas.join("") } });
  }
});
`, "utf8");
  await chmod(fakePi, 0o755);
  return fakePi;
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${label}`);
}

async function readTraceWhenReady(traceFile) {
  return await waitFor(async () => {
    try {
      const text = await readFile(traceFile, "utf8");
      return text.includes("message_update") || text.includes(RAW_MESSAGE_PREFIX) ? text : null;
    } catch {
      return null;
    }
  }, "child RPC trace containing message_update frames");
}

function assertNoRawGrowingPartialEscaped(mod, traceText) {
  if (traceText.includes(RAW_MESSAGE_PREFIX)) {
    throw new Error("LARVA_PI_CHILD_RPC_TRACE_FILE contained raw child RPC payload: message_update.message full growing partial was traced");
  }

  const presentation = JSON.stringify(mod.subagentPresentationLogForTests());
  if (presentation.includes(RAW_MESSAGE_PREFIX)) {
    throw new Error("growing partial message escaped bounded retention: presentation log exposed message_update.message");
  }

  const eventsResult = mod.larva_subagent_events({ limit: 25 });
  const eventsJson = JSON.stringify(eventsResult.details.events);
  if (eventsJson.includes(RAW_MESSAGE_PREFIX)) {
    throw new Error("growing partial message escaped bounded retention: model-facing events exposed message_update.message");
  }
}

function assertSafeDeltasWereUsed(mod) {
  const presentation = JSON.stringify(mod.subagentPresentationLogForTests());
  for (const delta of DELTAS) {
    assert.ok(
      presentation.includes(delta),
      `assistantMessageEvent.delta safe source was not reflected in bounded presentation state: ${delta}`,
    );
  }
}

async function main() {
  const runtimeDir = await mkdtemp(join(tmpdir(), "larva-pi-rpc-memory-bound-"));
  try {
    await installPiTuiStub(runtimeDir);
    const mod = await importFresh();
    mod.resetSubagentPresentationStateForTests();

    const fakeCli = await makeFakeLarvaCli(runtimeDir);
    const fakePi = await makeFakePi(runtimeDir);
    const sessionDir = join(runtimeDir, "sessions");
    const traceFile = join(runtimeDir, "child-rpc-trace.jsonl");
    await mkdir(sessionDir, { recursive: true });

    const env = {
      LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, fakeCli]),
      LARVA_PI_REAL_BIN: fakePi,
      LARVA_PI_EXTENSION_FLAG: "-e",
      LARVA_PI_EXTENSION_ENTRY: join(runtimeDir, "extension.ts"),
      LARVA_PI_LAUNCHED: "1",
      LARVA_PI_CHILD_SESSION_DIR: sessionDir,
      LARVA_PI_CHILD_RPC_TRACE_FILE: traceFile,
    };
    const ctx = {
      env,
      ui: { setStatus: async () => undefined, notify: async () => undefined },
      modelRegistry: { find: async () => ({ provider: "provider", modelId: "model" }) },
    };
    const pi = {
      getAllTools: async () => ["larva_subagent"],
      setActiveTools: async () => true,
      setModel: async () => true,
      registerCommand: () => undefined,
      registerTool: () => undefined,
      on: () => undefined,
    };

    const parentPersona = await mod.handlePersonaCommand("parent", ctx, pi);
    assert.equal(parentPersona.ok, true, "parent persona must be committed before spawning subagent");

    const accepted = await mod.larva_subagent({ persona_id: "child", task: "emit growing message_update frames" }, { env });
    assert.equal(accepted.status, "accepted", "subagent call must reach accepted state before memory-bound checks");
    assert.equal(accepted.result_pending, true);

    await waitFor(() => {
      const entry = mod.subagentPresentationLogForTests().find((candidate) => candidate.task_id === accepted.task_id && candidate.status === "success");
      return entry ?? null;
    }, "terminal successful subagent presentation entry");

    const traceText = await readTraceWhenReady(traceFile);
    assertNoRawGrowingPartialEscaped(mod, traceText);
    assertSafeDeltasWereUsed(mod);

    console.log("subagent child RPC memory bound regression: PASS");
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
}
