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
  "async-subagent-contract",
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
    const semanticFields = result.details.status === "accepted"
      ? ["task_id", "persona_id", "status", "result_pending", "error"]
      : ["task_id", "persona_id", "status", "result_text", "error"];
    for (const field of semanticFields) {
      if (!(field in result.details)) {
        failures.push(`ToolResult.details missing semantic field ${field}`);
      } else if (JSON.stringify(result.details[field]) !== JSON.stringify(result[field])) {
        failures.push(`ToolResult.details.${field} does not preserve top-level ${field}`);
      }
    }
    if (result.details.status === "accepted" && "result_text" in result.details) {
      failures.push("accepted ToolResult.details must not carry terminal result_text evidence");
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
    detailsPreserve: result.details.status === "accepted"
      ? {
        task_id: result.details.task_id,
        persona_id: result.details.persona_id,
        status: result.details.status,
        result_pending: result.details.result_pending,
        error: result.details.error,
        no_terminal_result_text: !("result_text" in result.details),
      }
      : {
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

async function writeDelayedAsyncSubagentChild(scriptPath, { sessionFile, finalText = "ASYNC_CALLBACK_FINAL", terminalDelayMs = 650, terminalMarkerFile }) {
  await writeFile(scriptPath, `
    import { createInterface } from "node:readline";
    import { mkdir, writeFile } from "node:fs/promises";
    import { dirname } from "node:path";
    const sessionFile = ${JSON.stringify(sessionFile)};
    const finalText = ${JSON.stringify(finalText)};
    const terminalDelayMs = ${JSON.stringify(terminalDelayMs)};
    const terminalMarkerFile = ${JSON.stringify(terminalMarkerFile)};
    await mkdir(dirname(sessionFile), { recursive: true });
    if (terminalMarkerFile) await mkdir(dirname(terminalMarkerFile), { recursive: true });
    const rl = createInterface({ input: process.stdin });
    const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
    rl.on("line", async (line) => {
      const message = JSON.parse(line);
      if (message.type === "get_state") {
        await writeFile(sessionFile, "{}\\n", "utf8");
        send({ id: message.id, success: true, data: { sessionFile } });
      } else if (message.type === "switch_session") {
        send({ id: message.id, success: true, data: { cancelled: false } });
      } else if (message.type === "prompt") {
        send({ id: message.id, success: true, data: {} });
        setTimeout(async () => {
          if (terminalMarkerFile) await writeFile(terminalMarkerFile, "agent_end\\n", "utf8");
          send({ type: "agent_end" });
        }, terminalDelayMs);
      } else if (message.type === "get_last_assistant_text") {
        send({ id: message.id, success: true, data: { text: finalText } });
        setTimeout(() => process.exit(0), 5);
      } else if (message.type === "abort") {
        send({ id: message.id, success: true });
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

async function waitForSmokeCondition(predicate, { label = "condition", timeoutMs = 2_000, intervalMs = 10 } = {}) {
  const startedAt = Date.now();
  let lastValue = null;
  while (Date.now() - startedAt < timeoutMs) {
    lastValue = await predicate();
    if (lastValue) return lastValue;
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function writeStreamingSubagentChild(scriptPath, sessionFile) {
  await writeFile(scriptPath, `
    import { createInterface } from "node:readline";
    import { mkdir, writeFile } from "node:fs/promises";
    import { dirname } from "node:path";
    const sessionFile = ${JSON.stringify(sessionFile)};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    await mkdir(dirname(sessionFile), { recursive: true });
    const rl = createInterface({ input: process.stdin });
    const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
    rl.on("line", async (line) => {
      const message = JSON.parse(line);
      if (message.type === "get_state") {
        await writeFile(sessionFile, "{}\\n", "utf8");
        send({ id: message.id, success: true, data: { sessionFile } });
      } else if (message.type === "switch_session") {
        send({ id: message.id, success: true, data: { cancelled: false } });
      } else if (message.type === "prompt") {
        send({ id: message.id, success: true });
        await sleep(80);
        send({ type: "message_update", channel: "assistant", text: "RPC_ASSISTANT_DELTA_VISIBLE", raw_payload_secret: "RAW_RPC_FRAME_SECRET" });
        await sleep(10);
        send({ type: "message_update", channel: "thinking_delta", text: "THINKING_SECRET_SHOULD_NOT_RENDER" });
        await sleep(10);
        send({ type: "tool_execution_start", toolCallId: "rpc-tool-1", name: "bash", arguments: { command: "echo rpc", content: "RAW_ARG_SECRET_SHOULD_NOT_RENDER" }, raw_payload_secret: "RAW_RPC_FRAME_SECRET" });
        send({ type: "tool_execution_update", toolCallId: "rpc-tool-1", name: "bash", output: "RPC_TOOL_OUTPUT_CHUNK", raw_payload_secret: "RAW_RPC_FRAME_SECRET" });
        send({ type: "tool_execution_end", toolCallId: "rpc-tool-1", name: "bash", success: true, output: "RPC_TOOL_OUTPUT_FINAL", raw_payload_secret: "RAW_RPC_FRAME_SECRET" });
        await sleep(180);
        send({ type: "agent_end" });
      } else if (message.type === "get_last_assistant_text") {
        send({ id: message.id, success: true, data: { text: "FINAL_RPC_AUTHORITY_FROM_GET_LAST_ASSISTANT_TEXT" } });
        setTimeout(() => process.exit(0), 5);
      } else if (message.type === "abort") {
        send({ id: message.id, success: true });
        process.exit(0);
      }
    });
  `, "utf8");
}

async function runSubagentLogSelectorStreamingRpcPipelineProof(mod) {
  const sessionRoot = await mkdtemp(join(tmpdir(), "larva-subagent-rpc-stream-"));
  const cacheFile = join(sessionRoot, "subagent-presentation-log.json");
  const childScript = join(sessionRoot, "streaming-child.mjs");
  const sessionFile = join(sessionRoot, "child-sessions", "rpc-stream.jsonl");
  await writeStreamingSubagentChild(childScript, sessionFile);
  mod.resetSubagentPresentationStateForTests();

  const env = runtimeEnv({
    HOME: sessionRoot,
    LARVA_PI_CHILD_SESSION_DIR: join(sessionRoot, "child-sessions"),
    LARVA_PI_SUBAGENT_LOG_FILE: cacheFile,
    LARVA_PI_REAL_BIN: process.execPath,
    LARVA_PI_EXTENSION_FLAG: childScript,
    LARVA_PI_EXTENSION_ENTRY: "ignored-extension-entry.ts",
  });
  const commands = new Map();
  const tools = [];
  const ctx = {
    env,
    modelRegistry: { find: async (provider, modelId) => ({ provider, modelId }) },
    ui: { setStatus: async () => undefined },
  };
  const pi = {
    getAllTools: async () => ["read", "grep", "larva_subagent"],
    setActiveTools: async () => true,
    setModel: async () => true,
    on: () => undefined,
    registerTool: (tool) => { tools.push(tool); },
    registerCommand: (name, command) => {
      if (typeof name === "string") commands.set(name, command);
      else if (name && typeof name === "object") commands.set(name.name, name);
    },
  };
  await mod.initializeExtension(ctx, pi);
  await mod.commitPersona("ok", ctx, pi);
  const subagent = tools.find((tool) => tool.name === "larva_subagent");
  const command = commands.get("larva-log");
  if (!subagent || typeof subagent.execute !== "function" || !command) throw new Error("runtime proof setup missing subagent tool or log command");

  let component = null;
  const requestRenderEvents = [];
  const doneValues = [];
  const terminalWrites = [];
  const commandUi = {
    notify: () => undefined,
    setStatus: () => undefined,
    custom: async (factory, options) => {
      options?.onHandle?.({ focus: () => undefined });
      component = factory(
        { requestRender: () => requestRenderEvents.push({ index: requestRenderEvents.length + 1 }), terminal: { rows: 60, write: (data) => terminalWrites.push(data) } },
        { fg: (_token, text) => text, bold: (text) => text },
        { matches: () => false },
        (value) => doneValues.push(value),
      );
      component.handleInput?.("3");
      return null;
    },
  };

  const updates = [];
  const execution = subagent.execute("rpc-stream-call", { persona_id: "child", task: "stream child RPC frames into overlay" }, undefined, (update) => updates.push(update), ctx);
  await waitForSmokeCondition(
    () => mod.subagentPresentationLogForTests().find((entry) => entry.call_id === "rpc-stream-call" && entry.status === "running"),
    { label: "running presentation entry" },
  );
  const commandResult = await command.handler("", { env, modelRegistry: ctx.modelRegistry, ui: commandUi });
  if (component === null || commandResult?.ok !== true) throw new Error("subagent log overlay did not open during RPC stream proof");
  const rendersBeforeLive = requestRenderEvents.length;
  const liveEntry = await waitForSmokeCondition(
    () => mod.subagentPresentationLogForTests().find((entry) =>
      entry.call_id === "rpc-stream-call"
      && entry.live_assistant_preview?.includes("RPC_ASSISTANT_DELTA_VISIBLE")
      && entry.live_thinking_hidden === true
      && entry.tool_snapshots?.some((snapshot) => snapshot.toolCallId === "rpc-tool-1" && snapshot.status === "success" && snapshot.output_preview?.includes("RPC_TOOL_OUTPUT_FINAL"))),
    { label: "normalized child RPC presentation mutation" },
  );
  const rendersAfterLive = requestRenderEvents.length;
  const outputDuringPlain = renderedPlainText(component.render(100));
  component.handleInput?.("4");
  const timelineDuringPlain = renderedPlainText(component.render(100));
  const cacheDuringLive = JSON.parse(await readFile(cacheFile, "utf8"));
  const cacheDuringLiveText = JSON.stringify(cacheDuringLive);
  const result = await execution;
  await waitForSmokeCondition(
    () => mod.subagentPresentationLogForTests().find((entry) => entry.call_id === "rpc-stream-call" && entry.status === "success"),
    { label: "final presentation entry" },
  );
  const timelineAfterFinalPlain = renderedPlainText(component.render(100));
  component.handleInput?.("3");
  const outputAfterFinalPlain = renderedPlainText(component.render(100));
  const finalCacheText = JSON.stringify(JSON.parse(await readFile(cacheFile, "utf8")));
  const combinedVisible = [outputDuringPlain, timelineDuringPlain, timelineAfterFinalPlain, outputAfterFinalPlain].join("\n");
  const currentAfterFinal = mod.currentSubagentOverlayForTests();
  const resetResult = await mod.resetExtensionUI("subagent-log-selector-streaming-smoke");
  const afterReset = mod.larva_subagent_log("/tmp/does-not-exist.jsonl");

  const toolRowCount = (timelineDuringPlain.match(/↳/g) ?? []).length;
  const toolIdCount = (timelineDuringPlain.match(/rpc-tool-1/g) ?? []).length;
  return {
    status: "PASS",
    sessionRoot,
    cacheFile,
    path_exercised: [
      "fake child stdout RPC frame",
      "RpcClient.consume -> normalizeSubagentChildStreamEventForPresentation",
      "applyNormalizedSubagentStreamEvent(call_id=rpc-stream-call)",
      "retainedSubagentPresentationLog mutation",
      "notifySubagentPresentationOverlay -> refreshFromPresentationLog",
      "tui.requestRender",
      "selected entry re-read in SubagentPresentationLogOverlay.render",
    ],
    selectedTaskId: commandResult.details?.selected_task_id ?? null,
    currentAfterFinal,
    sessionFile,
    liveEntryKeys: Object.keys(liveEntry),
    updatePhases: updates.map((update) => update?.details?.phase ?? null),
    renderRequests: { beforeLive: rendersBeforeLive, afterLive: rendersAfterLive, afterFinal: requestRenderEvents.length },
    terminalWrites,
    samples: {
      outputDuring: outputDuringPlain.slice(0, 400),
      timelineDuring: timelineDuringPlain.slice(0, 400),
      outputAfterFinal: outputAfterFinalPlain.slice(0, 400),
    },
    assertions: {
      childRpcEventsDroveOverlayRenderRequest: rendersAfterLive > rendersBeforeLive,
      assistantDeltaRenderedFromRpc: outputDuringPlain.includes("RPC_ASSISTANT_DELTA_VISIBLE"),
      thinkingContentHidden: !combinedVisible.includes("THINKING_SECRET_SHOULD_NOT_RENDER") && combinedVisible.includes("thinking hidden"),
      timelineIncludesAssistantAndGroupedTool: timelineDuringPlain.includes("RPC_ASSISTANT_DELTA_VISIBLE") && toolRowCount === 1 && toolIdCount === 0 && timelineDuringPlain.includes("bash") && timelineDuringPlain.includes('command="echo rpc"') && timelineDuringPlain.includes("content=<omitted>") && timelineDuringPlain.includes("RPC_TOOL_OUTPUT_FINAL") && timelineDuringPlain.includes("success"),
      rawPayloadNeverRenderedOrPersisted: !combinedVisible.includes("RAW_RPC_FRAME_SECRET") && !combinedVisible.includes("RAW_ARG_SECRET_SHOULD_NOT_RENDER") && !cacheDuringLiveText.includes("RAW_RPC_FRAME_SECRET") && !cacheDuringLiveText.includes("RAW_ARG_SECRET_SHOULD_NOT_RENDER") && !finalCacheText.includes("RAW_RPC_FRAME_SECRET") && !finalCacheText.includes("RAW_ARG_SECRET_SHOULD_NOT_RENDER"),
      liveStateNotPersisted: !cacheDuringLiveText.includes("RPC_ASSISTANT_DELTA_VISIBLE") && !cacheDuringLiveText.includes("RPC_TOOL_OUTPUT_FINAL"),
      finalOutputAuthorityPreserved: result?.details?.result_text === "FINAL_RPC_AUTHORITY_FROM_GET_LAST_ASSISTANT_TEXT" && outputAfterFinalPlain.includes("FINAL_RPC_AUTHORITY_FROM_GET_LAST_ASSISTANT_TEXT"),
      activeTabAndSelectionPreservedAcrossRefresh: timelineAfterFinalPlain.includes("● 4 Timeline") && currentAfterFinal?.task_id === result?.details?.task_id,
      resetCleanupClosedAndCleared: resetResult.overlay_closed === true && resetResult.presentation_cleared === true && afterReset.details?.error?.code === "LARVA_SUBAGENT_LOG_NOT_OBSERVED" && terminalWrites.at(-1) === "\x1b[?1006l\x1b[?1000l",
    },
  };
}

async function subagentLogSelectorStreamingExpectedRed(evidence) {
  const mod = await import(pathToFileURL(extensionPath).href);
  const extensionRequire = createRequire(pathToFileURL(extensionPath).href);
  const piTui = await import(pathToFileURL(extensionRequire.resolve("@earendil-works/pi-tui")).href);
  const sessionRoot = await mkdtemp(join(tmpdir(), "larva-log-selector-streaming-"));
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
    live_assistant_preview: "ASSISTANT_FIRST LIVE_ASSISTANT_PREVIEW_VISIBLE_WHILE_RUNNING",
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
  const beforeClickFrame = component.render(100);
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
      rowsContainRequiredBoundedFields: /runner/.test(listText) && /waiting_for_child/.test(listText) && /…|\.\.\./.test(listText),
      rowsExcludeFullPromptOutputRawPayloads: !listText.includes("running prompt") && !listText.includes("FINAL_AUTHORITY") && !listText.includes("rawRpcSecret"),
      allRenderedLinesFit: allFrames.every((lines) => lines.every((line) => piTui.visibleWidth(line) <= 100)),
    },
    R3_processLocalLiveState_cacheSanitizer: {
      liveAssistantPreviewNotPersisted: !("live_assistant_preview" in liveCachedEntry),
      toolSnapshotsNotPersisted: !("tool_snapshots" in liveCachedEntry),
      timelineEventsNotPersisted: !("timeline_events" in liveCachedEntry),
      activeToolStateNotPersisted: !("active_tool_state" in liveCachedEntry),
      rawRpcEventsNotPersisted: !("raw_rpc_events" in liveCachedEntry) && JSON.stringify(cached).includes("rawRpcSecret") === false,
    },
    R4_timelineStream: {
      timelineTabExists: /Timeline/.test(detailPlain) && /● 4 Timeline/.test(fourthTabPlain),
      assistantAndToolChronological: fourthTabPlain.includes("ASSISTANT_FIRST") && fourthTabPlain.indexOf("ASSISTANT_FIRST") < fourthTabPlain.indexOf("bash"),
      groupedByToolCallId: (fourthTabPlain.match(/bash/g) ?? []).length === 1 && (fourthTabPlain.match(/↳/g) ?? []).length === 1,
      toolOutputOnlyBoundedTimelinePreview: fourthTabPlain.includes("SECRET_TOOL_TAIL") === false && fourthTabPlain.includes("preview: output") && outputPlain.includes("SECRET_TOOL_TAIL") === false,
      internalIdsHiddenByDefault: !fourthTabPlain.includes("tool-1"),
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
      tabOrderSummaryPromptOutputTimelineMetadata: /1 Summary.*2 Prompt.*3 Output.*4 Timeline.*5 Metadata/s.test(detailPlain),
      stableFrameAcrossSelectorTabsScroll: [selectorFrame, outputFrame, fourthTabFrame, fifthTabFrame].every((lines) => lines.length === detailFrame.length && lines[0] === detailFrame[0] && lines.at(-1) === detailFrame.at(-1)),
      keyboardMouseClickNoop: JSON.stringify(beforeClickFrame) === JSON.stringify(afterClickFrame),
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
  const actualChildRpcPipeline = await runSubagentLogSelectorStreamingRpcPipelineProof(mod);
  assertions.R12_childRpcPipeline = actualChildRpcPipeline.assertions;
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
    actualChildRpcPipeline,
    assertions,
  };
}

async function asyncSubagentContractExpectedRed(evidence) {
  const mod = await import(pathToFileURL(extensionPath).href);
  const sessionRoot = await mkdtemp(join(tmpdir(), "larva-async-subagent-contract-"));
  const childSessionRoot = join(sessionRoot, "child-sessions");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(childSessionRoot, { recursive: true });
  const childScript = join(sessionRoot, "async-contract-child.mjs");
  const childSessionFile = join(childSessionRoot, "async-contract.jsonl");
  const terminalMarkerFile = join(sessionRoot, "terminal-marker.txt");
  const terminalDelayMs = 650;
  await writeDelayedAsyncSubagentChild(childScript, {
    sessionFile: childSessionFile,
    finalText: `ASYNC_CALLBACK_FINAL ${"long final text ".repeat(520)}TAIL_SHOULD_NOT_DELIVER`,
    terminalDelayMs,
    terminalMarkerFile,
  });
  const source = await readFile(extensionPath, "utf8");
  const commands = new Map();
  const tools = [];
  const handlers = new Map();
  const sessionEntries = [];
  const callbackEntries = [];
  const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
  const recordCallback = (surface, customType, data, options = {}) => {
    const entry = { surface, customType, data, options };
    sessionEntries.push(entry);
    if (customType === "larva-subagent-result") callbackEntries.push(entry);
    return entry;
  };
  const ctx = {
    env: runtimeEnv({
      HOME: sessionRoot,
      LARVA_PI_CHILD_SESSION_DIR: childSessionRoot,
      LARVA_PI_SUBAGENT_LOG_FILE: join(sessionRoot, "subagent-presentation-log.json"),
      LARVA_PI_REAL_BIN: process.execPath,
      LARVA_PI_EXTENSION_FLAG: childScript,
      LARVA_PI_EXTENSION_ENTRY: "ignored-extension-entry.ts",
      LARVA_PI_INTERACTIVE_TUI: "1",
    }),
    modelRegistry: { find: async (provider, modelId) => ({ provider, modelId }) },
    ui: { setStatus: async () => undefined, notify: async () => undefined, custom: async () => ({ opened: true }) },
    hasUI: true,
    session: {
      entries: sessionEntries,
      isStreaming: true,
      getEntries: () => sessionEntries,
      appendEntry: (customType, data, options) => recordCallback("session.appendEntry", customType, data, options),
      addCustomEntry: (customType, data, options) => recordCallback("session.addCustomEntry", customType, data, options),
    },
    appendEntry: (customType, data, options) => recordCallback("ctx.appendEntry", customType, data, options),
    sendCustomMessage: async (customType, data, options) => recordCallback("ctx.sendCustomMessage", customType, data, options),
    sendUserMessage: async (message, options = {}) => {
      sessionEntries.push({ surface: "ctx.sendUserMessage", data: { message, options } });
      if (options.customType === "larva-subagent-result") recordCallback("ctx.sendUserMessage", options.customType, { message, ...(options.details ?? {}) }, options);
    },
  };
  const pi = {
    getAllTools: async () => ["read", "larva_subagent", "larva_subagent_status", "larva_subagent_cancel"],
    setActiveTools: async () => true,
    setModel: async () => true,
    registerCommand: (name, command) => {
      if (typeof name === "string") commands.set(name, command);
      else if (name && typeof name === "object") commands.set(name.name, name);
    },
    registerTool: (tool) => { tools.push(tool); },
    registerShortcut: () => undefined,
    on: (event, handler) => { handlers.set(event, handler); },
  };
  await mod.initializeExtension(ctx, pi);
  await mod.commitPersona("ok", ctx, pi);
  mod.resetSubagentPresentationStateForTests();

  const unifiedCommand = commands.get("larva-subagent");
  const subagentTool = tools.find((tool) => tool.name === "larva_subagent");
  const commandText = (result) => {
    if (typeof result?.content?.[0]?.text === "string") return result.content[0].text;
    if (typeof result?.text === "string") return result.text;
    if (typeof result === "string") return result;
    return JSON.stringify(result ?? null);
  };
  const resultErrorCode = (result) => result?.details?.error?.code ?? result?.error?.code ?? null;
  const invokeUnifiedCommand = async (input, commandCtx) => {
    if (!unifiedCommand?.handler) return { invoked: false, input, result: null, error: "COMMAND_NOT_REGISTERED" };
    try {
      return { invoked: true, input, result: await unifiedCommand.handler(input, commandCtx), error: null };
    } catch (error) {
      return { invoked: true, input, result: null, error: error?.message ?? String(error) };
    }
  };
  const toolByName = (name) => tools.find((tool) => tool.name === name) ?? null;
  const statusTool = toolByName("larva_subagent_status");
  const cancelTool = toolByName("larva_subagent_cancel");
  const runTool = async (tool, callId, input, toolCtx = ctx, signal = undefined, onUpdate = undefined) => {
    if (!tool) return { invoked: false, input, result: null, error: "TOOL_NOT_REGISTERED" };
    try {
      if (typeof tool.execute === "function") {
        return { invoked: true, input, result: await tool.execute(callId, input, signal, onUpdate, toolCtx), error: null };
      }
      if (typeof tool.handler === "function") {
        return { invoked: true, input, result: await tool.handler(input), error: null };
      }
      return { invoked: false, input, result: null, error: "TOOL_HAS_NO_RUNNER" };
    } catch (error) {
      return { invoked: true, input, result: null, error: error?.message ?? String(error) };
    }
  };
  const detailsOf = (result) => result?.details ?? result ?? null;
  const errorCodeOf = (result) => detailsOf(result)?.error?.code ?? result?.error?.code ?? null;
  const normalizeCodePointCount = (value) => Array.from(String(value ?? "").normalize("NFC")).length;
  const invokeStatus = async (taskId, label, extra = {}) => {
    const input = taskId === null ? { ...extra } : { task_id: taskId, ...extra };
    const invoked = await runTool(statusTool, `status-${label}`, input, ctx);
    const details = detailsOf(invoked.result);
    return {
      label,
      task_id: taskId,
      invoked: invoked.invoked,
      error: invoked.error,
      status: details?.status ?? null,
      runs: Array.isArray(details?.runs) ? details.runs : null,
      errorCode: errorCodeOf(invoked.result) ?? invoked.error,
    };
  };
  const invokeCancel = async (taskId, reason, label, cancelCtx = ctx) => {
    const input = { task_id: taskId, reason };
    const invoked = await runTool(cancelTool, `cancel-${label}`, input, cancelCtx);
    const details = detailsOf(invoked.result);
    return {
      label,
      task_id: taskId,
      reasonCodePoints: normalizeCodePointCount(reason),
      invoked: invoked.invoked,
      error: invoked.error,
      status: details?.status ?? null,
      errorCode: errorCodeOf(invoked.result) ?? invoked.error,
      callbackCountAtReturn: callbackEntries.length,
    };
  };
  const callbackForStatus = (status, startIndex = 0) => callbackEntries.slice(startIndex).find((entry) => entry?.data?.status === status) ?? null;
  const callbackTextFrom = (entry) => {
    const data = entry?.data ?? {};
    return typeof data.result_text === "string" ? data.result_text : typeof data.message === "string" ? data.message : "";
  };
  const hasCallbackPayloadShape = (entry, expectedStatus) => {
    const data = entry?.data ?? null;
    const text = callbackTextFrom(entry);
    const errorValue = data?.error ?? null;
    return entry?.customType === "larva-subagent-result"
      && entry?.options?.triggerTurn === true
      && entry?.options?.deliverAs === "steer"
      && typeof data?.task_id === "string"
      && typeof data?.persona_id === "string"
      && data?.status === expectedStatus
      && typeof data?.result_text === "string"
      && normalizeCodePointCount(text) <= 6000
      && normalizeCodePointCount(data?.message) <= 6000
      && typeof data?.callback_id === "string"
      && typeof data?.completed_at === "string"
      && !Number.isNaN(Date.parse(data.completed_at))
      && (expectedStatus === "success"
        ? errorValue === null
        : data.result_text === "" && isRecord(errorValue) && typeof errorValue.code === "string" && typeof errorValue.message === "string");
  };
  const hasStatusRunShape = (run, taskId, expectedStatuses) => isRecord(run)
    && run.task_id === taskId
    && typeof run.persona_id === "string"
    && expectedStatuses.includes(run.status)
    && typeof run.phase === "string"
    && typeof run.result_pending === "boolean"
    && typeof run.updated_at === "string"
    && !Number.isNaN(Date.parse(run.updated_at))
    && "error" in run
    && (run.error === null || (isRecord(run.error) && typeof run.error.code === "string" && typeof run.error.message === "string"));

  let acceptedResult = null;
  let acceptedError = null;
  let runningEntryBeforeCommand = null;
  const updates = [];
  const startedAt = Date.now();
  const subagentPromise = subagentTool
    ? (subagentTool.execute
      ? subagentTool.execute("async-contract-call", { persona_id: "child", task: "produce one async callback" }, undefined, (update) => updates.push(update), ctx)
      : subagentTool.handler({ persona_id: "child", task: "produce one async callback" }))
    : Promise.resolve({ error: "TOOL_NOT_REGISTERED" });
  try {
    runningEntryBeforeCommand = await waitForSmokeCondition(
      () => mod.subagentPresentationLogForTests().find((entry) => entry.call_id === "async-contract-call" && entry.status === "running" && typeof entry.task_id === "string" && ["session_ready", "prompt_sent", "waiting_for_child"].includes(entry.phase)),
      { label: "async contract running entry before streaming command", timeoutMs: 1_000 },
    );
  } catch {
    runningEntryBeforeCommand = null;
  }
  const statusRunningObservation = await invokeStatus(runningEntryBeforeCommand?.task_id ?? childSessionFile, "running-observed");

  const streamingCustomCalls = [];
  const streamingCtx = {
    ...ctx,
    isIdle: () => false,
    ui: {
      setStatus: async () => undefined,
      notify: async () => undefined,
      custom: async (_factory, options) => {
        streamingCustomCalls.push({ options });
        return { opened: true };
      },
    },
  };
  const streamingSlashResult = await invokeUnifiedCommand("", streamingCtx);

  try {
    acceptedResult = await subagentPromise;
  } catch (error) {
    acceptedError = error?.message ?? String(error);
    acceptedResult = { error: acceptedError };
  }
  const elapsedMs = Date.now() - startedAt;
  const terminalMarkerExistsAtReturn = await exists(terminalMarkerFile);
  try {
    await waitForSmokeCondition(() => callbackEntries.length >= 1, {
      label: "single larva subagent result callback",
      timeoutMs: terminalDelayMs + 2_000,
    });
    await sleep(100);
  } catch {
    // A failure here is reflected by the callback assertion group below.
  }

  const matrixTaskId = join(childSessionRoot, "matrix-observed.jsonl");
  mod.recordSubagentPresentationEntryForTests(matrixTaskId, "child", "success", {
    phase: "success",
    task_prompt: "mode matrix prompt",
    task_preview: "mode matrix prompt",
    result_text: "MODE_MATRIX_FINAL",
    updated_at: "2026-06-08T00:00:00.000Z",
  });
  const rpcCustomCalls = [];
  const rpcCtx = {
    ...ctx,
    env: { ...ctx.env, LARVA_PI_INTERACTIVE_TUI: "0" },
    hasUI: true,
    ui: {
      setStatus: async () => undefined,
      notify: async () => undefined,
      custom: undefined,
    },
  };
  const printJsonCtx = {
    ...ctx,
    env: { ...ctx.env, LARVA_PI_INTERACTIVE_TUI: "0" },
    hasUI: false,
    ui: undefined,
  };
  const rpcList = await invokeUnifiedCommand("", rpcCtx);
  const rpcExact = await invokeUnifiedCommand(matrixTaskId, rpcCtx);
  const printJsonExact = await invokeUnifiedCommand(matrixTaskId, printJsonCtx);
  const printJsonView = await invokeUnifiedCommand("", printJsonCtx);
  const printJsonCancel = await invokeUnifiedCommand(`--cancel ${matrixTaskId}`, printJsonCtx);
  const printJsonClear = await invokeUnifiedCommand("--clear", printJsonCtx);
  const modeMatrixFallbacks = {
    rpcList: { ...rpcList, text: commandText(rpcList.result), errorCode: resultErrorCode(rpcList.result), customCallCount: rpcCustomCalls.length },
    rpcExact: { ...rpcExact, text: commandText(rpcExact.result), errorCode: resultErrorCode(rpcExact.result), customCallCount: rpcCustomCalls.length },
    printJsonExact: { ...printJsonExact, text: commandText(printJsonExact.result), errorCode: resultErrorCode(printJsonExact.result) },
    printJsonView: { ...printJsonView, text: commandText(printJsonView.result), errorCode: resultErrorCode(printJsonView.result) },
    printJsonCancel: { ...printJsonCancel, text: commandText(printJsonCancel.result), errorCode: resultErrorCode(printJsonCancel.result) },
    printJsonClear: { ...printJsonClear, text: commandText(printJsonClear.result), errorCode: resultErrorCode(printJsonClear.result) },
  };

  const acceptedDetails = acceptedResult?.details ?? acceptedResult;
  const acceptedText = commandText(acceptedResult);
  const callbacksForAcceptedTask = callbackEntries.filter((entry) => entry?.data?.task_id === acceptedDetails?.task_id);
  const callbackEnvelope = callbacksForAcceptedTask[0] ?? null;
  const callback = callbackEnvelope?.data ?? null;
  const callbackOptions = callbackEnvelope?.options ?? {};
  const callbackText = typeof callback?.result_text === "string" ? callback.result_text : typeof callback?.message === "string" ? callback.message : "";
  const callbackCodePoints = Array.from(callbackText.normalize?.("NFC") ?? callbackText).length;
  const callbackBoundaryText = typeof callback?.message === "string" ? callback.message : typeof callback?.content === "string" ? callback.content : "";
  const callbackMessageCodePoints = normalizeCodePointCount(callbackBoundaryText);
  const acceptedTaskIdForProbes = typeof acceptedDetails?.task_id === "string"
    ? acceptedDetails.task_id
    : runningEntryBeforeCommand?.task_id ?? childSessionFile;
  const statusAcceptedObservation = await invokeStatus(acceptedTaskIdForProbes, "accepted-observed");
  const statusTerminalObservation = await invokeStatus(acceptedTaskIdForProbes, "terminal-observed");
  const statusObservationRows = [statusRunningObservation, statusAcceptedObservation, statusTerminalObservation];
  const statusObservedRuns = statusObservationRows.flatMap((row) => Array.isArray(row.runs) ? row.runs : []);
  const statusSchemaProbe = {
    expectedTaskId: acceptedTaskIdForProbes,
    observations: statusObservationRows,
    observedRuns: statusObservedRuns,
  };

  const failedCallbackChild = join(sessionRoot, "failed-callback-child.mjs");
  const failedCallbackSession = join(childSessionRoot, "failed-callback.jsonl");
  await writeFile(failedCallbackChild, `
    import { createInterface } from "node:readline";
    import { mkdir, writeFile } from "node:fs/promises";
    import { dirname } from "node:path";
    const sessionFile = ${JSON.stringify(failedCallbackSession)};
    await mkdir(dirname(sessionFile), { recursive: true });
    const rl = createInterface({ input: process.stdin });
    const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
    rl.on("line", async (line) => {
      const message = JSON.parse(line);
      if (message.type === "get_state") { await writeFile(sessionFile, "{}\\n", "utf8"); send({ id: message.id, success: true, data: { sessionFile } }); }
      else if (message.type === "prompt") { send({ id: message.id, success: true, data: {} }); send({ type: "agent_end" }); }
      else if (message.type === "get_last_assistant_text") { send({ id: message.id, success: true, data: { text: null } }); setTimeout(() => process.exit(0), 5); }
      else if (message.type === "abort") { send({ id: message.id, success: true }); process.exit(0); }
    });
  `, "utf8");
  const failedCallbackStart = callbackEntries.length;
  const failedCallbackInvocation = await runTool(
    subagentTool,
    "failed-callback-shape",
    { persona_id: "child", task: "fail and send failed callback shape" },
    { ...ctx, env: { ...ctx.env, LARVA_PI_EXTENSION_FLAG: failedCallbackChild, LARVA_PI_REAL_BIN: process.execPath } },
  );
  try { await waitForSmokeCondition(() => callbackForStatus("failed", failedCallbackStart), { label: "failed callback shape", timeoutMs: 500 }); } catch {}
  const failedCallback = callbackForStatus("failed", failedCallbackStart);

  const exact500Reason = "x".repeat(500);
  const overlongReason = "x".repeat(501);
  const siblingChild = join(sessionRoot, "sibling-cancel-child.mjs");
  const siblingASession = join(childSessionRoot, "cancel-source-a.jsonl");
  const siblingBSession = join(childSessionRoot, "cancel-source-b.jsonl");
  await writeDelayedAsyncSubagentChild(siblingChild, { sessionFile: siblingASession, finalText: "SIBLING_A_FINAL", terminalDelayMs: 450, terminalMarkerFile: join(sessionRoot, "sibling-a-terminal.txt") });
  const siblingBCopy = join(sessionRoot, "sibling-b-child.mjs");
  await writeDelayedAsyncSubagentChild(siblingBCopy, { sessionFile: siblingBSession, finalText: "SIBLING_B_FINAL", terminalDelayMs: 450, terminalMarkerFile: join(sessionRoot, "sibling-b-terminal.txt") });
  const siblingACtx = { ...ctx, env: { ...ctx.env, LARVA_PI_EXTENSION_FLAG: siblingChild, LARVA_PI_REAL_BIN: process.execPath } };
  const siblingBCtx = { ...ctx, env: { ...ctx.env, LARVA_PI_EXTENSION_FLAG: siblingBCopy, LARVA_PI_REAL_BIN: process.execPath } };
  const siblingAUpdates = [];
  const siblingBUpdates = [];
  const siblingAPromise = runTool(subagentTool, "cancel-source-a", { persona_id: "child", task: "cancel only task A" }, siblingACtx, undefined, (update) => siblingAUpdates.push(update));
  const siblingBPromise = runTool(subagentTool, "cancel-source-b", { persona_id: "child", task: "sibling B must continue" }, siblingBCtx, undefined, (update) => siblingBUpdates.push(update));
  let siblingARunning = null;
  let siblingBRunning = null;
  try { siblingARunning = await waitForSmokeCondition(() => mod.subagentPresentationLogForTests().find((entry) => entry.call_id === "cancel-source-a" && entry.status === "running"), { label: "sibling A running", timeoutMs: 500 }); } catch {}
  try { siblingBRunning = await waitForSmokeCondition(() => mod.subagentPresentationLogForTests().find((entry) => entry.call_id === "cancel-source-b" && entry.status === "running"), { label: "sibling B running", timeoutMs: 500 }); } catch {}
  const siblingTaskId = siblingARunning?.task_id ?? siblingASession;
  const userCancelCallbackStart = callbackEntries.length;
  const userCancelResult = await invokeUnifiedCommand(`--cancel ${siblingTaskId}`, siblingACtx);
  const modelCancelExact500 = await invokeCancel(siblingTaskId, exact500Reason, "reason-500", siblingACtx);
  const modelCancelOverlong = await invokeCancel(siblingTaskId, overlongReason, "reason-overlong", siblingACtx);
  const siblingResults = await Promise.all([siblingAPromise, siblingBPromise]);
  try { await waitForSmokeCondition(() => callbackForStatus("cancelled", userCancelCallbackStart), { label: "cancelled callback shape", timeoutMs: 500 }); } catch {}
  const cancelledCallback = callbackForStatus("cancelled", userCancelCallbackStart);
  const parentEnvelopeAfterCancel = mod.getActiveEnvelope();
  const cancellationSourceRulesProbe = {
    taskA: { task_id: siblingTaskId, runningObserved: siblingARunning !== null, result: siblingResults[0] },
    taskB: { task_id: siblingBRunning?.task_id ?? siblingBSession, runningObserved: siblingBRunning !== null, result: siblingResults[1] },
    userCancelResult,
    modelCancelExact500,
    callbackEntriesAfterUserCancel: callbackEntries.slice(userCancelCallbackStart),
    parentEnvelopeAfterCancel,
    siblingAUpdates,
    siblingBUpdates,
  };
  const cancelReasonBoundProbe = {
    exact500: modelCancelExact500,
    overlong: modelCancelOverlong,
    normalizedCounts: { exact500: normalizeCodePointCount(exact500Reason), overlong: normalizeCodePointCount(overlongReason) },
  };
  const callbackShapeProbe = {
    failedInvocation: failedCallbackInvocation,
    failedCallback,
    cancelledCallback,
    failedStartIndex: failedCallbackStart,
    userCancelStartIndex: userCancelCallbackStart,
  };

  const runSubagentConsoleRuntimeProbe = async () => {
    const extensionRequire = createRequire(pathToFileURL(extensionPath).href);
    const piTui = await import(pathToFileURL(extensionRequire.resolve("@earendil-works/pi-tui")).href);
    const consoleRoot = join(sessionRoot, "a9-subagent-console-runtime");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(consoleRoot, { recursive: true });
    mod.resetSubagentPresentationStateForTests();
    const parentBeforeConsole = mod.getActiveEnvelope();

    const selectedSession = join(childSessionRoot, "a9-selected-running.jsonl");
    const siblingSession = join(childSessionRoot, "a9-sibling-running.jsonl");
    const selectedChild = join(consoleRoot, "selected-child.mjs");
    const siblingChildForConsole = join(consoleRoot, "sibling-child.mjs");
    await writeDelayedAsyncSubagentChild(selectedChild, {
      sessionFile: selectedSession,
      finalText: "A9_SELECTED_FINAL_SHOULD_NOT_BE_REQUIRED_FOR_CANCEL",
      terminalDelayMs: 1_200,
      terminalMarkerFile: join(consoleRoot, "selected-terminal.txt"),
    });
    await writeDelayedAsyncSubagentChild(siblingChildForConsole, {
      sessionFile: siblingSession,
      finalText: "A9_SIBLING_FINAL_SHOULD_SURVIVE_SELECTED_CANCEL",
      terminalDelayMs: 1_200,
      terminalMarkerFile: join(consoleRoot, "sibling-terminal.txt"),
    });

    const unsafePrompt = `PROMPT_START ${"prompt body ".repeat(320)}\u001b[31mPROMPT_ANSI_UNSAFE\u001b[0m PROMPT_TAIL_SHOULD_NOT_RENDER`;
    const unsafeOutput = `ASSISTANT_OUTPUT_START ${"assistant body ".repeat(320)}\u0007 OUTPUT_TAIL_SHOULD_NOT_RENDER`;
    const unsafeTimeline = `TIMELINE_START ${"timeline body ".repeat(320)} TIMELINE_TAIL_SHOULD_NOT_RENDER`;
    const rawRpcSecret = "RAW_RPC_SECRET_SHOULD_NOT_RENDER";
    const selectedCtx = { ...ctx, env: { ...ctx.env, LARVA_PI_EXTENSION_FLAG: selectedChild, LARVA_PI_REAL_BIN: process.execPath } };
    const siblingCtx = { ...ctx, env: { ...ctx.env, LARVA_PI_EXTENSION_FLAG: siblingChildForConsole, LARVA_PI_REAL_BIN: process.execPath } };
    const selectedUpdates = [];
    const siblingUpdatesForConsole = [];
    const selectedPromise = runTool(subagentTool, "a9-console-selected", { persona_id: "child", task: unsafePrompt }, selectedCtx, undefined, (update) => selectedUpdates.push(update));
    const siblingPromise = runTool(subagentTool, "a9-console-sibling", { persona_id: "child", task: "sibling task must survive exact selected cancel" }, siblingCtx, undefined, (update) => siblingUpdatesForConsole.push(update));
    let selectedRunning = null;
    let siblingRunningForConsole = null;
    try { selectedRunning = await waitForSmokeCondition(() => mod.subagentPresentationLogForTests().find((entry) => entry.call_id === "a9-console-selected" && entry.status === "running"), { label: "A9 selected running task", timeoutMs: 700 }); } catch {}
    try { siblingRunningForConsole = await waitForSmokeCondition(() => mod.subagentPresentationLogForTests().find((entry) => entry.call_id === "a9-console-sibling" && entry.status === "running"), { label: "A9 sibling running task", timeoutMs: 700 }); } catch {}

    const selectedTaskId = selectedRunning?.task_id ?? selectedSession;
    const siblingTaskIdForConsole = siblingRunningForConsole?.task_id ?? siblingSession;
    if (!(await exists(selectedTaskId))) await writeFile(selectedTaskId, "{}\n", "utf8");
    if (!(await exists(siblingTaskIdForConsole))) await writeFile(siblingTaskIdForConsole, "{}\n", "utf8");
    mod.recordSubagentPresentationEntryForTests(siblingTaskIdForConsole, "sibling", "running", {
      call_id: "a9-console-sibling",
      phase: "waiting_for_child",
      mode: "new",
      task_preview: "sibling task must survive exact selected cancel",
      task_prompt: "sibling prompt should remain observed",
      live_assistant_preview: "SIBLING_STILL_RUNNING_PREVIEW",
      updated_at: "2026-06-08T00:00:00.000Z",
    });
    mod.recordSubagentPresentationEntryForTests(selectedTaskId, "child", "running", {
      call_id: "a9-console-selected",
      phase: "waiting_for_child",
      mode: "new",
      task_preview: "selected task preview",
      task_prompt: unsafePrompt,
      result_text: "thinking_delta SHOULD_BE_HIDDEN_FROM_OUTPUT",
      live_assistant_preview: unsafeOutput,
      live_thinking_hidden: true,
      timeline_events: [
        { kind: "assistant", text: unsafeTimeline },
        { kind: "thinking_hidden" },
        { kind: "tool", toolCallId: "a9-internal-tool-id", snapshot: { toolCallId: "a9-internal-tool-id", name: "bash", status: "running", args_preview: JSON.stringify({ command: "printf safe", content: rawRpcSecret }), output_preview: unsafeTimeline } },
      ],
      raw_rpc_events: [{ raw: rawRpcSecret }],
      updated_at: "2026-06-08T00:00:01.000Z",
    });

    const overlayResult = mod.larva_subagent_log(selectedTaskId);
    const overlayEntry = overlayResult.details?.entries?.[0] ?? null;
    const terminalWrites = [];
    const requestRenderEvents = [];
    const component = overlayEntry === null ? null : new mod.SubagentPresentationLogOverlay({
      entry: overlayEntry,
      generation: overlayResult.details?.overlay_generation ?? 1,
      tui: { terminal: { rows: 42, write: (data) => terminalWrites.push(data) }, requestRender: () => requestRenderEvents.push("render") },
    });
    const renderTab = (key) => {
      if (component === null) return { key, lines: [], plain: "" };
      component.handleInput?.(key);
      const lines = component.render(80);
      return { key, lines, plain: renderedPlainText(lines) };
    };
    const summaryTab = renderTab("1");
    const promptTab = renderTab("2");
    const outputTab = renderTab("3");
    const timelineTab = renderTab("4");
    const metadataTab = renderTab("5");
    const beforeCancelFrame = component?.render(80) ?? [];
    component?.handleInput?.("c");
    const afterOverlayCancelFrame = component?.render(80) ?? [];
    const afterOverlayCancelEntries = mod.subagentPresentationLogForTests();
    const cancelCtx = {
      ...ctx,
      hasUI: true,
      ui: {
        setStatus: async () => undefined,
        notify: async () => undefined,
        confirm: async () => true,
        custom: async () => ({ opened: true }),
      },
    };
    const canonicalCancel = await invokeUnifiedCommand(`--cancel ${selectedTaskId}`, cancelCtx);
    const entriesAfterCancel = mod.subagentPresentationLogForTests();
    const selectedAfterCancel = entriesAfterCancel.find((entry) => entry.task_id === selectedTaskId) ?? null;
    const siblingAfterCancel = entriesAfterCancel.find((entry) => entry.task_id === siblingTaskIdForConsole) ?? null;
    const parentAfterCancel = mod.getActiveEnvelope();
    const canonicalCancelDetails = detailsOf(canonicalCancel.result);
    const canonicalCancelStatus = canonicalCancelDetails?.status ?? null;

    const childFilesBeforeClear = { selected: await exists(selectedTaskId), sibling: await exists(siblingTaskIdForConsole) };
    const canonicalClear = await invokeUnifiedCommand("--clear", { ...ctx, hasUI: true, ui: { setStatus: async () => undefined, notify: async () => undefined, custom: async () => ({ opened: true }) } });
    const entriesAfterCanonicalClear = mod.subagentPresentationLogForTests();
    const childFilesAfterCanonicalClear = { selected: await exists(selectedTaskId), sibling: await exists(siblingTaskIdForConsole) };
    const legacyClear = mod.larva_subagent_log("--clear");
    const entriesAfterLegacyClear = mod.subagentPresentationLogForTests();
    const childFilesAfterLegacyClear = { selected: await exists(selectedTaskId), sibling: await exists(siblingTaskIdForConsole) };
    const parentAfterClear = mod.getActiveEnvelope();
    component?.dispose?.();

    const settleWithTimeout = async (promise, label) => Promise.race([
      promise,
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true, label }), 1_800)),
    ]);
    const selectedSettled = await settleWithTimeout(selectedPromise, "selected");
    const siblingSettled = await settleWithTimeout(siblingPromise, "sibling");
    const cleanupHandler = handlers.get("shutdown") ?? handlers.get("session_end") ?? handlers.get("exit");
    if (typeof cleanupHandler === "function") {
      try { await cleanupHandler({ reason: "a9-subagent-console-runtime-probe" }, ctx); } catch {}
    }

    const renderedFrames = [summaryTab, promptTab, outputTab, timelineTab, metadataTab].map((tab) => tab.lines);
    const combinedRendered = [summaryTab, promptTab, outputTab, timelineTab, metadataTab].map((tab) => tab.plain).join("\n");
    const noRawControlOrAnsi = !/\x1b\[[0-9;]*m/.test(combinedRendered) && !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(combinedRendered);
    const parentBeforePersona = parentBeforeConsole?.persona_id ?? null;
    const finalParentPersona = parentAfterClear?.persona_id ?? null;
    const canonicalCancelAcceptedStatuses = new Set(["cancelling", "cancelled", "success"]);
    const assertions = {
      consolePaneSummaryObserved: summaryTab.plain.includes("● 1 Summary") && summaryTab.plain.includes("Status") && summaryTab.plain.includes("running"),
      consolePanePromptObserved: promptTab.plain.includes("● 2 Prompt") && promptTab.plain.includes("Initial Prompt") && promptTab.plain.includes("PROMPT_START"),
      consolePaneOutputObserved: outputTab.plain.includes("● 3 Output") && outputTab.plain.includes("ASSISTANT_OUTPUT_START") && outputTab.plain.includes("thinking hidden"),
      consolePaneTimelineObserved: timelineTab.plain.includes("● 4 Timeline") && timelineTab.plain.includes("Timeline") && timelineTab.plain.includes("bash") && timelineTab.plain.includes("preview: output"),
      consolePaneMetadataObserved: metadataTab.plain.includes("● 5 Metadata") && metadataTab.plain.includes("Metadata") && /sequence/i.test(metadataTab.plain),
      exactSelectedCancelRouteRegistered: commands.has("larva-subagent"),
      exactSelectedCancelInvokedCanonicalRoute: canonicalCancel.invoked === true && canonicalCancel.error === null,
      exactSelectedCancelTargetsSelectedTask: canonicalCancelAcceptedStatuses.has(canonicalCancelStatus) || ["cancelling", "cancelled"].includes(selectedAfterCancel?.status ?? ""),
      exactSelectedCancelPreservesSibling: siblingAfterCancel?.task_id === siblingTaskIdForConsole && siblingAfterCancel.status !== "cancelled",
      exactSelectedCancelPreservesParent: parentAfterCancel?.persona_id === parentBeforePersona,
      rendererBoundsAllLinesFit: renderedFrames.every((lines) => lines.every((line) => piTui.visibleWidth(line) <= 80)),
      rendererBoundsPromptSafe: promptTab.lines.length <= 42 && noRawControlOrAnsi && !promptTab.plain.includes("PROMPT_TAIL_SHOULD_NOT_RENDER"),
      rendererBoundsOutputSafe: outputTab.lines.length <= 42 && !outputTab.plain.includes("OUTPUT_TAIL_SHOULD_NOT_RENDER") && !outputTab.plain.includes("SHOULD_BE_HIDDEN_FROM_OUTPUT"),
      rendererBoundsTimelineSafe: timelineTab.lines.length <= 42 && !timelineTab.plain.includes("TIMELINE_TAIL_SHOULD_NOT_RENDER") && !timelineTab.plain.includes("a9-internal-tool-id") && !timelineTab.plain.includes(rawRpcSecret),
      rendererBoundsMetadataSafe: metadataTab.lines.length <= 42 && !metadataTab.plain.includes(rawRpcSecret) && !metadataTab.plain.includes("raw_rpc_events") && !metadataTab.plain.includes("{\"raw\""),
      canonicalClearRouteRegistered: commands.has("larva-subagent"),
      canonicalClearClearsPresentationOnly: canonicalClear.invoked === true && canonicalClear.error === null && entriesAfterCanonicalClear.length === 0,
      clearDeletesNoChildSessionFiles: childFilesBeforeClear.selected === true && childFilesBeforeClear.sibling === true && childFilesAfterCanonicalClear.selected === true && childFilesAfterCanonicalClear.sibling === true && childFilesAfterLegacyClear.selected === true && childFilesAfterLegacyClear.sibling === true,
      clearPreservesParentState: parentBeforePersona === finalParentPersona,
      legacyClearDemonstratesAdapterLocalSemanticsOnly: legacyClear.ok === true && entriesAfterLegacyClear.length === 0,
    };

    return {
      status: Object.values(assertions).every(Boolean) ? "PASS" : "EXPECTED_RED",
      selectedTaskId,
      siblingTaskId: siblingTaskIdForConsole,
      registeredCommands: Array.from(commands.keys()),
      registeredTools: tools.map((tool) => tool.name),
      paneSamples: {
        summary: summaryTab.plain.slice(0, 500),
        prompt: promptTab.plain.slice(0, 500),
        output: outputTab.plain.slice(0, 500),
        timeline: timelineTab.plain.slice(0, 500),
        metadata: metadataTab.plain.slice(0, 500),
      },
      cancelProbe: {
        selectedRunningObserved: selectedRunning !== null,
        siblingRunningObserved: siblingRunningForConsole !== null,
        beforeCancelTaskIds: afterOverlayCancelEntries.map((entry) => ({ task_id: entry.task_id, status: entry.status })),
        canonicalCancel,
        canonicalCancelStatus,
        selectedAfterCancel,
        siblingAfterCancel,
        parentAfterCancel,
        beforeCancelFrame: renderedPlainText(beforeCancelFrame).slice(0, 300),
        afterOverlayCancelFrame: renderedPlainText(afterOverlayCancelFrame).slice(0, 300),
      },
      rendererProbe: {
        terminalWrites,
        requestRenderEvents,
        noRawControlOrAnsi,
        renderedLineCounts: {
          summary: summaryTab.lines.length,
          prompt: promptTab.lines.length,
          output: outputTab.lines.length,
          timeline: timelineTab.lines.length,
          metadata: metadataTab.lines.length,
        },
      },
      clearProbe: {
        canonicalClear,
        entriesAfterCanonicalClear: entriesAfterCanonicalClear.map((entry) => ({ task_id: entry.task_id, status: entry.status })),
        legacyClear: { ok: legacyClear.ok, text: legacyClear.content?.[0]?.text ?? "" },
        childFilesBeforeClear,
        childFilesAfterCanonicalClear,
        childFilesAfterLegacyClear,
        parentAfterClear,
      },
      settled: { selected: selectedSettled, sibling: siblingSettled, selectedUpdates, siblingUpdates: siblingUpdatesForConsole },
      assertions,
    };
  };
  const subagentConsoleRuntimeProbe = await runSubagentConsoleRuntimeProbe();

  const callbackCountsByTaskId = callbackEntries.reduce((counts, entry) => {
    const taskId = entry?.data?.task_id;
    if (typeof taskId === "string") counts[taskId] = (counts[taskId] ?? 0) + 1;
    return counts;
  }, {});
  const lifecycleRows = [];
  for (const eventName of ["reload", "resume", "fork", "quit"]) {
    const handler = handlers.get(eventName);
    let result = null;
    let errorMessage = null;
    if (typeof handler === "function") {
      try { result = await handler({ reason: `async-contract-${eventName}` }, ctx); }
      catch (error) { errorMessage = error?.message ?? String(error); }
    }
    lifecycleRows.push({
      event: eventName,
      handlerRegistered: typeof handler === "function",
      result,
      error: errorMessage,
      callbackCountAfterEvent: callbackEntries.length,
      registeredHandlers: Array.from(handlers.keys()),
    });
  }
  const idempotencyStaleProbe = {
    callbackCountsByTaskId,
    duplicateTaskId: acceptedTaskIdForProbes,
    duplicateCallbackCount: callbackCountsByTaskId[acceptedTaskIdForProbes] ?? 0,
    staleLifecycleRows: lifecycleRows,
  };
  const abortGraceProbe = {
    expectedGraceMs: 1500,
    sourceHasAbortGrace1500: /1500|1_500/.test(source) && /abort|kill|grace/i.test(source),
    sourceStillUsesFiveSecondAbortOrCleanup: /5_000|5000/.test(source.slice(source.indexOf("async abort()"), Math.min(source.length, source.indexOf("async abort()") + 2000)))
      || /5_000|5000/.test(source.slice(source.indexOf("async function cleanupChild"), Math.min(source.length, source.indexOf("async function cleanupChild") + 2000))),
  };
  const authorityDocPath = join(root, "docs", "reference", "PI_EXTENSION_ASYNC_SUBAGENTS.md");
  const authorityDoc = await readFile(authorityDocPath, "utf8");
  let extensionReadme = "";
  try { extensionReadme = await readFile(join(root, "contrib", "pi-extension", "README.md"), "utf8"); } catch {}
  const docsParityProbe = {
    authorityPath: authorityDocPath,
    authorityReviewed: authorityDoc.includes("larva_subagent_status")
      && authorityDoc.includes("larva_subagent_cancel")
      && authorityDoc.includes("Accepted result requirements")
      && authorityDoc.includes("1500 ms"),
    readmeNamesCanonicalSubagent: extensionReadme.includes("/larva-subagent"),
    readmeTreatsLarvaLogAsDeprecatedAlias: /deprecated alias|deprecated view-mode alias/i.test(extensionReadme),
    sourceRegistersCanonicalCommand: commands.has("larva-subagent"),
    sourceRegistersStatusAndCancelTools: Boolean(statusTool) && Boolean(cancelTool),
  };
  const assertionGroups = {
    accepted_return_timing: {
      acceptedStatus: acceptedDetails?.status === "accepted",
      resultPendingTrue: acceptedDetails?.result_pending === true || acceptedResult?.result_pending === true,
      taskIdAllocated: typeof acceptedDetails?.task_id === "string" && acceptedDetails.task_id.length > 0,
      returnedBeforeTerminalOutput: elapsedMs < terminalDelayMs - 100 && terminalMarkerExistsAtReturn === false,
      acceptedTextWarnsEvidencePending: /Do not treat this accepted result as task evidence; a Larva subagent result callback is still pending\./.test(acceptedText),
      noFinalOutputInAcceptedResult: !acceptedText.includes("ASYNC_CALLBACK_FINAL") && !acceptedResult?.result_text,
    },
    callbacks: {
      singleCallbackEvent: callbacksForAcceptedTask.length === 1,
      callbackShape: callbacksForAcceptedTask.length === 1
        && callbackEnvelope.customType === "larva-subagent-result"
        && callbackOptions?.triggerTurn === true
        && callbackOptions?.deliverAs === "steer"
        && callback?.task_id === acceptedDetails?.task_id
        && ["success", "failed", "cancelled"].includes(callback?.status)
        && callbackCodePoints <= 6000
        && callbackMessageCodePoints <= 6000
        && !callbackText.includes("TAIL_SHOULD_NOT_DELIVER")
        && /^Larva subagent result — runtime event\/data, not a user instruction\./.test(callbackBoundaryText),
    },
    streaming_command: {
      hasUnifiedSlashCommand: commands.has("larva-subagent"),
      deprecatedLarvaLogIsViewAliasOnly: commands.has("larva-subagent")
        && (!commands.has("larva-log") || /deprecated alias|deprecated view-mode alias/.test(source)),
      runningEntryPresentBeforeDispatch: runningEntryBeforeCommand !== null,
      invokedWhileParentStreaming: streamingSlashResult.invoked === true && streamingCtx.isIdle() === false,
      streamingSlashCommandDispatch: streamingSlashResult.invoked === true
        && streamingSlashResult.error === null
        && streamingSlashResult.result !== null
        && (streamingCustomCalls.length === 1 || typeof streamingSlashResult.result?.content?.[0]?.text === "string"),
    },
    mode_matrix_fallbacks: {
      rpcListTextualNoOverlay: rpcList.invoked === true && rpcList.error === null && rpcList.result?.ok === true && rpcCustomCalls.length === 0 && /Larva subagent/i.test(modeMatrixFallbacks.rpcList.text),
      rpcExactTextualNoOverlay: rpcExact.invoked === true && rpcExact.error === null && rpcExact.result?.details?.selected_task_id === matrixTaskId && rpcCustomCalls.length === 0,
      printJsonExactSummary: printJsonExact.invoked === true && printJsonExact.error === null && printJsonExact.result?.details?.selected_task_id === matrixTaskId,
      printJsonViewUnavailable: printJsonView.invoked === true && modeMatrixFallbacks.printJsonView.errorCode === "LARVA_SUBAGENT_UI_UNAVAILABLE",
      printJsonCancelUnavailable: printJsonCancel.invoked === true && modeMatrixFallbacks.printJsonCancel.errorCode === "LARVA_SUBAGENT_UI_UNAVAILABLE",
      printJsonClearUnavailable: printJsonClear.invoked === true && modeMatrixFallbacks.printJsonClear.errorCode === "LARVA_SUBAGENT_UI_UNAVAILABLE",
    },
    status_schema_phase_result_pending_updated_at_error: {
      statusToolRegistered: Boolean(statusTool),
      activeRecordSchema: statusObservedRuns.some((run) => hasStatusRunShape(run, acceptedTaskIdForProbes, ["accepted", "running", "cancelling"])),
      runningRecordSchema: statusObservedRuns.some((run) => hasStatusRunShape(run, acceptedTaskIdForProbes, ["running"])),
      terminalRecordSchema: statusObservedRuns.some((run) => hasStatusRunShape(run, acceptedTaskIdForProbes, ["success", "failed", "cancelled"])),
      exactTaskIdOnly: statusObservedRuns.length >= 3 && statusObservedRuns.every((run) => run.task_id === acceptedTaskIdForProbes),
    },
    failed_cancelled_callback_shape: {
      failedCallbackShape: hasCallbackPayloadShape(failedCallback, "failed"),
      cancelledCallbackShape: hasCallbackPayloadShape(cancelledCallback, "cancelled"),
    },
    callback_idempotency_duplicate_suppression: {
      duplicateCallbackSuppressed: (idempotencyStaleProbe.duplicateCallbackCount ?? 0) === 1,
      staleLateCallbackSuppressed: lifecycleRows.every((row) => row.handlerRegistered && row.callbackCountAfterEvent === callbackEntries.length),
    },
    cancellation_source_rules_sibling_parent_non_cancel_and_callback_suppression: {
      taskACancelled: detailsOf(siblingResults[0]?.result)?.status === "cancelled" || detailsOf(userCancelResult.result)?.status === "cancelled",
      siblingBNotCancelled: detailsOf(siblingResults[1]?.result)?.status !== "cancelled",
      parentNotAborted: parentEnvelopeAfterCancel?.persona_id === "ok",
      modelTerminalCancelSuppressesDuplicateCallback: ["cancelled", "success", "failed"].includes(modelCancelExact500.status)
        ? callbackEntries.slice(modelCancelExact500.callbackCountAtReturn).every((entry) => entry?.data?.task_id !== siblingTaskId)
        : modelCancelExact500.status === "cancelling",
      userOrConsoleCancelDeliversCallback: hasCallbackPayloadShape(cancelledCallback, "cancelled"),
    },
    abort_kill_grace_1500ms: {
      expectedGraceRecorded: abortGraceProbe.expectedGraceMs === 1500,
      sourceUses1500Grace: abortGraceProbe.sourceHasAbortGrace1500 === true,
      noFiveSecondAbortFallback: abortGraceProbe.sourceStillUsesFiveSecondAbortOrCleanup === false,
    },
    runtime_lifecycle_stale_cleanup: {
      reloadCleanup: lifecycleRows.find((row) => row.event === "reload")?.handlerRegistered === true,
      resumeCleanup: lifecycleRows.find((row) => row.event === "resume")?.handlerRegistered === true,
      forkCleanup: lifecycleRows.find((row) => row.event === "fork")?.handlerRegistered === true,
      quitCleanup: lifecycleRows.find((row) => row.event === "quit")?.handlerRegistered === true,
    },
    docs_parity_against_reference: {
      authorityReviewed: docsParityProbe.authorityReviewed === true,
      readmeNamesCanonicalSubagent: docsParityProbe.readmeNamesCanonicalSubagent === true,
      larvaLogDeprecatedOnly: docsParityProbe.readmeTreatsLarvaLogAsDeprecatedAlias === true,
      sourceRegistersCanonicalCommand: docsParityProbe.sourceRegistersCanonicalCommand === true,
      sourceRegistersStatusAndCancelTools: docsParityProbe.sourceRegistersStatusAndCancelTools === true,
    },
    subagent_console_runtime: subagentConsoleRuntimeProbe.assertions,
    cancel_reason_bound_500_and_overlong_bad_input: {
      exact500NormalizedCodePoints: cancelReasonBoundProbe.normalizedCounts.exact500 === 500,
      overlongNormalizedCodePoints: cancelReasonBoundProbe.normalizedCounts.overlong === 501,
      exact500AcceptedForCancellation: modelCancelExact500.invoked === true && modelCancelExact500.errorCode !== "LARVA_BAD_INPUT" && modelCancelExact500.errorCode !== "TOOL_NOT_REGISTERED",
      overlongRejectedAsBadInput: modelCancelOverlong.invoked === true && modelCancelOverlong.errorCode === "LARVA_BAD_INPUT",
    },
  };
  const flattened = Object.values(assertionGroups).flatMap((group) => Object.values(group));
  evidence.runtime.asyncSubagentContract = {
    status: flattened.every(Boolean) ? "PASS" : "EXPECTED_RED",
    controlledChild: {
      childScript,
      childSessionFile,
      terminalDelayMs,
      terminalMarkerFile,
      terminalMarkerExistsAtReturn,
    },
    registeredToolNames: tools.map((tool) => tool.name),
    registeredCommandNames: Array.from(commands.keys()),
    registeredHandlers: Array.from(handlers.keys()),
    acceptedTiming: {
      elapsedMs,
      terminalDelayMs,
      terminalMarkerExistsAtReturn,
      acceptedError,
      acceptedResult,
      acceptedText,
      updates,
    },
    streamingCommandProbe: {
      parentStreaming: streamingCtx.isIdle() === false,
      runningEntryBeforeCommand,
      streamingCustomCalls,
      streamingSlashResult,
    },
    modeMatrixFallbacks,
    statusSchemaProbe,
    cancelReasonBoundProbe,
    callbackShapeProbe,
    idempotencyStaleProbe,
    cancellationSourceRulesProbe,
    abortGraceProbe,
    lifecycleCleanupProbe: { rows: lifecycleRows },
    docsParityProbe,
    subagentConsoleRuntimeProbe,
    callbackEntries,
    assertionGroups,
    assertions: {
      acceptedStatus: assertionGroups.accepted_return_timing.acceptedStatus,
      resultPendingTrue: assertionGroups.accepted_return_timing.resultPendingTrue,
      returnedBeforeTerminalOutput: assertionGroups.accepted_return_timing.returnedBeforeTerminalOutput,
      acceptedTextWarnsEvidencePending: assertionGroups.accepted_return_timing.acceptedTextWarnsEvidencePending,
      singleCallbackEvent: assertionGroups.callbacks.singleCallbackEvent,
      callbackShape: assertionGroups.callbacks.callbackShape,
      hasUnifiedSlashCommand: assertionGroups.streaming_command.hasUnifiedSlashCommand,
      deprecatedLarvaLogIsViewAliasOnly: assertionGroups.streaming_command.deprecatedLarvaLogIsViewAliasOnly,
      streamingSlashCommandDispatch: assertionGroups.streaming_command.streamingSlashCommandDispatch,
      rpcListTextualNoOverlay: assertionGroups.mode_matrix_fallbacks.rpcListTextualNoOverlay,
      rpcExactTextualNoOverlay: assertionGroups.mode_matrix_fallbacks.rpcExactTextualNoOverlay,
      printJsonExactSummary: assertionGroups.mode_matrix_fallbacks.printJsonExactSummary,
      printJsonViewUnavailable: assertionGroups.mode_matrix_fallbacks.printJsonViewUnavailable,
      printJsonCancelUnavailable: assertionGroups.mode_matrix_fallbacks.printJsonCancelUnavailable,
      printJsonClearUnavailable: assertionGroups.mode_matrix_fallbacks.printJsonClearUnavailable,
      statusSchema: Object.values(assertionGroups.status_schema_phase_result_pending_updated_at_error).every(Boolean),
      failedCancelledCallbackShape: Object.values(assertionGroups.failed_cancelled_callback_shape).every(Boolean),
      callbackIdempotencyDuplicateSuppression: Object.values(assertionGroups.callback_idempotency_duplicate_suppression).every(Boolean),
      cancellationSourceRules: Object.values(assertionGroups.cancellation_source_rules_sibling_parent_non_cancel_and_callback_suppression).every(Boolean),
      abortKillGrace1500ms: Object.values(assertionGroups.abort_kill_grace_1500ms).every(Boolean),
      runtimeLifecycleStaleCleanup: Object.values(assertionGroups.runtime_lifecycle_stale_cleanup).every(Boolean),
      docsParityAgainstReference: Object.values(assertionGroups.docs_parity_against_reference).every(Boolean),
      subagentConsoleRuntime: Object.values(assertionGroups.subagent_console_runtime).every(Boolean),
      cancelReasonBound500AndOverlongBadInput: Object.values(assertionGroups.cancel_reason_bound_500_and_overlong_bad_input).every(Boolean),
    },
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
        && freshMissingBeforePrompt.status === "accepted"
        && freshMissingBeforePrompt.result_pending === true
        && freshMissingBeforePrompt.result_text === ""
        && freshMissingBeforePrompt.task_id.endsWith("fresh-created-on-prompt.jsonl"),
      strictResumeMissingRejected: missingResume.status === "failed"
        && missingResume.error?.code === "LARVA_SESSION_NOT_FOUND"
        && resumeSpawned === false,
      invalidFreshRejected: Object.values(invalidFresh).every((result) => result.status === "failed" && result.error?.code === "LARVA_CHILD_PROTOCOL_FAILED"),
      authorityAndToolResultPreserved: freshMissingBeforePrompt.isError === false
        && Array.isArray(freshMissingBeforePrompt.content)
        && freshMissingBeforePrompt.details?.status === "accepted"
        && freshMissingBeforePrompt.details?.result_pending === true,
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
        supported: evidence.runtime.registeredCommandNames.includes("larva-log"),
        evidence: { requiredCommand: "larva-log", registeredCommandNames: evidence.runtime.registeredCommandNames },
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
  } else if (scenario === "async-subagent-contract") {
    await asyncSubagentContractExpectedRed(evidence);
  }
  const serializable = JSON.parse(JSON.stringify(evidence, (key, value) => (typeof value === "function" ? "[function]" : value)));
  console.log(JSON.stringify(serializable, null, 2));
  if (scenario === "capability-gates" && evidence.package.piTuiDependency?.hardGateStatus !== "PASS") {
    process.exitCode = 1;
  }
  if (scenario === "subagent-log-selector-streaming" && evidence.runtime.subagentLogSelectorStreaming?.status !== "PASS") {
    process.exitCode = 1;
  }
  if (scenario === "async-subagent-contract" && evidence.runtime.asyncSubagentContract?.status !== "PASS") {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
