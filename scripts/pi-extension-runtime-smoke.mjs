#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

const SCENARIOS = [
  "availability",
  "get-commands",
  "slash-status",
  "startup-status",
  "failure-path",
  "tool-shape",
  "tool-call-block",
];

function usage() {
  return `Usage: node scripts/pi-extension-runtime-smoke.mjs --scenario <name>\n\nScenarios:\n${SCENARIOS.map((name) => `  - ${name}`).join("\n")}\n`;
}

function parseArgs(argv) {
  const parsed = new Map();
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--help" || key === "-h") parsed.set("help", "1");
    else if (key?.startsWith("--")) parsed.set(key.slice(2), argv[index + 1] ?? "");
  }
  return parsed;
}

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const extensionPath = join(root, "contrib", "pi-extension", "larva.ts");
const fakeCli = join(root, "tests", "fixtures", "pi", "fake-larva-cli.mjs");

function baseEvidence(scenario) {
  return {
    scenario,
    pi: { binary: process.env.PI_BIN || "pi", available: false, helpExitCode: null, extensionFlag: null },
    extension: { path: extensionPath },
    rpc: { attempted: false, supported: null, events: [], responses: [], stderr: "" },
    runtime: {},
  };
}

function runProcess(command, args, options = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs ?? 5_000);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveRun({ exitCode: null, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveRun({ exitCode: code, signal, stdout, stderr });
    });
  });
}

async function piAvailability(evidence) {
  const binary = evidence.pi.binary;
  const help = await runProcess(binary, ["--help"], { timeoutMs: 5_000 });
  evidence.pi.helpExitCode = help.exitCode;
  evidence.pi.available = help.exitCode === 0;
  const helpText = `${help.stdout}${help.stderr}`;
  evidence.pi.helpSnippet = helpText.slice(0, 500);
  if (evidence.pi.available) {
    if (helpText.includes("--extension")) evidence.pi.extensionFlag = "--extension";
    if (helpText.includes("-e")) evidence.pi.extensionFlag = "-e";
  }
  return evidence.pi;
}

function runtimeEnv(overrides = {}) {
  return {
    ...process.env,
    PI_OFFLINE: "1",
    LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, fakeCli]),
    LARVA_PI_REAL_BIN: process.env.PI_BIN || "pi",
    LARVA_PI_EXTENSION_FLAG: "-e",
    LARVA_PI_EXTENSION_ENTRY: extensionPath,
    ...overrides,
  };
}

async function runPiRpc(evidence, { initialPersona, commands = [] } = {}) {
  await piAvailability(evidence);
  evidence.rpc.attempted = true;
  if (!evidence.pi.available || !evidence.pi.extensionFlag) {
    evidence.rpc.supported = false;
    evidence.rpc.limitation = "Pi binary or extension flag is unavailable.";
    return evidence.rpc;
  }
  const sessionDir = await mkdtemp(join(tmpdir(), "larva-pi-runtime-session-"));
  const args = [
    evidence.pi.extensionFlag,
    extensionPath,
    "--mode",
    "rpc",
    "--no-session",
    "--offline",
    "--session-dir",
    sessionDir,
  ];
  const env = runtimeEnv(initialPersona ? { LARVA_PI_INITIAL_PERSONA_ID: initialPersona } : {});
  const child = spawn(evidence.pi.binary, args, { env, cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  const rl = createInterface({ input: child.stdout });
  const pending = new Map();
  child.stderr.on("data", (chunk) => { evidence.rpc.stderr += chunk.toString("utf8"); });
  rl.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { evidence.rpc.events.push({ type: "malformed", line }); return; }
    if (message && typeof message === "object" && message.id && pending.has(String(message.id))) {
      pending.get(String(message.id))(message);
      pending.delete(String(message.id));
    } else {
      evidence.rpc.events.push(message);
    }
  });
  const closePromise = new Promise((resolveClose) => child.once("close", (code, signal) => resolveClose({ code, signal })));
  async function request(id, body, timeoutMs = 1_500) {
    const response = await new Promise((resolveResponse) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolveResponse({ id, timeout: true });
      }, timeoutMs);
      pending.set(id, (value) => { clearTimeout(timer); resolveResponse(value); });
      child.stdin.write(`${JSON.stringify({ id, ...body })}\n`);
    });
    evidence.rpc.responses.push(response);
    return response;
  }
  for (const command of commands) await request(command.id, command.body, command.timeoutMs);
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  child.kill("SIGTERM");
  evidence.rpc.exit = await Promise.race([closePromise, new Promise((resolveWait) => setTimeout(() => resolveWait({ timeout: true }), 1_500))]);
  evidence.rpc.supported = evidence.rpc.events.some((event) => event?.type === "extension_ui_request") || evidence.rpc.responses.some((response) => response && response.timeout !== true);
  evidence.rpc.uiRequests = evidence.rpc.events.filter((event) => event?.type === "extension_ui_request");
  if (!evidence.rpc.supported && evidence.rpc.stderr.trim().length > 0) {
    evidence.rpc.loadFailure = true;
    evidence.rpc.limitation = "Pi RPC emitted stderr without observable extension UI/custom command surfaces; treating as plugin/runtime failure.";
  } else if (!evidence.rpc.supported) {
    evidence.rpc.loadFailure = false;
    evidence.rpc.limitation = "Current Pi RPC did not expose extension UI/custom command surfaces during this smoke run.";
  }
  return evidence.rpc;
}

async function runtimeHarness(evidence, { initialPersona = "ok" } = {}) {
  const mod = await import(pathToFileURL(extensionPath).href);
  const registeredTools = [];
  const handlers = new Map();
  const statuses = [];
  const notifications = [];
  const ctx = {
    env: runtimeEnv({ LARVA_PI_INITIAL_PERSONA_ID: initialPersona }),
    ui: {
      setStatus: async (...args) => { statuses.push(args); },
      notify: async (...args) => { notifications.push(args); },
      addAutocompleteProvider: () => undefined,
    },
    modelRegistry: { find: async (provider, modelId) => ({ provider, modelId }) },
  };
  const pi = {
    getAllTools: async () => ["read"],
    setActiveTools: async () => true,
    setModel: async () => true,
    registerCommand: () => undefined,
    registerTool: (tool) => { registeredTools.push(tool); },
    on: (event, handler) => { handlers.set(event, handler); },
  };
  await mod.initializeExtension(ctx, pi);
  evidence.runtime.statuses = statuses;
  evidence.runtime.notifications = notifications;
  evidence.runtime.registeredToolNames = registeredTools.map((tool) => tool.name);
  evidence.runtime.handlers = Array.from(handlers.keys());
  evidence.runtime.larvaSubagent = registeredTools.find((tool) => tool.name === "larva_subagent") ?? null;
  evidence.runtime.toolCallHandler = handlers.get("tool_call") ?? null;
  return evidence.runtime;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.has("help")) {
    process.stdout.write(usage());
    return;
  }
  const scenario = args.get("scenario") || args.get("case");
  if (!SCENARIOS.includes(scenario)) throw new Error(`unknown or missing scenario: ${scenario ?? ""}`);
  const evidence = baseEvidence(scenario);
  if (scenario === "availability") {
    await piAvailability(evidence);
  } else if (scenario === "get-commands") {
    await runPiRpc(evidence, { commands: [{ id: "commands-1", body: { type: "get_commands" } }] });
  } else if (scenario === "slash-status") {
    await runPiRpc(evidence, { commands: [{ id: "prompt-1", body: { type: "prompt", message: "/larva-persona ok" }, timeoutMs: 2_000 }] });
  } else if (scenario === "startup-status") {
    await runPiRpc(evidence, { initialPersona: "startup", commands: [{ id: "state-1", body: { type: "get_state" } }] });
  } else if (scenario === "failure-path") {
    await runPiRpc(evidence, { initialPersona: "missing", commands: [{ id: "state-1", body: { type: "get_state" } }] });
  } else if (scenario === "tool-shape") {
    await runtimeHarness(evidence);
    const tool = evidence.runtime.larvaSubagent;
    evidence.runtime.assertions = {
      hasLarvaSubagent: Boolean(tool),
      hasParameters: Boolean(tool?.parameters && tool.parameters.type === "object"),
      hasExecute: typeof tool?.execute === "function",
    };
  } else if (scenario === "tool-call-block") {
    await runtimeHarness(evidence);
    const result = await evidence.runtime.toolCallHandler?.({ toolName: "bash" });
    evidence.runtime.toolCallResult = result;
    evidence.runtime.assertions = {
      blockTrue: result?.block === true,
      nonEmptyReason: typeof result?.reason === "string" && result.reason.length > 0,
    };
  }
  const serializable = JSON.parse(JSON.stringify(evidence, (key, value) => (typeof value === "function" ? "[function]" : value)));
  console.log(JSON.stringify(serializable, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
