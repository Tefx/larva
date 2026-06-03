#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { access, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

const SCENARIOS = [
  "availability",
  "get-commands",
  "slash-status",
  "startup-status",
  "startup-fatal",
  "failure-path",
  "tool-shape",
  "tool-result-renderer-shape",
  "fresh-session-validation",
  "tool-call-block",
  "capability-gates",
  "live-child-rpc-proof",
  "subagent-log-selector-streaming",
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
const piExtensionRoot = join(root, "contrib", "pi-extension");
const piExtensionPackageJson = join(piExtensionRoot, "package.json");
const piExtensionLockfile = join(piExtensionRoot, "package-lock.json");
const piExtensionNodeModules = join(piExtensionRoot, "node_modules");
const pinnedPiTuiVersion = "0.78.0";

function baseEvidence(scenario) {
  return {
    scenario,
    pi: { binary: process.env.PI_BIN || "pi", available: false, helpExitCode: null, extensionFlag: null },
    extension: { path: extensionPath },
    rpc: { attempted: false, supported: null, events: [], responses: [], stderr: "" },
    runtime: {},
    package: { versionCommand: null, versionExitCode: null, packageRoot: null, commit: null, commitExitCode: null },
  };
}

async function readJsonFile(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function collectPiTuiDependencyEvidence(evidence) {
  const dependency = {
    expectedVersion: pinnedPiTuiVersion,
    packageJsonPath: piExtensionPackageJson,
    lockfilePath: piExtensionLockfile,
    packageJsonExists: false,
    lockfileExists: false,
    packageJsonVersion: null,
    lockfileRootDependency: null,
    lockfileVersion: null,
    installedVersion: null,
    resolvedPath: null,
    resolvedFromExtensionNodeModules: false,
    noHostGlobalFallback: false,
    importOk: false,
    exactPinned: false,
    requiredPrimitives: {},
    errors: [],
  };

  try {
    const packageJson = await readJsonFile(piExtensionPackageJson);
    dependency.packageJsonExists = true;
    dependency.packageJsonVersion = packageJson.dependencies?.["@earendil-works/pi-tui"] ?? null;
  } catch (error) {
    dependency.errors.push(`package.json: ${error?.message ?? String(error)}`);
  }

  try {
    const lockfile = await readJsonFile(piExtensionLockfile);
    dependency.lockfileExists = true;
    dependency.lockfileVersion = lockfile.packages?.["node_modules/@earendil-works/pi-tui"]?.version ?? null;
    dependency.lockfileRootDependency = lockfile.packages?.[""]?.dependencies?.["@earendil-works/pi-tui"] ?? null;
  } catch (error) {
    dependency.errors.push(`package-lock.json: ${error?.message ?? String(error)}`);
  }

  try {
    const installedPackage = await readJsonFile(join(piExtensionNodeModules, "@earendil-works", "pi-tui", "package.json"));
    dependency.installedVersion = installedPackage.version ?? null;
  } catch (error) {
    dependency.errors.push(`node_modules package: ${error?.message ?? String(error)}`);
  }

  try {
    const extensionRequire = createRequire(pathToFileURL(extensionPath).href);
    const resolvedPath = extensionRequire.resolve("@earendil-works/pi-tui");
    dependency.resolvedPath = resolvedPath;
    dependency.resolvedFromExtensionNodeModules = resolvedPath === piExtensionNodeModules
      || resolvedPath.startsWith(`${piExtensionNodeModules}${sep}`);
    dependency.noHostGlobalFallback = dependency.resolvedFromExtensionNodeModules;
    const piTui = await import(pathToFileURL(resolvedPath).href);
    for (const primitive of ["visibleWidth", "truncateToWidth", "wrapTextWithAnsi", "matchesKey", "Markdown"]) {
      dependency.requiredPrimitives[primitive] = typeof piTui[primitive];
    }
    dependency.importOk = Object.values(dependency.requiredPrimitives).every((kind) => kind === "function");
  } catch (error) {
    dependency.errors.push(`direct import: ${error?.message ?? String(error)}`);
  }

  dependency.exactPinned = dependency.packageJsonVersion === pinnedPiTuiVersion
    && dependency.lockfileRootDependency === pinnedPiTuiVersion
    && dependency.lockfileVersion === pinnedPiTuiVersion
    && dependency.installedVersion === pinnedPiTuiVersion;
  dependency.hardGateStatus = dependency.exactPinned && dependency.lockfileExists && dependency.importOk && dependency.noHostGlobalFallback
    ? "PASS"
    : "FAIL";
  evidence.package.piTuiDependency = dependency;
  return dependency;
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
    const version = await runProcess(binary, ["--version"], { timeoutMs: 5_000 });
    evidence.package.versionCommand = `${binary} --version`;
    evidence.package.versionExitCode = version.exitCode;
    evidence.package.versionText = `${version.stdout}${version.stderr}`.trim().slice(0, 500);
  }
  const packageRoot = process.env.PI_PACKAGE_ROOT || "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
  evidence.package.packageRoot = packageRoot;
  const commit = await runProcess("git", ["-C", packageRoot, "rev-parse", "HEAD"], { timeoutMs: 5_000 });
  evidence.package.commitExitCode = commit.exitCode;
  evidence.package.commit = commit.exitCode === 0 ? commit.stdout.trim() : null;
  if (commit.exitCode !== 0) evidence.package.commitError = commit.stderr.trim().slice(0, 500);
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
    LARVA_PI_LAUNCHED: "1",
    LARVA_PI_INITIAL_PERSONA_ID: "",
    ...overrides,
  };
}

async function runPiRpc(evidence, { initialPersona, commands = [], envOverrides = {} } = {}) {
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
  const env = runtimeEnv({ ...(initialPersona ? { LARVA_PI_INITIAL_PERSONA_ID: initialPersona } : {}), ...envOverrides });
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

async function runPiFatalStartup(evidence, args) {
  await piAvailability(evidence);
  evidence.rpc.attempted = true;
  evidence.rpc.fatalStartup = { status: "not-run", firstPromptSent: false };
  if (!evidence.pi.available || !evidence.pi.extensionFlag) {
    evidence.rpc.supported = false;
    evidence.rpc.limitation = "Pi binary or extension flag is unavailable.";
    evidence.rpc.fatalStartup.status = "blocked";
    return evidence.rpc;
  }
  const sessionDir = await mkdtemp(join(tmpdir(), "larva-pi-fatal-startup-session-"));
  const mode = args.get("fatal-mode") || "bad-model";
  const envOverrides = mode === "bad-policy"
    ? { LARVA_PI_TOOL_POLICY_FILE: join(sessionDir, "bad-policy.json") }
    : { FAKE_LARVA_MODEL: "not-a-valid-pi-model" };
  if (mode === "bad-policy") await writeFile(envOverrides.LARVA_PI_TOOL_POLICY_FILE, "{not json", "utf8");
  const env = runtimeEnv({ LARVA_PI_INITIAL_PERSONA_ID: args.get("persona") || "ok", ...envOverrides });
  const child = spawn(evidence.pi.binary, [
    evidence.pi.extensionFlag,
    extensionPath,
    "--mode",
    "rpc",
    "--no-session",
    "--offline",
    "--session-dir",
    sessionDir,
  ], { env, cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => { evidence.rpc.stdout = `${evidence.rpc.stdout || ""}${chunk.toString("utf8")}`; });
  child.stderr.on("data", (chunk) => { evidence.rpc.stderr += chunk.toString("utf8"); });
  const exit = await new Promise((resolveClose) => {
    const timer = setTimeout(() => { child.kill("SIGTERM"); resolveClose({ timeout: true }); }, 5_000);
    child.once("close", (code, signal) => { clearTimeout(timer); resolveClose({ code, signal }); });
    child.once("error", (error) => { clearTimeout(timer); resolveClose({ code: null, error: error.message }); });
  });
  evidence.rpc.exit = exit;
  evidence.rpc.supported = true;
  const nonzeroBeforePrompt = typeof exit?.code === "number" && exit.code !== 0;
  const stderrHasLarvaStartupError = /larva pi: LARVA_(MODEL_UNAVAILABLE|POLICY_INVALID): initial persona/.test(evidence.rpc.stderr);
  evidence.rpc.fatalStartup = {
    status: nonzeroBeforePrompt && stderrHasLarvaStartupError ? "PASS" : "FAIL",
    mode,
    firstPromptSent: false,
    nonzeroBeforePrompt,
    stderrHasLarvaStartupError,
    stderr: evidence.rpc.stderr,
  };
  return evidence.rpc;
}

async function runtimeHarness(evidence, { initialPersona = "ok", envOverrides = {} } = {}) {
  const mod = await import(pathToFileURL(extensionPath).href);
  const registeredTools = [];
  evidence.runtime.registeredCommandNames = [];
  evidence.runtime.registeredShortcuts = [];
  const handlers = new Map();
  const statuses = [];
  const notifications = [];
  const autocompleteProviders = [];
  const ctx = {
    env: runtimeEnv({ LARVA_PI_INITIAL_PERSONA_ID: initialPersona, ...envOverrides }),
    ui: {
      setStatus: async (...args) => { statuses.push(args); },
      notify: async (...args) => { notifications.push(args); },
      addAutocompleteProvider: (providerFactory) => { autocompleteProviders.push(providerFactory); return undefined; },
    },
    modelRegistry: { find: async (provider, modelId) => ({ provider, modelId }) },
  };
  const pi = {
    getAllTools: async () => ["read"],
    setActiveTools: async () => true,
    setModel: async () => true,
    registerCommand: (name) => {
      if (typeof name === "string") evidence.runtime.registeredCommandNames.push(name);
      else if (name && typeof name === "object" && typeof name.name === "string") evidence.runtime.registeredCommandNames.push(name.name);
      else evidence.runtime.registeredCommandNames.push(String(name));
    },
    registerShortcut: (shortcut, options) => {
      evidence.runtime.registeredShortcuts.push({ shortcut, description: options?.description });
    },
    registerTool: (tool) => { registeredTools.push(tool); },
    on: (event, handler) => { handlers.set(event, handler); },
  };
  await mod.initializeExtension(ctx, pi);
  evidence.runtime.statuses = statuses;
  evidence.runtime.notifications = notifications;
  evidence.runtime.registeredToolNames = registeredTools.map((tool) => tool.name);
  evidence.runtime.handlers = Array.from(handlers.keys());
  evidence.runtime.autocompleteProvider = {
    hookType: typeof ctx.ui.addAutocompleteProvider,
    source: "runtimeHarness.mock",
    installedProviderCount: autocompleteProviders.length,
    limitation: "Local smoke runtime injects a mock ctx.ui.addAutocompleteProvider fixture; this is not live Pi interactive TUI runtime proof.",
  };
  evidence.runtime.larvaSubagent = registeredTools.find((tool) => tool.name === "larva_subagent") ?? null;
  evidence.runtime.toolCallHandler = handlers.get("tool_call") ?? null;
  return evidence.runtime;
}

function classifyUiAutocompleteProviderGate(evidence) {
  const mockHook = evidence.runtime?.autocompleteProvider ?? null;
  const realHook = evidence.runtime?.realUiAutocompleteProvider ?? null;
  const piBuildEvidence = {
    binary: evidence.pi?.binary ?? null,
    helpExitCode: evidence.pi?.helpExitCode ?? null,
    versionCommand: evidence.package?.versionCommand ?? null,
    versionExitCode: evidence.package?.versionExitCode ?? null,
    versionText: evidence.package?.versionText ?? null,
    packageRoot: evidence.package?.packageRoot ?? null,
    commit: evidence.package?.commit ?? null,
    commitExitCode: evidence.package?.commitExitCode ?? null,
  };
  const realHookProven = realHook?.source === "pi.interactiveTuiRuntime"
    && realHook?.hookType === "function"
    && (typeof piBuildEvidence.versionText === "string" || typeof piBuildEvidence.commit === "string");
  if (realHookProven) {
    return {
      supported: true,
      status: "supported",
      provenance: "pi.interactiveTuiRuntime",
      evidence: { piBuild: piBuildEvidence, hook: realHook },
      limitation: null,
      supportRule: "supported is true only for a non-mock ctx.ui.addAutocompleteProvider observed from the tested Pi interactive TUI runtime/build.",
    };
  }
  return {
    supported: false,
    status: mockHook?.hookType === "function" ? "unsupported" : "unknown",
    provenance: mockHook?.source ?? "not-observed",
    evidence: { piBuild: piBuildEvidence, hook: mockHook },
    limitation: mockHook?.hookType === "function"
      ? "Only the local runtimeHarness mock object exposed ctx.ui.addAutocompleteProvider; live Pi interactive TUI runtime hook proof is missing."
      : "ctx.ui.addAutocompleteProvider was not observed in this smoke run; live Pi interactive TUI runtime hook proof is missing.",
    supportRule: "mock/local harness hook evidence is never sufficient for supported: true; true requires non-mock Pi interactive TUI runtime/build provenance.",
  };
}

function hasRendererSafeTextContent(result) {
  return Array.isArray(result?.content)
    && result.content.some((item) => item?.type === "text" && typeof item.text === "string");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRenderableTextComponent(value) {
  if (!value || typeof value !== "object") return false;
  if (typeof value.text !== "string") return false;
  if (typeof value.render !== "function") return false;
  return renderedLinesFit(value, 40);
}

function terminalVisibleWidth(value) {
  let width = 0;
  for (const char of Array.from(String(value ?? ""))) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) continue;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) continue;
    width += codePoint >= 0x20 && codePoint <= 0x7e ? 1 : 2;
  }
  return width;
}

function renderedLinesFit(value, width) {
  if (!value || typeof value.render !== "function") return false;
  const rendered = value.render(width);
  return Array.isArray(rendered)
    && rendered.every((line) => typeof line === "string" && terminalVisibleWidth(line) <= width);
}

function assertLarvaSubagentToolResultShape(name, result) {
  const failures = [];
  if (!Array.isArray(result?.content)) {
    failures.push("ToolResult.content must be an array");
  }
  const textItem = Array.isArray(result?.content)
    ? result.content.find((item) => item?.type === "text" && typeof item.text === "string")
    : null;
  if (!textItem) {
    failures.push("ToolResult.content must include a text item { type: 'text', text: string }");
  }
  if (!isRecord(result?.details)) {
    failures.push("ToolResult.details must be a machine-readable metadata object");
  } else {
    for (const field of ["task_id", "persona_id", "status", "result_text", "error"]) {
      if (!(field in result.details)) {
        failures.push(`ToolResult.details missing semantic field ${field}`);
      } else if (JSON.stringify(result.details[field]) !== JSON.stringify(result[field])) {
        failures.push(`ToolResult.details.${field} does not preserve top-level ${field}`);
      }
    }
    if (result.details.error !== null) {
      if (!isRecord(result.details.error)) {
        failures.push("ToolResult.details.error must be null or a structured error object");
      } else {
        if (typeof result.details.error.code !== "string") failures.push("ToolResult.details.error.code must be a string when present");
        if (typeof result.details.error.message !== "string") failures.push("ToolResult.details.error.message must be a string when present");
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(`${name} larva_subagent ToolResult shape regression: ${failures.join("; ")}`);
  }
  return {
    rendererSafeContent: true,
    textItem,
    detailsPreserve: {
      task_id: result.details.task_id,
      persona_id: result.details.persona_id,
      status: result.details.status,
      result_text: result.details.result_text,
      error: result.details.error,
    },
  };
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeFakeSubagentChild(scriptPath, { sessionFile, finalText = "fresh child final text" }) {
  await writeFile(scriptPath, `
    import { createInterface } from "node:readline";
    import { writeFile } from "node:fs/promises";
    const sessionFile = ${JSON.stringify(sessionFile)};
    const finalText = ${JSON.stringify(finalText)};
    const rl = createInterface({ input: process.stdin });
    rl.on("line", async (line) => {
      const message = JSON.parse(line);
      if (message.type === "get_state") process.stdout.write(JSON.stringify({ id: message.id, success: true, data: { sessionFile } }) + "\\n");
      if (message.type === "switch_session") process.stdout.write(JSON.stringify({ id: message.id, success: true, data: {} }) + "\\n");
      if (message.type === "prompt") {
        await writeFile(sessionFile, JSON.stringify({ prompt: message.message }) + "\\n", "utf8");
        process.stdout.write(JSON.stringify({ id: message.id, success: true, data: {} }) + "\\n");
        process.stdout.write(JSON.stringify({ type: "agent_end" }) + "\\n");
      }
      if (message.type === "get_last_assistant_text") {
        process.stdout.write(JSON.stringify({ id: message.id, success: true, data: { text: finalText } }) + "\\n");
        process.exit(0);
      }
    });
  `, "utf8");
}

async function readJsonlTrace(traceFile) {
  try {
    const raw = await readFile(traceFile, "utf8");
    return raw.split(/\r?\n/).filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return { event: "trace_parse_error", line }; }
    });
  } catch {
    return [];
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function uniqueChildPids(events) {
  return Array.from(new Set(events
    .filter((event) => event?.event === "child_spawn" && Number.isInteger(event.pid))
    .map((event) => event.pid)));
}

function scanPids(events) {
  const pids = uniqueChildPids(events);
  return Object.fromEntries(pids.map((pid) => [String(pid), processAlive(pid)]));
}

function summarizeFrames(events) {
  const tx = events.filter((event) => event?.event === "rpc_tx").map((event) => event.frame ?? null);
  const rx = events.filter((event) => event?.event === "rpc_rx").map((event) => event.frame ?? null);
  return {
    eventNames: events.map((event) => event.event),
    txTypes: tx.map((frame) => frame?.type ?? null),
    txPrompts: tx.filter((frame) => frame?.type === "prompt").map((frame) => frame.message),
    switchSessionPaths: tx.filter((frame) => frame?.type === "switch_session").map((frame) => frame.sessionPath),
    rxTypes: rx.map((frame) => frame?.type ?? frame?.command ?? null),
    agentEndCount: rx.filter((frame) => frame?.type === "agent_end").length,
    sessionFiles: rx
      .filter((frame) => frame?.id === "state-1" && typeof frame?.data?.sessionFile === "string")
      .map((frame) => frame.data.sessionFile),
    assistantTexts: rx
      .filter((frame) => frame?.id === "last-1" && typeof frame?.data?.text === "string")
      .map((frame) => frame.data.text),
    childExitCount: events.filter((event) => event?.event === "child_exit").length,
    cleanupEndCount: events.filter((event) => event?.event === "cleanup_end").length,
    abortEvents: events.filter((event) => typeof event?.event === "string" && event.event.startsWith("abort_")).map((event) => event.event),
  };
}

async function executeWithTimeout(tool, callId, input, timeoutMs, onUpdate) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await tool.execute(callId, input, controller.signal, onUpdate);
  } finally {
    clearTimeout(timer);
  }
}

function stripAnsiForSmoke(line) {
  return String(line ?? "").replace(/\x1b\[[0-9;]*m/g, "");
}

function renderedPlainText(lines) {
  return Array.isArray(lines) ? lines.map(stripAnsiForSmoke).join("\n") : "";
}

async function controlledLiveChildRpcProof(evidence, args) {
  await piAvailability(evidence);
  evidence.runtime.controlledLive = {
    status: "not-run",
    basis: "Starts child through registered larva_subagent execute path; child process command is the real Pi binary plus bundled extension entrypoint in RPC mode.",
  };
  if (!evidence.pi.available || !evidence.pi.extensionFlag) {
    evidence.runtime.controlledLive.status = "blocked";
    evidence.runtime.controlledLive.blocker = "Pi binary or extension flag unavailable.";
    return;
  }

  const sessionRoot = await mkdtemp(join(tmpdir(), "larva-pi-live-child-sessions-"));
  const traceFile = join(sessionRoot, "child-rpc-trace.jsonl");
  const timeoutMs = Number.parseInt(args.get("live-timeout-ms") || "90000", 10);
  await runtimeHarness(evidence, {
    initialPersona: "ok",
    envOverrides: {
      LARVA_PI_CHILD_SESSION_DIR: sessionRoot,
      LARVA_PI_CHILD_RPC_TRACE_FILE: traceFile,
      LARVA_PI_REAL_BIN: evidence.pi.binary,
      LARVA_PI_EXTENSION_FLAG: evidence.pi.extensionFlag,
      LARVA_PI_EXTENSION_ENTRY: extensionPath,
    },
  });
  const tool = evidence.runtime.larvaSubagent;
  const calls = [];
  const runCall = async (name, input, options = {}) => {
    const beforeEvents = await readJsonlTrace(traceFile);
    const beforePidAlive = scanPids(beforeEvents);
    const updates = [];
    const result = await executeWithTimeout(tool, `live-${name}`, input, timeoutMs, (update) => {
      updates.push(update);
      if (options.abortOnWaitingForChild && update?.details?.phase === "waiting_for_child") {
        setTimeout(() => options.controller?.abort(), 100);
      }
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    const afterEvents = await readJsonlTrace(traceFile);
    const newEvents = afterEvents.slice(beforeEvents.length);
    const afterPidAlive = scanPids(afterEvents);
    const newPids = uniqueChildPids(newEvents);
    const newPidAlive = Object.fromEntries(newPids.map((pid) => [String(pid), processAlive(pid)]));
    const receipt = {
      name,
      input,
      result,
      updates,
      trace: summarizeFrames(newEvents),
      beforePidAlive,
      afterPidAlive,
      newPidAlive,
      orphanFree: Object.values(newPidAlive).every((alive) => alive === false),
    };
    calls.push(receipt);
    return receipt;
  };

  const first = await runCall("fresh", {
    persona_id: "child",
    task: args.get("live-task") || "Reply exactly with B1_CHILD_RPC_OK and no extra words.",
  });
  let resume = null;
  if (first.result?.status === "success" && typeof first.result?.task_id === "string") {
    resume = await runCall("resume", {
      persona_id: "child",
      task: args.get("live-resume-task") || "Reply exactly with B2_RESUME_RPC_OK and no extra words.",
      task_id: first.result.task_id,
    });
  }

  const abortController = new AbortController();
  const beforeAbortEvents = await readJsonlTrace(traceFile);
  const abortUpdates = [];
  const abortPromise = tool.execute("live-abort", {
    persona_id: "child",
    task: args.get("live-abort-task") || "Think silently for a while, then reply B3_ABORT_SHOULD_NOT_FINISH.",
  }, abortController.signal, (update) => {
    abortUpdates.push(update);
    if (update?.details?.phase === "waiting_for_child") setTimeout(() => abortController.abort(), 100);
  });
  setTimeout(() => abortController.abort(), 5_000);
  const abortResult = await abortPromise;
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  const afterAbortEvents = await readJsonlTrace(traceFile);
  const abortNewEvents = afterAbortEvents.slice(beforeAbortEvents.length);
  const abortPids = uniqueChildPids(abortNewEvents);
  const abortNewPidAlive = Object.fromEntries(abortPids.map((pid) => [String(pid), processAlive(pid)]));
  const abort = {
    name: "abort",
    result: abortResult,
    updates: abortUpdates,
    trace: summarizeFrames(abortNewEvents),
    newPidAlive: abortNewPidAlive,
    orphanFree: Object.values(abortNewPidAlive).every((alive) => alive === false),
  };
  calls.push(abort);

  const allEvents = await readJsonlTrace(traceFile);
  const b1 = {
    status: first.result?.status === "success" ? "PASS" : "FAIL",
    task_id: first.result?.task_id ?? null,
    startupSessionFileObserved: first.trace.sessionFiles.includes(first.result?.task_id),
    promptObserved: first.trace.txPrompts.includes(first.input.task),
    agentEndObserved: first.trace.agentEndCount >= 1,
    getLastAssistantTextObserved: first.trace.txTypes.includes("get_last_assistant_text") && first.trace.assistantTexts.length >= 1,
  };
  const b2 = resume === null ? { status: "BLOCKED", blocker: "Fresh run did not produce reusable task_id." } : {
    status: resume.result?.status === "success" && resume.result?.task_id === first.result?.task_id ? "PASS" : "FAIL",
    reusedTaskId: resume.result?.task_id ?? null,
    switchSessionObserved: resume.trace.switchSessionPaths.includes(first.result.task_id),
    promptObserved: resume.trace.txPrompts.includes(resume.input.task),
    resumedOutputObserved: typeof resume.result?.result_text === "string" && resume.result.result_text.length >= 0,
  };
  const abortTrace = abort.trace;
  const b3 = {
    status: abort.result?.status === "cancelled" && abortTrace.abortEvents.length > 0 && abort.orphanFree ? "PASS" : "FAIL",
    resultStatus: abort.result?.status ?? null,
    abortEvents: abortTrace.abortEvents,
    cleanupObserved: abortTrace.cleanupEndCount >= 1,
    orphanFree: abort.orphanFree,
    hardBlock: abortTrace.abortEvents.length === 0 ? "Pi abort propagation was not observed in child trace; inspect trace/runtime for missing abort signal surface." : null,
  };
  const b4 = {
    status: calls.every((call) => call.orphanFree) ? "PASS" : "FAIL",
    beforeAfterScans: calls.map((call) => ({ name: call.name, beforePidAlive: call.beforePidAlive ?? {}, afterPidAlive: call.afterPidAlive ?? call.newPidAlive, newPidAlive: call.newPidAlive, orphanFree: call.orphanFree })),
    lifecycleEvents: summarizeFrames(allEvents).eventNames.filter((name) => ["child_spawn", "child_exit", "cleanup_start", "cleanup_sigterm", "cleanup_sigkill", "cleanup_end"].includes(name)),
  };
  evidence.runtime.controlledLive = {
    status: [b1.status, b2.status, b3.status, b4.status].every((status) => status === "PASS") ? "PASS" : "FAIL",
    sessionRoot,
    traceFile,
    calls,
    traceSummary: summarizeFrames(allEvents),
    B1_startup: b1,
    B2_resume: b2,
    B3_abort: b3,
    B4_orphans: b4,
  };
}

async function subagentLogSelectorStreamingExpectedRed(evidence) {
  const mod = await import(pathToFileURL(extensionPath).href);
  const extensionRequire = createRequire(pathToFileURL(extensionPath).href);
  const piTui = await import(pathToFileURL(extensionRequire.resolve("@earendil-works/pi-tui")).href);
  const sessionRoot = await mkdtemp(join(tmpdir(), "larva-subagent-log-selector-streaming-"));
  const cacheFile = join(sessionRoot, "subagent-presentation-log.json");
  const env = runtimeEnv({ HOME: sessionRoot, LARVA_PI_SUBAGENT_LOG_FILE: cacheFile });
  await mod.initializeExtension(
    { env, modelRegistry: { find: async () => ({ id: "model" }) }, ui: { setStatus: async () => undefined } },
    { registerTool: () => undefined, registerCommand: () => undefined, on: () => undefined },
  );
  mod.resetSubagentPresentationStateForTests();

  const overlongTask = `${"selector row prompt ".repeat(40)}这是🧪`;
  const overlongToolOutput = `${"tool output chunk ".repeat(80)}SECRET_TOOL_TAIL`;
  mod.recordSubagentPresentationEntryForTests("/tmp/running-old.jsonl", "runner", "running", {
    phase: "waiting_for_child",
    task_preview: overlongTask,
    task_prompt: `running prompt ${overlongTask}`,
    updated_at: "2026-06-03T00:00:00.000Z",
  });
  mod.recordSubagentPresentationEntryForTests("/tmp/final-newest.jsonl", "finisher", "success", {
    phase: "success",
    task_preview: "final task",
    task_prompt: "final prompt",
    result_text: "FINAL_AUTHORITY_FROM_GET_LAST_ASSISTANT_TEXT",
    updated_at: "2026-06-04T00:00:00.000Z",
  });
  const defaultDetail = mod.larva_subagent_log("");
  const trimmedExact = mod.larva_subagent_log("  /tmp/final-newest.jsonl  ");
  const selectFlag = mod.larva_subagent_log("--select");
  const noLastAlias = mod.larva_subagent_log("last");
  const noFuzzyAlias = mod.larva_subagent_log("/tmp/final");
  const list = mod.larva_subagent_log({ list: true, limit: 5 });
  const listText = list.content?.[0]?.text ?? "";

  mod.recordSubagentPresentationEntryForTests("/tmp/live-running.jsonl", "streamer", "running", {
    phase: "waiting_for_child",
    task_preview: overlongTask,
    task_prompt: "streaming task prompt",
    result_text: "thinking_delta_secret SHOULD_NOT_RENDER",
    updated_at: "2026-06-04T01:00:00.000Z",
    live_assistant_preview: "LIVE_ASSISTANT_PREVIEW_VISIBLE_WHILE_RUNNING",
    tool_snapshots: [{ toolCallId: "tool-1", name: "bash", status: "running", args_preview: "echo hi", output_preview: overlongToolOutput }],
    active_tool_state: { toolCallId: "tool-1" },
    raw_rpc_events: [{ type: "tool_execution_update", payload: "rawRpcSecret" }],
  });
  const cached = JSON.parse(await readFile(cacheFile, "utf8"));
  const liveCachedEntry = cached.entries.find((entry) => entry.task_id === "/tmp/live-running.jsonl") ?? {};

  const terminalWrites = [];
  const component = new mod.SubagentPresentationLogOverlay({
    entry: mod.larva_subagent_log("/tmp/live-running.jsonl").details.entries[0],
    generation: 999,
    tui: { terminal: { rows: 100, write: (data) => terminalWrites.push(data) }, requestRender: () => undefined },
  });
  const detailFrame = component.render(100);
  const detailPlain = renderedPlainText(detailFrame);
  component.handleInput?.("s");
  const selectorFrame = component.render(100);
  const selectorPlain = renderedPlainText(selectorFrame);
  component.handleInput?.("3");
  const outputFrame = component.render(100);
  const outputPlain = renderedPlainText(outputFrame);
  component.handleInput?.("4");
  const fourthTabFrame = component.render(100);
  const fourthTabPlain = renderedPlainText(fourthTabFrame);
  component.handleInput?.("5");
  const fifthTabFrame = component.render(100);
  const fifthTabPlain = renderedPlainText(fifthTabFrame);
  component.handleInput?.("\x1b[<0;10;10M");
  const afterClickFrame = component.render(100);
  component.dispose?.();

  const shortTerminalComponent = new mod.SubagentPresentationLogOverlay({ entry: list.details.entries[0], generation: 1, tui: { terminal: { rows: 24 } } });
  const tallTerminalComponent = new mod.SubagentPresentationLogOverlay({ entry: list.details.entries[0], generation: 1, tui: { terminal: { rows: 100 } } });
  const shortLines = shortTerminalComponent.render(100);
  const tallLines = tallTerminalComponent.render(100);
  shortTerminalComponent.dispose?.();
  tallTerminalComponent.dispose?.();

  const source = await readFile(extensionPath, "utf8");
  const allFrames = [detailFrame, selectorFrame, outputFrame, fourthTabFrame, fifthTabFrame, afterClickFrame, shortLines, tallLines];
  const assertions = {
    R1_selector_entrypoints: {
      defaultOpensNewestDetail: defaultDetail.details?.selected_task_id === "/tmp/final-newest.jsonl" && defaultDetail.ok === true,
      sEntersSelector: /selector|select subagent/i.test(selectorPlain) && !/● 1 Summary/.test(selectorPlain),
      selectFlagOpensSelector: selectFlag.ok === true && /selector|select subagent/i.test(selectFlag.content?.[0]?.text ?? ""),
    },
    R2_selector_ordering_rows: {
      runningFirstThenNewestThenSequence: list.details?.entries?.[0]?.status === "running",
      rowsContainRequiredBoundedFields: /runner/.test(listText) && /waiting_for_child/.test(listText) && /task_id: .*running-old\.jsonl/.test(listText) && /…|\.\.\./.test(listText),
      rowsExcludeFullPromptOutputRawPayloads: !listText.includes("running prompt") && !listText.includes("FINAL_AUTHORITY") && !listText.includes("rawRpcSecret"),
      allRenderedLinesFit: allFrames.every((lines) => lines.every((line) => piTui.visibleWidth(line) <= 100)),
    },
    R3_processLocalLiveState_cacheSanitizer: {
      liveAssistantPreviewNotPersisted: !("live_assistant_preview" in liveCachedEntry),
      toolSnapshotsNotPersisted: !("tool_snapshots" in liveCachedEntry),
      activeToolStateNotPersisted: !("active_tool_state" in liveCachedEntry),
      rawRpcEventsNotPersisted: !("raw_rpc_events" in liveCachedEntry) && JSON.stringify(cached).includes("rawRpcSecret") === false,
    },
    R4_groupedToolEvents: {
      eventsTabExists: /Events/.test(detailPlain) && /● 4 Events/.test(fourthTabPlain),
      groupedByToolCallId: (fourthTabPlain.match(/tool-1/g) ?? []).length === 1,
      toolOutputOnlyBoundedEventsPreview: fourthTabPlain.includes("SECRET_TOOL_TAIL") === false && /truncated|…|\.\.\./i.test(fourthTabPlain) && outputPlain.includes("SECRET_TOOL_TAIL") === false,
    },
    R5_outputLiveAndFinalAuthority: {
      liveAssistantShownWhileRunning: outputPlain.includes("LIVE_ASSISTANT_PREVIEW_VISIBLE_WHILE_RUNNING"),
      finalAuthorityStillGetLastAssistantText: mod.larva_subagent_log("/tmp/final-newest.jsonl").content[0].text.includes("FINAL_AUTHORITY_FROM_GET_LAST_ASSISTANT_TEXT"),
      outputPaneNotToolPane: outputPlain.includes("tool-1") === false && outputPlain.includes("SECRET_TOOL_TAIL") === false,
    },
    R6_boundsAndThinkingHidden: {
      thinkingContentHidden: !outputPlain.includes("thinking_delta_secret") && /thinking hidden|No final subagent output/i.test(outputPlain),
      overlongContentTruncated: /truncated|…|\.\.\./i.test(selectorPlain) && !selectorPlain.includes(overlongTask) && !fourthTabPlain.includes(overlongToolOutput),
    },
    R7_chromeTabsAndInput: {
      tabOrderSummaryPromptOutputEventsMetadata: /1 Summary.*2 Prompt.*3 Output.*4 Events.*5 Metadata/s.test(detailPlain),
      stableFrameAcrossSelectorTabsScroll: [selectorFrame, outputFrame, fourthTabFrame, fifthTabFrame].every((lines) => lines.length === detailFrame.length && lines[0] === detailFrame[0] && lines.at(-1) === detailFrame.at(-1)),
      keyboardMouseClickNoop: JSON.stringify(fourthTabFrame) === JSON.stringify(afterClickFrame),
    },
    R8_negativeBoundaries: {
      noRawJsonlOrSidecarShortcutInSourcePath: !/larva_subagent_log[\s\S]{0,2000}(readFile|lstat|realpath|sidecar|\.jsonl\.meta)/.test(source),
      noModelVisibleStreamOrSharedSchemaLeak: !JSON.stringify(defaultDetail).includes("result_text\"") && !JSON.stringify(cached).includes("rawRpcSecret"),
    },
    R9_taskIdArgumentSemantics: {
      trimmedExactTaskIdSelects: trimmedExact.ok === true && trimmedExact.details?.selected_task_id === "/tmp/final-newest.jsonl",
      selectNotTreatedAsTaskId: selectFlag.details?.error?.code !== "LARVA_SUBAGENT_LOG_NOT_OBSERVED",
      noLastAlias: noLastAlias.details?.error?.code === "LARVA_SUBAGENT_LOG_NOT_OBSERVED",
      noFuzzyAlias: noFuzzyAlias.details?.error?.code === "LARVA_SUBAGENT_LOG_NOT_OBSERVED",
    },
    R10_mouseReportingLifecycle: {
      enabledOnlyWhileOpen: terminalWrites[0] === "\x1b[?1000h\x1b[?1006h",
      disabledOnDispose: terminalWrites.at(-1) === "\x1b[?1006l\x1b[?1000l",
    },
    R11_tallTerminal90PercentStableFrame: {
      tallUsesNinetyPercentMaxHeight: tallLines.length >= 85 && tallLines.length <= 91,
      tallGreaterThanShort: tallLines.length > shortLines.length,
      stableFrameAcrossSelectorTabsScroll: [selectorFrame, outputFrame, fourthTabFrame, fifthTabFrame].every((lines) => lines.length === detailFrame.length && lines[0] === detailFrame[0] && lines.at(-1) === detailFrame.at(-1)),
    },
  };
  const flattened = Object.values(assertions).flatMap((group) => Object.values(group));
  evidence.runtime.subagentLogSelectorStreaming = {
    status: flattened.every(Boolean) ? "PASS" : "EXPECTED_RED",
    cacheFile,
    selectedTaskIds: {
      defaultDetail: defaultDetail.details?.selected_task_id ?? null,
      trimmedExact: trimmedExact.details?.selected_task_id ?? null,
      selectFlagError: selectFlag.details?.error?.code ?? null,
      lastError: noLastAlias.details?.error?.code ?? null,
      fuzzyError: noFuzzyAlias.details?.error?.code ?? null,
    },
    terminalRows: { short: 24, tall: 100, shortRenderedLines: shortLines.length, tallRenderedLines: tallLines.length },
    tabPlainSamples: { detail: detailPlain.slice(0, 500), selector: selectorPlain.slice(0, 500), output: outputPlain.slice(0, 500), fourth: fourthTabPlain.slice(0, 500), fifth: fifthTabPlain.slice(0, 500) },
    cacheKeysForLiveEntry: Object.keys(liveCachedEntry),
    assertions,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.has("help")) {
    process.stdout.write(usage());
    return;
  }
  const scenario = args.get("scenario") || args.get("case");
  if (!SCENARIOS.includes(scenario)) throw new Error(`unknown or missing scenario: ${scenario ?? ""}`);
  const persona = args.get("persona") || undefined;
  const evidence = baseEvidence(scenario);
  await collectPiTuiDependencyEvidence(evidence);
  if (scenario === "availability") {
    await piAvailability(evidence);
  } else if (scenario === "get-commands") {
    await runPiRpc(evidence, { commands: [{ id: "commands-1", body: { type: "get_commands" } }] });
  } else if (scenario === "slash-status") {
    await runPiRpc(evidence, { commands: [{ id: "prompt-1", body: { type: "prompt", message: `/larva-persona ${persona ?? "ok"}` }, timeoutMs: 2_000 }] });
  } else if (scenario === "startup-status") {
    await runPiRpc(evidence, { initialPersona: persona ?? "startup", commands: [{ id: "state-1", body: { type: "get_state" } }] });
  } else if (scenario === "startup-fatal") {
    await runPiFatalStartup(evidence, args);
  } else if (scenario === "failure-path") {
    const missingPersona = persona ?? "missing";
    await runPiRpc(evidence, {
      commands: [
        { id: "prompt-missing", body: { type: "prompt", message: `/larva-persona ${missingPersona}` }, timeoutMs: 2_000 },
        { id: "prompt-unparseable", body: { type: "prompt", message: "/larva-persona unparseable" }, timeoutMs: 2_000 },
      ],
    });
  } else if (scenario === "tool-shape") {
    await runtimeHarness(evidence);
    const tool = evidence.runtime.larvaSubagent;
    const wideTask = "这是一个用于测试 subagent 功能的长时间任务。".repeat(8);
    const callComponent = tool?.renderCall?.({ persona_id: "child", task: wideTask });
    const resultComponent = tool?.renderResult?.({
      content: [{ type: "text", text: "child completed" }],
      details: { task_id: null, persona_id: "child", status: "success", result_text: wideTask, error: null },
    }, { expanded: true, input: { persona_id: "child", task: wideTask } });
    evidence.runtime.assertions = {
      hasLarvaSubagent: Boolean(tool),
      hasParameters: Boolean(tool?.parameters && tool.parameters.type === "object"),
      hasExecute: typeof tool?.execute === "function",
      hasRenderableCall: isRenderableTextComponent(callComponent),
      hasRenderableResult: isRenderableTextComponent(resultComponent),
      wideCallLinesFit: renderedLinesFit(callComponent, 40),
      wideResultLinesFit: renderedLinesFit(resultComponent, 40),
    };
  } else if (scenario === "tool-result-renderer-shape") {
    const noActiveRoot = await mkdtemp(join(tmpdir(), "larva-pi-no-active-"));
    await runtimeHarness(evidence, {
      initialPersona: null,
      envOverrides: { LARVA_PI_CHILD_SESSION_DIR: noActiveRoot },
    });
    const noActiveTool = evidence.runtime.larvaSubagent;
    const failedBeforeSession = await noActiveTool.handler({ persona_id: "child", task: "do work" });

    const cancelledRoot = await mkdtemp(join(tmpdir(), "larva-pi-cancelled-"));
    await runtimeHarness(evidence, {
      initialPersona: "ok",
      envOverrides: { LARVA_PI_CHILD_SESSION_DIR: cancelledRoot },
    });
    const cancelledTool = evidence.runtime.larvaSubagent;
    const controller = new AbortController();
    controller.abort();
    const cancelled = await cancelledTool.execute("call-cancelled", { persona_id: "child", task: "stop" }, controller.signal);

    const failedAfterRoot = await mkdtemp(join(tmpdir(), "larva-pi-failed-after-"));
    const failedAfterTaskId = join(failedAfterRoot, "allocated.jsonl");
    await writeFile(failedAfterTaskId, "", "utf8");
    await runtimeHarness(evidence, {
      initialPersona: "ok",
      envOverrides: { LARVA_PI_CHILD_SESSION_DIR: failedAfterRoot, LARVA_PI_REAL_BIN: "" },
    });
    const failedAfterTool = evidence.runtime.larvaSubagent;
    const failedAfterAllocation = await failedAfterTool.execute("call-failed-after", {
      persona_id: "child",
      task: "resume and fail after allocation",
      task_id: failedAfterTaskId,
    });

    const successRoot = await mkdtemp(join(tmpdir(), "larva-pi-success-"));
    const successTaskId = join(successRoot, "success.jsonl");
    await writeFile(successTaskId, "", "utf8");
    const fakeChild = join(successRoot, "fake-child.mjs");
    await writeFile(fakeChild, `
      import { createInterface } from "node:readline";
      const sessionFile = ${JSON.stringify(successTaskId)};
      const rl = createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const message = JSON.parse(line);
        if (message.type === "get_state") process.stdout.write(JSON.stringify({ id: message.id, success: true, data: { sessionFile } }) + "\\n");
        if (message.type === "prompt") {
          process.stdout.write(JSON.stringify({ id: message.id, success: true, data: {} }) + "\\n");
          process.stdout.write(JSON.stringify({ type: "agent_end" }) + "\\n");
        }
        if (message.type === "get_last_assistant_text") {
          process.stdout.write(JSON.stringify({ id: message.id, success: true, data: { text: "child final text" } }) + "\\n");
          process.exit(0);
        }
      });
    `, "utf8");
    await runtimeHarness(evidence, {
      initialPersona: "ok",
      envOverrides: { LARVA_PI_CHILD_SESSION_DIR: successRoot, LARVA_PI_REAL_BIN: process.execPath, LARVA_PI_EXTENSION_FLAG: fakeChild },
    });
    const successTool = evidence.runtime.larvaSubagent;
    const success = await successTool.execute("call-success", { persona_id: "child", task: "finish" });

    evidence.runtime.toolResultCases = {
      success,
      failedBeforeSession,
      cancelled,
      failedAfterAllocation,
    };
    evidence.runtime.assertions = Object.fromEntries(
      Object.entries(evidence.runtime.toolResultCases).map(([name, result]) => [
        name,
        {
          hasRendererSafeTextContent: hasRendererSafeTextContent(result),
          ...assertLarvaSubagentToolResultShape(name, result),
        },
      ]),
    );
  } else if (scenario === "fresh-session-validation") {
    const successRoot = await mkdtemp(join(tmpdir(), "larva-pi-fresh-session-"));
    const missingFreshSession = join(successRoot, "fresh-created-on-prompt.jsonl");
    const successChild = join(successRoot, "fresh-child.mjs");
    await writeFakeSubagentChild(successChild, { sessionFile: missingFreshSession });
    const missingBeforePrompt = !(await exists(missingFreshSession));
    await runtimeHarness(evidence, {
      initialPersona: "ok",
      envOverrides: { LARVA_PI_CHILD_SESSION_DIR: successRoot, LARVA_PI_REAL_BIN: process.execPath, LARVA_PI_EXTENSION_FLAG: successChild },
    });
    const successTool = evidence.runtime.larvaSubagent;
    const freshMissingBeforePrompt = await successTool.execute("fresh-missing-before-prompt", { persona_id: "child", task: "finish fresh child" });
    const createdDuringPrompt = await exists(missingFreshSession);

    const resumeRoot = await mkdtemp(join(tmpdir(), "larva-pi-resume-missing-"));
    const resumeMarker = join(resumeRoot, "spawned-marker.jsonl");
    const resumeChild = join(resumeRoot, "resume-child.mjs");
    await writeFakeSubagentChild(resumeChild, { sessionFile: resumeMarker });
    await runtimeHarness(evidence, {
      initialPersona: "ok",
      envOverrides: { LARVA_PI_CHILD_SESSION_DIR: resumeRoot, LARVA_PI_REAL_BIN: process.execPath, LARVA_PI_EXTENSION_FLAG: resumeChild },
    });
    const resumeTool = evidence.runtime.larvaSubagent;
    const missingResumeTaskId = join(resumeRoot, "missing-resume.jsonl");
    const missingResume = await resumeTool.execute("resume-missing", { persona_id: "child", task: "resume missing", task_id: missingResumeTaskId });
    const resumeSpawned = await exists(resumeMarker);

    async function runInvalidFresh(name, sessionFile, rootOverride = null) {
      const invalidRoot = rootOverride ?? await mkdtemp(join(tmpdir(), `larva-pi-invalid-${name}-`));
      const invalidChild = join(invalidRoot, "invalid-child.mjs");
      await writeFakeSubagentChild(invalidChild, { sessionFile, finalText: `unexpected ${name}` });
      await runtimeHarness(evidence, {
        initialPersona: "ok",
        envOverrides: { LARVA_PI_CHILD_SESSION_DIR: invalidRoot, LARVA_PI_REAL_BIN: process.execPath, LARVA_PI_EXTENSION_FLAG: invalidChild },
      });
      const tool = evidence.runtime.larvaSubagent;
      return await tool.execute(`invalid-${name}`, { persona_id: "child", task: `reject ${name}` });
    }

    const wrongSuffixRoot = await mkdtemp(join(tmpdir(), "larva-pi-wrong-suffix-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "larva-pi-outside-session-"));
    const symlinkRoot = await mkdtemp(join(tmpdir(), "larva-pi-symlink-session-"));
    const outsideTarget = join(outsideRoot, "outside-target.jsonl");
    await writeFile(outsideTarget, "outside\n", "utf8");
    const symlinkPath = join(symlinkRoot, "escape.jsonl");
    await symlink(outsideTarget, symlinkPath);
    const danglingSymlinkRoot = await mkdtemp(join(tmpdir(), "larva-pi-dangling-symlink-session-"));
    const danglingSymlinkPath = join(danglingSymlinkRoot, "dangling-escape.jsonl");
    await symlink(join(outsideRoot, "missing-target.jsonl"), danglingSymlinkPath);

    const invalidFresh = {
      relative: await runInvalidFresh("relative", "relative.jsonl"),
      wrongSuffix: await runInvalidFresh("wrong-suffix", join(wrongSuffixRoot, "wrong.txt"), wrongSuffixRoot),
      outsideRoot: await runInvalidFresh("outside-root", join(outsideRoot, "outside.jsonl")),
      symlinkEscape: await runInvalidFresh("symlink-escape", symlinkPath, symlinkRoot),
      danglingSymlinkEscape: await runInvalidFresh("dangling-symlink-escape", danglingSymlinkPath, danglingSymlinkRoot),
    };

    evidence.runtime.freshSessionValidation = {
      freshMissingBeforePrompt,
      missingBeforePrompt,
      createdDuringPrompt,
      missingResume,
      missingResumeTaskId,
      resumeSpawned,
      invalidFresh,
    };
    evidence.runtime.assertions = {
      freshMissingBeforePromptAccepted: missingBeforePrompt === true
        && createdDuringPrompt === true
        && freshMissingBeforePrompt.status === "success"
        && freshMissingBeforePrompt.result_text === "fresh child final text"
        && freshMissingBeforePrompt.task_id.endsWith("fresh-created-on-prompt.jsonl"),
      strictResumeMissingRejected: missingResume.status === "failed"
        && missingResume.error?.code === "LARVA_SESSION_NOT_FOUND"
        && resumeSpawned === false,
      invalidFreshRejected: Object.values(invalidFresh).every((result) => result.status === "failed" && result.error?.code === "LARVA_CHILD_PROTOCOL_FAILED"),
      authorityAndToolResultPreserved: freshMissingBeforePrompt.isError === false
        && Array.isArray(freshMissingBeforePrompt.content)
        && freshMissingBeforePrompt.details?.status === "success",
    };
  } else if (scenario === "tool-call-block") {
    await runtimeHarness(evidence);
    const result = await evidence.runtime.toolCallHandler?.({ toolName: "bash" });
    evidence.runtime.toolCallResult = result;
    evidence.runtime.assertions = {
      blockTrue: result?.block === true,
      nonEmptyReason: typeof result?.reason === "string" && result.reason.length > 0,
    };
  } else if (scenario === "capability-gates") {
    await piAvailability(evidence);
    await runtimeHarness(evidence);
    const tool = evidence.runtime.larvaSubagent;
    evidence.runtime.hardGates = {
      extensionLoading: {
        supported: Boolean(evidence.pi.extensionFlag),
        evidence: { binary: evidence.pi.binary, helpExitCode: evidence.pi.helpExitCode, extensionFlag: evidence.pi.extensionFlag },
      },
      rpcJsonl: {
        supported: evidence.pi.available === true,
        evidence: { mode: "rpc", commands: ["get_state", "prompt", "switch_session", "get_last_assistant_text", "abort"] },
      },
      uiAutocompleteProvider: classifyUiAutocompleteProviderGate(evidence),
      piTuiDependency: {
        supported: evidence.package.piTuiDependency?.hardGateStatus === "PASS",
        evidence: evidence.package.piTuiDependency,
      },
      subagentToolRowProgress: {
        supported: typeof tool?.renderCall === "function" && typeof tool?.renderResult === "function" && typeof tool?.execute === "function",
        evidence: { hasRenderCall: typeof tool?.renderCall, hasRenderResult: typeof tool?.renderResult, hasExecute: typeof tool?.execute },
      },
      subagentLogOverlayCommand: {
        supported: evidence.runtime.registeredCommandNames.includes("larva-subagent-log"),
        evidence: { requiredCommand: "larva-subagent-log", registeredCommandNames: evidence.runtime.registeredCommandNames },
      },
      personaSelectorShortcut: {
        supported: evidence.runtime.registeredShortcuts.some((entry) => entry.shortcut === "ctrl+alt+p" && entry.description === "Open Larva persona selector"),
        evidence: { requiredShortcut: "ctrl+alt+p", registeredShortcuts: evidence.runtime.registeredShortcuts },
      },
    };
  } else if (scenario === "live-child-rpc-proof") {
    await controlledLiveChildRpcProof(evidence, args);
  } else if (scenario === "subagent-log-selector-streaming") {
    await subagentLogSelectorStreamingExpectedRed(evidence);
  }
  const serializable = JSON.parse(JSON.stringify(evidence, (key, value) => (typeof value === "function" ? "[function]" : value)));
  console.log(JSON.stringify(serializable, null, 2));
  if (scenario === "capability-gates" && evidence.package.piTuiDependency?.hardGateStatus !== "PASS") {
    process.exitCode = 1;
  }
  if (scenario === "subagent-log-selector-streaming" && evidence.runtime.subagentLogSelectorStreaming?.status !== "PASS") {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
