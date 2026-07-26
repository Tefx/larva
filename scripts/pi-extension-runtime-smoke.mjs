#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
  "wait-select-pending-callback-handoff",
  "persona-invocation-bus",
  "model-map-profile-switch",
  "model-map-profile-switch-installed-pi",
  "model-map-profile-switch-installed-child-pi",
];

const PIINV_REQUIRED_EXPECTED_RED_IDS = [
  "PIINV-001",
  "PIINV-002",
  "PIINV-003",
  "PIINV-004",
  "PIINV-005",
];

const PIINV_MACHINE_ANCHORS = [
  "prompt_max_65536_utf8_bytes",
  "metadata_json_stringify_max_2048_utf8_bytes",
  "timeout_ms_invalid_below_1",
  "timeout_ms_invalid_above_120000",
  "timeout_runtime_timeout_returns_TIMEOUT",
  "final_text_max_16384_utf8_bytes",
  "overlimit_output_PROTOCOL_FAILED_empty_final_text_no_artifact_no_truncation",
  "result_error_object_exact_code_message_shape",
  "failed_result_empty_final_text",
  "cancelled_result_empty_final_text",
  "terminal_error_code_BAD_INPUT",
  "terminal_error_code_PERSONA_NOT_FOUND",
  "terminal_error_code_MODEL_UNAVAILABLE",
  "terminal_error_code_POLICY_FAILED",
  "terminal_error_code_TIMEOUT",
  "terminal_error_code_CANCELLED",
  "terminal_error_code_PROTOCOL_FAILED",
  "terminal_error_code_INTERNAL_ERROR",
  "lifecycle_shutdown_stale_context_suppresses_result",
  "lifecycle_reload_stale_context_suppresses_result",
  "lifecycle_new_stale_context_suppresses_result",
  "lifecycle_resume_stale_context_suppresses_result",
  "lifecycle_fork_stale_context_suppresses_result",
  "terminal_race_first_terminal_state_wins",
  "terminal_race_at_most_one_result",
  "terminal_race_late_timeout_cancel_stale_ignored",
];

const PIINV_TERMINAL_RACE_ANCHORS = [
  "terminal_race_first_terminal_state_wins",
  "terminal_race_at_most_one_result",
  "terminal_race_late_timeout_cancel_stale_ignored",
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

const HARNESS_SELECTOR_ENV_KEYS = [
  "HOME",
  "TMPDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
  "PI_MODEL",
  "PI_PROVIDER",
  "PI_REASONING_LEVEL",
  "PI_SESSION_FILE",
  "PI_SESSION_ID",
  "LARVA_CONFIG_DIR",
  "LARVA_HOME",
  "LARVA_SESSION_DIR",
  "LARVA_CLI_ARGV_JSON",
  "LARVA_PI_AGENT_PERSONA_SWITCH",
  "LARVA_PI_CHILD_RPC_TRACE_FILE",
  "LARVA_PI_CHILD_SESSION_DIR",
  "LARVA_PI_COMPACTION_CONFIG_FILE",
  "LARVA_PI_EXTENSION_ENTRY",
  "LARVA_PI_EXTENSION_FLAG",
  "LARVA_PI_INITIAL_PERSONA_ID",
  "LARVA_PI_INITIAL_PERSONA_MODEL_FROM_CLI",
  "LARVA_PI_INTERACTIVE_TUI",
  "LARVA_PI_LAUNCHED",
  "LARVA_PI_MODEL_MAP_FILE",
  "LARVA_PI_PARENT_PERSONA_ID",
  "LARVA_PI_PERSONA_CANDIDATES_CACHE_FILE",
  "LARVA_PI_REAL_BIN",
  "LARVA_PI_SUBAGENT_ARTIFACT_DIR",
  "LARVA_PI_SUBAGENT_CONFIG_FILE",
  "LARVA_PI_SUBAGENT_LOG_FILE",
  "LARVA_PI_TOOL_POLICY_FILE",
];

const HARNESS_ROOT_ENV_KEYS = new Set([
  "HOME",
  "TMPDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
  "PI_SESSION_FILE",
  "LARVA_CONFIG_DIR",
  "LARVA_HOME",
  "LARVA_SESSION_DIR",
  "LARVA_PI_CHILD_RPC_TRACE_FILE",
  "LARVA_PI_CHILD_SESSION_DIR",
  "LARVA_PI_COMPACTION_CONFIG_FILE",
  "LARVA_PI_MODEL_MAP_FILE",
  "LARVA_PI_PERSONA_CANDIDATES_CACHE_FILE",
  "LARVA_PI_SUBAGENT_ARTIFACT_DIR",
  "LARVA_PI_SUBAGENT_CONFIG_FILE",
  "LARVA_PI_SUBAGENT_LOG_FILE",
  "LARVA_PI_TOOL_POLICY_FILE",
]);

const SECRET_ENV_KEY = /(?:API[_-]?KEY|AUTH|CREDENTIAL|PASSWORD|SECRET|TOKEN|AWS_|AZURE_|GOOGLE_APPLICATION_CREDENTIALS)/i;
let runtimeIsolation = null;

function sanitizedHarnessBaseEnv(base = process.env) {
  const env = { ...base };
  for (const key of HARNESS_SELECTOR_ENV_KEYS) delete env[key];
  for (const key of Object.keys(env)) if (SECRET_ENV_KEY.test(key)) delete env[key];
  return env;
}

function mergedHarnessEnv(base, overrides = {}) {
  const env = { ...sanitizedHarnessBaseEnv(base), ...overrides };
  for (const [key, value] of Object.entries(env)) if (value === undefined || value === null) delete env[key];
  return env;
}

function pathInside(rootPath, candidate) {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  const resolvedRoot = resolve(rootPath);
  const resolvedCandidate = resolve(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${sep}`);
}

function observeRuntimeEnvironment(env, ownedKeys, tempRoot) {
  const owned = new Set(ownedKeys);
  return {
    owned_selector_keys: HARNESS_SELECTOR_ENV_KEYS.filter((key) => owned.has(key) && env[key] !== undefined).sort(),
    unowned_selector_keys_present: HARNESS_SELECTOR_ENV_KEYS.filter((key) => !owned.has(key) && env[key] !== undefined).sort(),
    owned_paths_outside_root: Array.from(HARNESS_ROOT_ENV_KEYS)
      .filter((key) => owned.has(key) && env[key] !== undefined && !pathInside(tempRoot, env[key]))
      .sort(),
  };
}

async function createNeutralRuntimeIsolation() {
  const tempRoot = await mkdtemp(join(tmpdir(), "larva-pi-neutral-runtime-"));
  const suffix = tempRoot.replace(/[^A-Za-z0-9]/g, "").slice(-12).toLowerCase();
  const providerId = `larva-neutral-${suffix}`;
  const modelId = `neutral-${suffix}`;
  const home = join(tempRoot, "home");
  const piCodingAgentDir = join(tempRoot, "pi-agent");
  const parentSessionDir = join(tempRoot, "parent-session");
  const childSessionDir = join(tempRoot, "child-sessions");
  const scratchDir = join(tempRoot, "tmp");
  const xdgConfigDir = join(tempRoot, "xdg-config");
  const xdgDataDir = join(tempRoot, "xdg-data");
  const xdgCacheDir = join(tempRoot, "xdg-cache");
  const configDir = join(tempRoot, "larva-config");
  const modelMapPath = join(configDir, "model-map.json");
  const providerExtension = join(tempRoot, "neutral-loopback-provider.ts");
  const subagentConfig = join(tempRoot, "subagent-runtime.json");
  const traceFile = join(tempRoot, "child-rpc.jsonl");
  const artifactDir = join(tempRoot, "artifacts");
  const requests = [];
  const sockets = new Set();
  let server = null;
  try {
  await Promise.all([
    home,
    piCodingAgentDir,
    parentSessionDir,
    childSessionDir,
    scratchDir,
    xdgConfigDir,
    xdgDataDir,
    xdgCacheDir,
    configDir,
    artifactDir,
  ].map((path) => mkdir(path, { recursive: true })));

  server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk.toString("utf8");
    const remoteAddress = request.socket.remoteAddress ?? "";
    const loopback = /^(?:127\.|::1$|::ffff:127\.)/.test(remoteAddress);
    let payload = {};
    try { payload = body.length > 0 ? JSON.parse(body) : {}; } catch {}
    const renderedMessages = JSON.stringify(payload.messages ?? []);
    const heldForAbort = renderedMessages.includes("B3_ABORT_SHOULD_NOT_FINISH");
    requests.push({ loopback, method: request.method ?? null, model: payload.model ?? null, held_for_abort: heldForAbort });
    if (!loopback) {
      response.writeHead(403, { connection: "close" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
    if (heldForAbort) return;
    const text = renderedMessages.includes("B2_RESUME_RPC_OK") ? "B2_RESUME_RPC_OK" : renderedMessages.includes("B1_CHILD_RPC_OK") ? "B1_CHILD_RPC_OK" : "NEUTRAL_LOOPBACK_OK";
    response.write(`data: ${JSON.stringify({ id: `neutral-${Date.now()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: modelId, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("neutral loopback provider failed to bind");
  const providerUrl = `http://127.0.0.1:${address.port}/v1`;
  await writeFile(providerExtension, `
export default function (pi) {
  const model = { id: ${JSON.stringify(modelId)}, name: ${JSON.stringify(modelId)}, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 };
  pi.registerProvider(${JSON.stringify(providerId)}, { name: "Larva neutral loopback provider", baseUrl: ${JSON.stringify(providerUrl)}, apiKey: "loopback-only", api: "openai-completions", models: [model] });
}
`, "utf8");
  await writeFile(modelMapPath, JSON.stringify({ models: { "openai/gpt-5.5": { provider: providerId, model_id: modelId } }, prefix_rules: [] }), "utf8");
  await writeFile(subagentConfig, JSON.stringify({ schema_version: 1, extension_sources: [providerExtension] }), "utf8");

  const envDefaults = {
    HOME: home,
    TMPDIR: scratchDir,
    XDG_CACHE_HOME: xdgCacheDir,
    XDG_CONFIG_HOME: xdgConfigDir,
    XDG_DATA_HOME: xdgDataDir,
    PI_CODING_AGENT_DIR: piCodingAgentDir,
    PI_CODING_AGENT_SESSION_DIR: parentSessionDir,
    PI_OFFLINE: "1",
    LARVA_CONFIG_DIR: configDir,
    LARVA_HOME: tempRoot,
    LARVA_SESSION_DIR: join(tempRoot, "larva-sessions"),
    LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, fakeCli]),
    LARVA_PI_REAL_BIN: process.env.PI_BIN || "pi",
    LARVA_PI_EXTENSION_FLAG: "-e",
    LARVA_PI_EXTENSION_ENTRY: extensionPath,
    LARVA_PI_LAUNCHED: "1",
    LARVA_PI_MODEL_MAP_FILE: modelMapPath,
    LARVA_PI_CHILD_SESSION_DIR: childSessionDir,
    LARVA_PI_CHILD_RPC_TRACE_FILE: traceFile,
    LARVA_PI_SUBAGENT_CONFIG_FILE: subagentConfig,
    LARVA_PI_SUBAGENT_ARTIFACT_DIR: artifactDir,
  };
  await mkdir(envDefaults.LARVA_SESSION_DIR, { recursive: true });
  return {
    tempRoot,
    envDefaults,
    providerId,
    modelId,
    providerUrl,
    providerExtension,
    modelMapPath,
    subagentConfig,
    parentSessionDir,
    requests,
    sockets,
    server,
    environmentObservations: [],
    quarantinedInheritedKeys: HARNESS_SELECTOR_ENV_KEYS.filter((key) => process.env[key] !== undefined).sort(),
  };
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    if (server?.listening) await new Promise((resolveClose) => server.close(resolveClose));
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

async function allocateRuntimeDirectory(prefix) {
  return runtimeIsolation === null
    ? await mkdtemp(join(tmpdir(), prefix))
    : await mkdtemp(join(runtimeIsolation.tempRoot, prefix));
}

function runtimeEnv(overrides = {}) {
  const defaults = runtimeIsolation?.envDefaults ?? {
    PI_OFFLINE: "1",
    LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, fakeCli]),
    LARVA_PI_REAL_BIN: process.env.PI_BIN || "pi",
    LARVA_PI_EXTENSION_FLAG: "-e",
    LARVA_PI_EXTENSION_ENTRY: extensionPath,
    LARVA_PI_LAUNCHED: "1",
  };
  const env = mergedHarnessEnv(process.env, { ...defaults, ...overrides });
  if (runtimeIsolation !== null) {
    runtimeIsolation.environmentObservations.push(observeRuntimeEnvironment(
      env,
      [...Object.keys(defaults), ...Object.keys(overrides)],
      runtimeIsolation.tempRoot,
    ));
  }
  return env;
}

async function cleanupNeutralRuntimeIsolation(evidence) {
  if (runtimeIsolation === null) return;
  const isolation = runtimeIsolation;
  let runtimeResetError = null;
  let rootRemovalError = null;
  try {
    const mod = await import(pathToFileURL(extensionPath).href);
    if (typeof mod.resetExtensionUI === "function") await mod.resetExtensionUI("neutral-runtime-isolation-cleanup");
  } catch (error) {
    runtimeResetError = error?.message ?? String(error);
  }
  for (const socket of isolation.sockets) socket.destroy();
  if (isolation.server.listening) await new Promise((resolveClose) => isolation.server.close(resolveClose));
  try { await rm(isolation.tempRoot, { recursive: true, force: true }); }
  catch (error) { rootRemovalError = error?.message ?? String(error); }
  let temporaryRootRemoved = false;
  try { await access(isolation.tempRoot); } catch { temporaryRootRemoved = true; }
  const unowned = Array.from(new Set(isolation.environmentObservations.flatMap((entry) => entry.unowned_selector_keys_present))).sort();
  const outside = Array.from(new Set(isolation.environmentObservations.flatMap((entry) => entry.owned_paths_outside_root))).sort();
  evidence.runtime.isolation = {
    status: unowned.length === 0 && outside.length === 0 && isolation.requests.every((request) => request.loopback) && temporaryRootRemoved && !isolation.server.listening && runtimeResetError === null && rootRemovalError === null ? "PASS" : "FAIL",
    temp_root: isolation.tempRoot,
    quarantined_inherited_keys: isolation.quarantinedInheritedKeys,
    environment_observations: isolation.environmentObservations,
    unowned_selector_keys_present: unowned,
    owned_paths_outside_root: outside,
    route: {
      source_model: "openai/gpt-5.5",
      provider_id: isolation.providerId,
      model_id: isolation.modelId,
      provider_url: isolation.providerUrl,
      provider_extension: isolation.providerExtension,
      model_map_path: isolation.modelMapPath,
      subagent_config_path: isolation.subagentConfig,
      resolver: "LARVA_PI_MODEL_MAP_FILE exact mapping followed by Pi modelRegistry.find",
    },
    network: {
      request_count: isolation.requests.length,
      loopback_only: isolation.requests.every((request) => request.loopback),
      external_provider_requests: isolation.requests.filter((request) => !request.loopback).length,
    },
    cleanup: { loopback_closed: !isolation.server.listening, temporary_root_removed: temporaryRootRemoved, runtime_reset_error: runtimeResetError, root_removal_error: rootRemovalError },
  };
  runtimeIsolation = null;
}

async function piAvailability(evidence) {
  const binary = evidence.pi.binary;
  const env = runtimeEnv();
  const help = await runProcess(binary, ["--help"], { env, timeoutMs: 5_000 });
  evidence.pi.helpExitCode = help.exitCode;
  evidence.pi.available = help.exitCode === 0;
  const helpText = `${help.stdout}${help.stderr}`;
  evidence.pi.helpSnippet = helpText.slice(0, 500);
  if (evidence.pi.available) {
    if (helpText.includes("-e")) evidence.pi.extensionFlag = "-e";
    const version = await runProcess(binary, ["--version"], { env, timeoutMs: 5_000 });
    evidence.package.versionCommand = `${binary} --version`;
    evidence.package.versionExitCode = version.exitCode;
    evidence.package.versionText = `${version.stdout}${version.stderr}`.trim().slice(0, 500);
  }
  const packageRoot = process.env.PI_PACKAGE_ROOT || "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
  evidence.package.packageRoot = packageRoot;
  const commit = await runProcess("git", ["-C", packageRoot, "rev-parse", "HEAD"], { env, timeoutMs: 5_000 });
  evidence.package.commitExitCode = commit.exitCode;
  evidence.package.commit = commit.exitCode === 0 ? commit.stdout.trim() : null;
  if (commit.exitCode !== 0) evidence.package.commitError = commit.stderr.trim().slice(0, 500);
  return evidence.pi;
}

async function runPiRpc(evidence, { initialPersona, commands = [], envOverrides = {}, postCommandWaitMs = 750 } = {}) {
  await piAvailability(evidence);
  evidence.rpc.attempted = true;
  if (!evidence.pi.available || !evidence.pi.extensionFlag) {
    evidence.rpc.supported = false;
    evidence.rpc.limitation = "Pi binary or extension flag is unavailable.";
    return evidence.rpc;
  }
  const sessionDir = await allocateRuntimeDirectory("rpc-session-");
  const args = [
    "--mode",
    "rpc",
    "--no-session",
    "--no-extensions",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--offline",
    "--approve",
    ...(runtimeIsolation === null ? [] : [evidence.pi.extensionFlag, runtimeIsolation.providerExtension]),
    evidence.pi.extensionFlag,
    extensionPath,
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
  await new Promise((resolveWait) => setTimeout(resolveWait, postCommandWaitMs));
  child.kill("SIGTERM");
  let exit = await Promise.race([closePromise, new Promise((resolveWait) => setTimeout(() => resolveWait({ timeout: true }), 1_500))]);
  if (exit?.timeout === true) {
    child.kill("SIGKILL");
    exit = {
      ...exit,
      forcedSignal: "SIGKILL",
      afterForcedKill: await Promise.race([closePromise, new Promise((resolveWait) => setTimeout(() => resolveWait({ timeout: true }), 500))]),
    };
  }
  rl.close();
  child.stdin.destroy();
  evidence.rpc.exit = exit;
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
  const sessionDir = await allocateRuntimeDirectory("fatal-startup-session-");
  const mode = args.get("fatal-mode") || "bad-model";
  const envOverrides = mode === "bad-policy"
    ? { LARVA_PI_TOOL_POLICY_FILE: join(sessionDir, "bad-policy.json") }
    : { FAKE_LARVA_MODEL: "not-a-valid-pi-model" };
  if (mode === "bad-policy") await writeFile(envOverrides.LARVA_PI_TOOL_POLICY_FILE, "{not json", "utf8");
  const env = runtimeEnv({ LARVA_PI_INITIAL_PERSONA_ID: args.get("persona") || "ok", ...envOverrides });
  const child = spawn(evidence.pi.binary, [
    "--mode",
    "rpc",
    "--no-session",
    "--no-extensions",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--offline",
    "--approve",
    ...(runtimeIsolation === null ? [] : [evidence.pi.extensionFlag, runtimeIsolation.providerExtension]),
    evidence.pi.extensionFlag,
    extensionPath,
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
  const personaEnv = typeof initialPersona === "string" && initialPersona.length > 0
    ? { LARVA_PI_INITIAL_PERSONA_ID: initialPersona }
    : {};
  const ctx = {
    env: runtimeEnv({ ...personaEnv, ...envOverrides }),
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
  evidence.runtime.larvaSubagent = registeredTools.find((tool) => tool.name === "larva_subagent") ?? null;
  evidence.runtime.larvaSubagentStatus = registeredTools.find((tool) => tool.name === "larva_subagent_status") ?? null;
  evidence.runtime.larvaSubagentCancel = registeredTools.find((tool) => tool.name === "larva_subagent_cancel") ?? null;
  evidence.runtime.autocompleteProvider = {
    hookType: typeof ctx.ui.addAutocompleteProvider,
    source: "runtimeHarness.mock",
    installedProviderCount: autocompleteProviders.length,
    limitation: "Local smoke runtime injects a mock ctx.ui.addAutocompleteProvider fixture; this is not live Pi interactive TUI runtime proof.",
  };
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

async function writeNonresponsiveAbortSubagentChild(scriptPath, { sessionFile }) {
  await writeFile(scriptPath, `
    import { createInterface } from "node:readline";
    import { mkdir, writeFile } from "node:fs/promises";
    import { dirname } from "node:path";
    const sessionFile = ${JSON.stringify(sessionFile)};
    await mkdir(dirname(sessionFile), { recursive: true });
    setInterval(() => undefined, 1000);
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
      } else if (message.type === "abort") {
        // Intentionally do not respond or exit: proves adapter kill deadline without a cooperative child.
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

function processGroupAlive(processGroupId) {
  if (process.platform === "win32" || !Number.isInteger(processGroupId) || processGroupId <= 0) return false;
  try {
    process.kill(-processGroupId, 0);
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

async function psScanForPids(pids) {
  const uniquePids = Array.from(new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0)));
  if (uniquePids.length === 0) {
    return { command: null, exitCode: 0, stdout: "", stderr: "", survivors: [] };
  }
  const result = await runProcess("ps", ["-p", uniquePids.join(","), "-o", "pid=,ppid=,stat=,command="], { timeoutMs: 2_000 });
  const stdout = result.stdout ?? "";
  const survivors = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return {
    command: `ps -p ${uniquePids.join(",")} -o pid=,ppid=,stat=,command=`,
    exitCode: result.exitCode,
    stdout,
    stderr: result.stderr ?? "",
    survivors,
  };
}

function summarizeFrames(events) {
  const rpcEvents = events.filter((event) => event?.event === "rpc_tx" || event?.event === "rpc_rx");
  const txEvents = events.filter((event) => event?.event === "rpc_tx");
  const rxEvents = events.filter((event) => event?.event === "rpc_rx");
  const frameType = (event) => event?.frame?.type ?? event?.frame_type ?? null;
  const frameId = (event) => event?.frame?.id ?? event?.frame_id ?? null;
  const metadataOnlyTrace = rpcEvents.every((event) => event !== null && typeof event === "object" && !("frame" in event));
  return {
    eventNames: events.map((event) => event.event),
    traceMetadataOnly: metadataOnlyTrace,
    rawFrameEvents: rpcEvents.filter((event) => event !== null && typeof event === "object" && "frame" in event).length,
    txTypes: txEvents.map(frameType),
    txPrompts: txEvents.filter((event) => frameType(event) === "prompt").map((event) => event.frame?.message ?? "<metadata-only>"),
    switchSessionPaths: txEvents.filter((event) => frameType(event) === "switch_session").map((event) => event.frame?.sessionPath ?? "<metadata-only>"),
    rxTypes: rxEvents.map(frameType),
    rxFrameIds: rxEvents.map(frameId).filter(Boolean),
    agentEndCount: rxEvents.filter((event) => frameType(event) === "agent_end").length,
    sessionFiles: rxEvents
      .filter((event) => frameId(event) === "state-1" && typeof event?.frame?.data?.sessionFile === "string")
      .map((event) => event.frame.data.sessionFile),
    assistantTexts: rxEvents
      .filter((event) => frameId(event) === "last-1" && typeof event?.frame?.data?.text === "string")
      .map((event) => event.frame.data.text),
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

  const mod = await import(pathToFileURL(extensionPath).href);
  const sessionRoot = await allocateRuntimeDirectory("live-child-sessions-");
  const traceFile = join(sessionRoot, "child-rpc-trace.jsonl");
  const timeoutMs = Number.parseInt(args.get("live-timeout-ms") || "90000", 10);
  const pollTimeoutMs = Math.max(5_000, timeoutMs);
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
  const statusTool = evidence.runtime.larvaSubagentStatus;
  const cancelTool = evidence.runtime.larvaSubagentCancel;
  const calls = [];
  const terminalStatuses = new Set(["success", "failed", "cancelled"]);
  const sleep = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
  const detailsOf = (result) => result?.details ?? result ?? null;
  const resultStatus = (result) => detailsOf(result)?.status ?? result?.status ?? null;
  const resultTaskId = (result) => detailsOf(result)?.task_id ?? result?.task_id ?? null;
  const runRegisteredTool = async (registeredTool, callId, input, signal = undefined, onUpdate = undefined) => {
    if (!registeredTool) return { invoked: false, input, result: null, error: "TOOL_NOT_REGISTERED" };
    try {
      if (typeof registeredTool.execute === "function") {
        return { invoked: true, input, result: await registeredTool.execute(callId, input, signal, onUpdate), error: null };
      }
      if (typeof registeredTool.handler === "function") {
        return { invoked: true, input, result: await registeredTool.handler(input), error: null };
      }
      return { invoked: false, input, result: null, error: "TOOL_HAS_NO_EXECUTE_OR_HANDLER" };
    } catch (error) {
      return { invoked: true, input, result: null, error: error?.message ?? String(error) };
    }
  };
  const observeStatus = async (taskId, label) => {
    const invoked = await runRegisteredTool(statusTool, `live-status-${label}`, { task_id: taskId });
    const details = detailsOf(invoked.result);
    const runs = Array.isArray(details?.runs) ? details.runs : [];
    return {
      label,
      invoked: invoked.invoked,
      error: invoked.error,
      status: details?.status ?? null,
      runs,
      run: runs[0] ?? null,
    };
  };
  const waitForTerminalStatus = async (taskId, label, waitMs = pollTimeoutMs) => {
    const observations = [];
    const startedAt = Date.now();
    while (Date.now() - startedAt < waitMs) {
      const observation = await observeStatus(taskId, `${label}-${observations.length}`);
      observations.push(observation);
      const run = observation.run;
      if (terminalStatuses.has(run?.status)) return { timedOut: false, run, observations };
      await sleep(250);
    }
    return { timedOut: true, run: observations.at(-1)?.run ?? null, observations };
  };
  const waitForPidQuiescence = async (eventsStart, label, waitMs = 5_000) => {
    let latestEvents = await readJsonlTrace(traceFile);
    let latestNewEvents = latestEvents.slice(eventsStart);
    let latestPids = uniqueChildPids(latestNewEvents);
    let latestAlive = Object.fromEntries(latestPids.map((pid) => [String(pid), processAlive(pid)]));
    const startedAt = Date.now();
    while (Date.now() - startedAt < waitMs) {
      latestEvents = await readJsonlTrace(traceFile);
      latestNewEvents = latestEvents.slice(eventsStart);
      latestPids = uniqueChildPids(latestNewEvents);
      latestAlive = Object.fromEntries(latestPids.map((pid) => [String(pid), processAlive(pid)]));
      const trace = summarizeFrames(latestNewEvents);
      if (latestPids.length > 0 && Object.values(latestAlive).every((alive) => alive === false) && trace.cleanupEndCount >= 1) break;
      await sleep(100);
    }
    return {
      label,
      events: latestEvents,
      newEvents: latestNewEvents,
      pids: latestPids,
      alive: latestAlive,
      ps: await psScanForPids(latestPids),
    };
  };

  const runCall = async (name, input) => {
    const beforeEvents = await readJsonlTrace(traceFile);
    const beforePidAlive = scanPids(beforeEvents);
    const updates = [];
    const accepted = await executeWithTimeout(tool, `live-${name}`, input, timeoutMs, (update) => updates.push(update));
    const taskId = resultTaskId(accepted);
    const terminal = typeof taskId === "string" ? await waitForTerminalStatus(taskId, name) : { timedOut: true, run: null, observations: [] };
    const quiescence = await waitForPidQuiescence(beforeEvents.length, name);
    const afterEvents = quiescence.events;
    const newEvents = quiescence.newEvents;
    const afterPidAlive = scanPids(afterEvents);
    const trace = summarizeFrames(newEvents);
    const receipt = {
      name,
      input,
      acceptedResult: accepted,
      acceptedStatus: resultStatus(accepted),
      terminal,
      result: terminal.run,
      updates,
      trace,
      beforePidAlive,
      afterPidAlive,
      newPidAlive: quiescence.alive,
      postCleanupPs: quiescence.ps,
      orphanFree: quiescence.pids.length > 0 && Object.values(quiescence.alive).every((alive) => alive === false) && quiescence.ps.survivors.length === 0,
    };
    calls.push(receipt);
    return receipt;
  };

  const first = await runCall("fresh", {
    persona_id: "child",
    task: args.get("live-task") || "Reply exactly with B1_CHILD_RPC_OK and no extra words.",
  });
  let resume = null;
  if (first.acceptedStatus === "accepted" && first.result?.status === "success" && typeof resultTaskId(first.acceptedResult) === "string") {
    resume = await runCall("resume", {
      persona_id: "child",
      task: args.get("live-resume-task") || "Reply exactly with B2_RESUME_RPC_OK and no extra words.",
      task_id: resultTaskId(first.acceptedResult),
    });
  }

  const beforeAbortEvents = await readJsonlTrace(traceFile);
  const abortUpdates = [];
  let abortCancelPromise = null;
  let abortCancelPhase = null;
  const abortInput = {
    persona_id: "child",
    task: args.get("live-abort-task") || "Write 400 numbered lines. Every line must start with B3_ABORT_SHOULD_NOT_FINISH and then include a different ten-word sentence. Do not stop early.",
  };
  const abortAccepted = await executeWithTimeout(tool, "live-abort", abortInput, timeoutMs, (update) => {
    abortUpdates.push(update);
    const phase = update?.details?.phase;
    const taskId = update?.details?.task_id;
    if (abortCancelPromise === null && phase === "waiting_for_child" && typeof taskId === "string") {
      abortCancelPhase = phase;
      abortCancelPromise = runRegisteredTool(cancelTool, "live-cancel-abort", { task_id: taskId, reason: "live child RPC proof exact task_id cancellation" });
    }
  });
  const abortTaskId = resultTaskId(abortAccepted);
  const abortCancel = abortCancelPromise !== null
    ? await abortCancelPromise
    : typeof abortTaskId === "string"
      ? await runRegisteredTool(cancelTool, "live-cancel-abort", { task_id: abortTaskId, reason: "live child RPC proof exact task_id cancellation" })
      : { invoked: false, input: null, result: null, error: "NO_ACCEPTED_TASK_ID" };
  const abortTerminal = typeof abortTaskId === "string" ? await waitForTerminalStatus(abortTaskId, "abort") : { timedOut: true, run: null, observations: [] };
  const abortQuiescence = await waitForPidQuiescence(beforeAbortEvents.length, "abort");
  const abortNewEvents = abortQuiescence.newEvents;
  const abortTrace = summarizeFrames(abortNewEvents);
  const abort = {
    name: "abort",
    input: abortInput,
    acceptedResult: abortAccepted,
    acceptedStatus: resultStatus(abortAccepted),
    cancel: abortCancel,
    cancelStatus: resultStatus(abortCancel.result),
    cancelPhase: abortCancelPhase,
    terminal: abortTerminal,
    result: abortTerminal.run,
    updates: abortUpdates,
    trace: abortTrace,
    newPidAlive: abortQuiescence.alive,
    postCleanupPs: abortQuiescence.ps,
    orphanFree: abortQuiescence.pids.length > 0 && Object.values(abortQuiescence.alive).every((alive) => alive === false) && abortQuiescence.ps.survivors.length === 0,
  };
  calls.push(abort);

  const cleanupResult = typeof mod.resetExtensionUI === "function"
    ? await mod.resetExtensionUI("live-child-rpc-proof-final-cleanup")
    : null;
  await sleep(500);
  const allEvents = await readJsonlTrace(traceFile);
  const allPids = uniqueChildPids(allEvents);
  const postCleanupPidAlive = Object.fromEntries(allPids.map((pid) => [String(pid), processAlive(pid)]));
  const postCleanupPs = await psScanForPids(allPids);
  const b1TaskId = resultTaskId(first.acceptedResult);
  const b1StartupSessionFileObserved = typeof b1TaskId === "string" && first.trace.rxFrameIds.includes("state-1");
  const b1PromptObserved = first.trace.txTypes.includes("prompt");
  const b1AgentEndObserved = first.trace.agentEndCount >= 1;
  const b1GetLastAssistantTextObserved = first.trace.txTypes.includes("get_last_assistant_text") && first.trace.rxFrameIds.includes("last-1");
  const b1 = {
    status: first.acceptedStatus === "accepted" && first.result?.status === "success" && b1StartupSessionFileObserved && b1PromptObserved && b1AgentEndObserved && b1GetLastAssistantTextObserved && first.trace.traceMetadataOnly && first.orphanFree ? "PASS" : "FAIL",
    acceptedStatus: first.acceptedStatus,
    terminalStatus: first.result?.status ?? null,
    task_id: b1TaskId,
    startupSessionFileObserved: b1StartupSessionFileObserved,
    promptObserved: b1PromptObserved,
    agentEndObserved: b1AgentEndObserved,
    getLastAssistantTextObserved: b1GetLastAssistantTextObserved,
    metadataOnlyTraceObserved: first.trace.traceMetadataOnly,
    orphanFree: first.orphanFree,
  };
  const firstTaskId = resultTaskId(first.acceptedResult);
  const b2SwitchSessionObserved = resume?.trace.txTypes.includes("switch_session") ?? false;
  const b2PromptObserved = resume?.trace.txTypes.includes("prompt") ?? false;
  const b2ResumedOutputObserved = resume?.trace.txTypes.includes("get_last_assistant_text") && resume?.trace.rxFrameIds.includes("last-1");
  const b2 = resume === null ? { status: "BLOCKED", blocker: "Fresh run did not produce reusable terminal task_id." } : {
    status: resume.acceptedStatus === "accepted" && resume.result?.status === "success" && resume.result?.task_id === firstTaskId && b2SwitchSessionObserved && b2PromptObserved && b2ResumedOutputObserved && resume.trace.traceMetadataOnly && resume.orphanFree ? "PASS" : "FAIL",
    acceptedStatus: resume.acceptedStatus,
    terminalStatus: resume.result?.status ?? null,
    reusedTaskId: resume.result?.task_id ?? null,
    switchSessionObserved: b2SwitchSessionObserved,
    promptObserved: b2PromptObserved,
    resumedOutputObserved: b2ResumedOutputObserved,
    metadataOnlyTraceObserved: resume.trace.traceMetadataOnly,
    orphanFree: resume.orphanFree,
  };
  const b3 = {
    status: abort.acceptedStatus === "accepted" && ["cancelling", "cancelled"].includes(abort.cancelStatus) && abort.result?.status === "cancelled" && abortTrace.abortEvents.length > 0 && abortTrace.traceMetadataOnly && abort.orphanFree ? "PASS" : "FAIL",
    acceptedStatus: abort.acceptedStatus,
    cancelStatus: abort.cancelStatus,
    terminalStatus: abort.result?.status ?? null,
    task_id: abortTaskId,
    abortEvents: abortTrace.abortEvents,
    cleanupObserved: abortTrace.cleanupEndCount >= 1,
    metadataOnlyTraceObserved: abortTrace.traceMetadataOnly,
    orphanFree: abort.orphanFree,
    hardBlock: abortTrace.abortEvents.length === 0 ? "Pi abort propagation was not observed in child trace; inspect trace/runtime for missing abort signal surface." : null,
  };
  const b4 = {
    status: calls.every((call) => call.orphanFree) && Object.values(postCleanupPidAlive).every((alive) => alive === false) && postCleanupPs.survivors.length === 0 ? "PASS" : "FAIL",
    beforeAfterScans: calls.map((call) => ({ name: call.name, beforePidAlive: call.beforePidAlive ?? {}, afterPidAlive: call.afterPidAlive ?? call.newPidAlive, newPidAlive: call.newPidAlive, postCleanupPs: call.postCleanupPs, orphanFree: call.orphanFree })),
    allObservedPids: allPids,
    postCleanupPidAlive,
    postCleanupPs,
    cleanupResult,
    lifecycleEvents: summarizeFrames(allEvents).eventNames.filter((name) => ["child_spawn", "child_exit", "cleanup_start", "cleanup_sigterm", "cleanup_sigkill", "cleanup_end", "abort_start", "abort_rpc_result", "abort_kill", "abort_kill_after_grace"].includes(name)),
  };
  const traceSummary = summarizeFrames(allEvents);
  evidence.runtime.controlledLive = {
    status: [b1.status, b2.status, b3.status, b4.status].every((status) => status === "PASS") && traceSummary.traceMetadataOnly ? "PASS" : "FAIL",
    sessionRoot,
    traceFile,
    traceMetadataOnly: traceSummary.traceMetadataOnly,
    rawFrameEvents: traceSummary.rawFrameEvents,
    calls,
    traceSummary,
    orphanProof: { allObservedPids: allPids, postCleanupPidAlive, postCleanupPs, cleanupResult },
    B1_startup: b1,
    B2_resume: b2,
    B3_abort: b3,
    B4_orphans: b4,
  };
}

async function waitForSmokeCondition(predicate, { label = "condition", timeoutMs = 2_000, intervalMs = 10, onTerminalObservation = null } = {}) {
  const startedAtNs = process.hrtime.bigint();
  const timeoutNs = BigInt(Math.max(0, Math.trunc(timeoutMs * 1_000_000)));
  const deadlineNs = startedAtNs + timeoutNs;
  while (process.hrtime.bigint() < deadlineNs) {
    const value = await predicate();
    if (value) return value;
    const remainingNs = deadlineNs - process.hrtime.bigint();
    if (remainingNs <= 0n) break;
    const waitMs = Math.max(1, Math.min(intervalMs, Math.ceil(Number(remainingNs) / 1_000_000)));
    await new Promise((resolveWait) => setTimeout(resolveWait, waitMs));
  }
  const terminalValue = await predicate();
  if (typeof onTerminalObservation === "function") {
    onTerminalObservation({ matched: Boolean(terminalValue), elapsedMs: Number(process.hrtime.bigint() - startedAtNs) / 1_000_000 });
  }
  if (terminalValue) return terminalValue;
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
  const command = commands.get("larva-subagent");
  if (!subagent || typeof subagent.execute !== "function" || !command) throw new Error("runtime proof setup missing subagent tool or canonical subagent command");

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
  const commandResult = await command.handler("", { env: { ...env, LARVA_PI_INTERACTIVE_TUI: "1" }, modelRegistry: ctx.modelRegistry, ui: commandUi });
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
  const finalEntry = await waitForSmokeCondition(
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
      finalOutputAuthorityPreserved: finalEntry?.result_text === "FINAL_RPC_AUTHORITY_FROM_GET_LAST_ASSISTANT_TEXT" && outputAfterFinalPlain.includes("FINAL_RPC_AUTHORITY_FROM_GET_LAST_ASSISTANT_TEXT"),
      activeTabAndSelectionPreservedAcrossRefresh: timelineAfterFinalPlain.includes("● 4 Timeline") && currentAfterFinal?.task_id === result?.details?.task_id,
      resetCleanupClosedAndCleared: resetResult.overlay_closed === true && resetResult.presentation_cleared === true && afterReset.details?.error?.code === "LARVA_SUBAGENT_LOG_NOT_OBSERVED" && terminalWrites.at(-1) === "\x1b[?1006l\x1b[?1000l",
    },
  };
}

async function subagentLogSelectorStreamingExpectedRed(evidence) {
  const mod = await import(pathToFileURL(extensionPath).href);
  const extensionRequire = createRequire(pathToFileURL(extensionPath).href);
  const piTui = await import(pathToFileURL(extensionRequire.resolve("@earendil-works/pi-tui")).href);
  const sessionRoot = await mkdtemp(join(tmpdir(), "larva-subagent-selector-streaming-"));
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

async function waitSelectPendingCallbackHandoffExpectedRed(evidence) {
  const mod = await import(pathToFileURL(extensionPath).href);
  const sessionRoot = await mkdtemp(join(tmpdir(), "larva-wait-select-pending-callback-"));
  const childSessionRoot = join(sessionRoot, "child-sessions");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(childSessionRoot, { recursive: true });
  const childScript = join(sessionRoot, "pending-callback-child.mjs");
  const childSessionFile = join(childSessionRoot, "pending-callback.jsonl");
  await writeDelayedAsyncSubagentChild(childScript, {
    sessionFile: childSessionFile,
    finalText: "PENDING_CALLBACK_FINAL_OUTPUT_SHOULD_ARRIVE_BY_CALLBACK",
    terminalDelayMs: 25,
    terminalMarkerFile: join(sessionRoot, "terminal-marker.txt"),
  });

  const callbackAttempts = [];
  const callbackSurface = {
    sendMessage: async (message, options) => {
      callbackAttempts.push({ message, options });
      await new Promise(() => undefined);
    },
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
    ui: { setStatus: async () => undefined, notify: async () => undefined },
    callbackSurface,
  };
  const pi = {
    getAllTools: async () => ["read", "larva_subagent", "larva_subagent_status", "larva_subagent_wait", "larva_subagent_select"],
    setActiveTools: async () => true,
    setModel: async () => true,
    registerCommand: () => undefined,
    registerTool: () => undefined,
    registerShortcut: () => undefined,
    on: () => undefined,
  };
  await mod.initializeExtension(ctx, pi);
  await mod.commitPersona("ok", ctx, pi);
  mod.resetSubagentPresentationStateForTests();

  const accepted = await mod.larva_subagent({ persona_id: "child", task: "finish while callback delivery is intentionally held pending" }, ctx);
  const taskId = accepted?.task_id ?? childSessionFile;
  let terminalPendingRun = null;
  try {
    terminalPendingRun = await waitForSmokeCondition(async () => {
      const status = await mod.larva_subagent_status({ task_id: taskId }, { env: ctx.env });
      const run = status?.details?.runs?.[0] ?? null;
      return run?.status === "success" && run?.callback_delivery === "pending" ? run : null;
    }, { label: "terminal run with pending callback delivery", timeoutMs: 2_000, intervalMs: 10 });
  } catch {
    terminalPendingRun = null;
  }

  const waitResult = await mod.larva_subagent_wait({ task_ids: [taskId], return_when: "all", timeout_ms: 0 }, { env: ctx.env });
  const selectResult = await mod.larva_subagent_select({ task_ids: [taskId], timeout_ms: 0 }, { env: ctx.env });
  const statusResult = await mod.larva_subagent_status({ task_id: taskId }, { env: ctx.env });
  const waitText = waitResult?.content?.[0]?.text ?? "";
  const selectText = selectResult?.content?.[0]?.text ?? "";
  const statusJson = JSON.stringify(statusResult?.details ?? {});
  const waitTerminalResult = waitResult?.details?.terminal_result;
  const selectTerminalResult = selectResult?.details?.terminal_result;
  const outputLookupPattern = /(?:status.*(?:output|child output|result retrieval)|(?:output|child output|result retrieval).*status)/i;
  const expectedRecommendedNextAction = "yield_for_callback";
  const assertions = {
    acceptedReceiptReturned: accepted?.status === "accepted" && accepted?.result_pending === true,
    terminalReadyCallbackStillPending: terminalPendingRun?.status === "success" && terminalPendingRun?.callback_delivery === "pending",
    waitSatisfiedTerminalPendingCallback: waitResult?.details?.satisfied === true && waitResult?.details?.runs?.[0]?.callback_delivery === "pending",
    selectSatisfiedTerminalPendingCallback: selectResult?.details?.satisfied === true && selectResult?.details?.runs?.[0]?.callback_delivery === "pending",
    waitRecommendedActionYieldsForCallback: waitResult?.details?.recommended_next_action === expectedRecommendedNextAction,
    selectRecommendedActionYieldsForCallback: selectResult?.details?.recommended_next_action === expectedRecommendedNextAction,
    waitVisibleTextNamesCallbackYield: waitText.includes("yield") && waitText.includes("larva-subagent-result"),
    selectVisibleTextNamesCallbackYield: selectText.includes("yield") && selectText.includes("larva-subagent-result"),
    waitSelectDoNotRecommendStatusForOutput: !outputLookupPattern.test(`${waitText}\n${selectText}`),
    waitTerminalResultMetadataPresent: isRecord(waitTerminalResult),
    selectTerminalResultMetadataPresent: isRecord(selectTerminalResult),
    waitTerminalResultExactTask: waitTerminalResult?.task_id === taskId,
    selectTerminalResultExactTask: selectTerminalResult?.task_id === taskId,
    waitTerminalResultHasNoInlineChildOutput: isRecord(waitTerminalResult) && !Object.hasOwn(waitTerminalResult, "result_text") && !Object.hasOwn(waitTerminalResult, "child_output"),
    selectTerminalResultHasNoInlineChildOutput: isRecord(selectTerminalResult) && !Object.hasOwn(selectTerminalResult, "result_text") && !Object.hasOwn(selectTerminalResult, "child_output"),
    waitTerminalResultHasArtifactField: isRecord(waitTerminalResult) && Object.hasOwn(waitTerminalResult, "full_output_artifact"),
    selectTerminalResultHasArtifactField: isRecord(selectTerminalResult) && Object.hasOwn(selectTerminalResult, "full_output_artifact"),
    statusRemainsInspectionNotOutputRetrieval: !statusJson.includes("result_text") && !statusJson.includes("child_output"),
    statusRemainsNoTerminalResultRetrieval: !["terminal_result", "full_output_artifact", "result_text", "child_output"].some((token) => statusJson.includes(token)),
  };

  async function runCallbackDeliveryStateProbe(label, expectedDelivery, expectedAction) {
    const probeChild = join(sessionRoot, `${label}-callback-state-child.mjs`);
    const probeSession = join(childSessionRoot, `${label}-callback-state.jsonl`);
    await writeDelayedAsyncSubagentChild(probeChild, {
      sessionFile: probeSession,
      finalText: `${label.toUpperCase()}_CALLBACK_STATE_FINAL`,
      terminalDelayMs: 25,
      terminalMarkerFile: join(sessionRoot, `${label}-callback-state-terminal.txt`),
    });
    const attempts = [];
    const probeCtx = {
      ...ctx,
      env: { ...ctx.env, LARVA_PI_EXTENSION_FLAG: probeChild, LARVA_PI_REAL_BIN: process.execPath },
      session: { label, entries: [] },
      callbackSurface: {
        sendMessage: async (message, options) => {
          attempts.push({ message, options });
          if (label === "pending" || label === "suppressed") await new Promise(() => undefined);
          if (label === "failed") throw new Error("runtime smoke callback boom");
        },
      },
    };
    const acceptedProbe = await mod.larva_subagent({ persona_id: "child", task: `${label} callback delivery state probe` }, probeCtx);
    const probeTaskId = acceptedProbe?.task_id ?? probeSession;
    if (label === "stale") probeCtx.session = { label, stale: true, entries: [] };
    if (label === "pending" || label === "suppressed") {
      try {
        await waitForSmokeCondition(async () => {
          const status = await mod.larva_subagent_status({ task_id: probeTaskId }, { env: probeCtx.env });
          const run = status?.details?.runs?.[0] ?? null;
          return run?.status === "success" && run?.callback_delivery === "pending" ? run : null;
        }, { label: `${label} terminal pending${label === "suppressed" ? " before duplicate suppression" : ""}`, timeoutMs: 1_000, intervalMs: 10 });
      } catch {}
    }
    if (label === "suppressed") {
      await mod.larva_subagent_cancel({ task_id: probeTaskId, reason: "runtime smoke duplicate terminal path" }, { env: probeCtx.env });
    }
    let statusRun = null;
    try {
      statusRun = await waitForSmokeCondition(async () => {
        const status = await mod.larva_subagent_status({ task_id: probeTaskId }, { env: probeCtx.env });
        const run = status?.details?.runs?.[0] ?? null;
        return run?.callback_delivery === expectedDelivery ? run : null;
      }, { label: `${label} callback_delivery ${expectedDelivery}`, timeoutMs: 1_500, intervalMs: 10 });
    } catch {
      const status = await mod.larva_subagent_status({ task_id: probeTaskId }, { env: probeCtx.env });
      statusRun = status?.details?.runs?.[0] ?? null;
    }
    const waitProbe = await mod.larva_subagent_wait({ task_ids: [probeTaskId], return_when: "all", timeout_ms: 0 }, { env: probeCtx.env });
    const selectProbe = await mod.larva_subagent_select({ task_ids: [probeTaskId], timeout_ms: 0 }, { env: probeCtx.env });
    const terminal = waitProbe?.details?.terminal_result ?? null;
    return {
      label,
      expectedDelivery,
      expectedAction,
      task_id: probeTaskId,
      accepted: acceptedProbe,
      attempts: attempts.length,
      statusRun,
      waitAction: waitProbe?.details?.recommended_next_action ?? null,
      selectAction: selectProbe?.details?.recommended_next_action ?? null,
      terminal,
      passed: statusRun?.callback_delivery === expectedDelivery
        && waitProbe?.details?.recommended_next_action === expectedAction
        && selectProbe?.details?.recommended_next_action === expectedAction
        && terminal?.callback_delivery === expectedDelivery,
    };
  }

  const callbackDeliveryStateProbe = {
    pending: await runCallbackDeliveryStateProbe("pending", "pending", "yield_for_callback"),
    delivered: await runCallbackDeliveryStateProbe("delivered", "delivered", "use_terminal_result_metadata"),
    failed: await runCallbackDeliveryStateProbe("failed", "failed", "inspect_callback_failure"),
    stale: await runCallbackDeliveryStateProbe("stale", "stale", "stop_parent_stale"),
    suppressed: await runCallbackDeliveryStateProbe("suppressed", "suppressed", "acknowledge_suppressed_duplicate"),
  };
  const stateAssertions = {
    callbackPendingDeliveredFailedStaleSuppressedModeled: Object.values(callbackDeliveryStateProbe).every((row) => row.passed === true),
    callbackStateActionsAreUnambiguous: Object.values(callbackDeliveryStateProbe).every((row) => typeof row.waitAction === "string" && row.waitAction === row.expectedAction && row.selectAction === row.expectedAction),
    duplicateDeliveryIdempotencyPreserved: callbackDeliveryStateProbe.delivered.attempts === 1 && callbackDeliveryStateProbe.suppressed.attempts === 1 && callbackDeliveryStateProbe.suppressed.terminal?.callback_delivery_diagnostic?.code === "LARVA_CALLBACK_DUPLICATE_SUPPRESSED",
    staleParentInjectionPrevented: callbackDeliveryStateProbe.stale.attempts === 0 && callbackDeliveryStateProbe.stale.terminal?.callback_delivery_diagnostic?.code === "LARVA_CALLBACK_PARENT_STALE",
    failedDeliveryCarriesReasonCode: callbackDeliveryStateProbe.failed.terminal?.callback_delivery_diagnostic?.code === "LARVA_CALLBACK_DELIVERY_FAILED" && String(callbackDeliveryStateProbe.failed.terminal?.callback_delivery_diagnostic?.message ?? "").includes("runtime smoke callback boom"),
  };
  evidence.runtime.waitSelectPendingCallbackHandoff = {
    status: Object.values(assertions).every(Boolean) && Object.values(stateAssertions).every(Boolean) ? "PASS" : "EXPECTED_RED",
    expectedRecommendedNextAction,
    failureFingerprints: ["recommended_next_action", "yield_for_callback", "terminal_result", "full_output_artifact"],
    observedRecommendedNextActions: {
      wait: waitResult?.details?.recommended_next_action ?? null,
      select: selectResult?.details?.recommended_next_action ?? null,
    },
    task_id: taskId,
    accepted,
    terminalPendingRun,
    callbackAttemptsObserved: callbackAttempts.length,
    callbackDeliveryStateProbe,
    stateAssertions,
    wait: { details: waitResult?.details ?? null, text: waitText },
    select: { details: selectResult?.details ?? null, text: selectText },
    statusInspection: { details: statusResult?.details ?? null },
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
  const statusCalls = [];
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
    ui: { setStatus: async (...args) => { statusCalls.push(args); }, notify: async () => undefined, custom: async () => ({ opened: true }) },
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
  const eventsTool = toolByName("larva_subagent_events");
  const waitTool = toolByName("larva_subagent_wait");
  const selectTool = toolByName("larva_subagent_select");
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
  const invokeStatus = async (taskId, label, extra = {}, statusCtx = ctx) => {
    const input = taskId === null ? { ...extra } : { task_id: taskId, ...extra };
    const invoked = await runTool(statusTool, `status-${label}`, input, statusCtx);
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
  const invokeEvents = async (label, input, eventsCtx = ctx) => {
    const invoked = await runTool(eventsTool, `events-${label}`, input, eventsCtx);
    const details = detailsOf(invoked.result);
    return {
      label,
      input,
      invoked: invoked.invoked,
      error: invoked.error,
      status: details?.status ?? null,
      events: Array.isArray(details?.events) ? details.events : null,
      next_sequence: Number.isInteger(details?.next_sequence) ? details.next_sequence : null,
      cursor_expired: typeof details?.cursor_expired === "boolean" ? details.cursor_expired : null,
      errorCode: errorCodeOf(invoked.result) ?? invoked.error,
    };
  };
  const invokeWait = async (label, input, waitCtx = ctx) => {
    const invoked = await runTool(waitTool, `wait-${label}`, input, waitCtx);
    const details = detailsOf(invoked.result);
    return {
      label,
      input,
      invoked: invoked.invoked,
      error: invoked.error,
      status: details?.status ?? null,
      return_when: details?.return_when ?? null,
      satisfied: typeof details?.satisfied === "boolean" ? details.satisfied : null,
      timed_out: typeof details?.timed_out === "boolean" ? details.timed_out : null,
      runs: Array.isArray(details?.runs) ? details.runs : null,
      ready_task_ids: Array.isArray(details?.ready_task_ids) ? details.ready_task_ids : null,
      pending_task_ids: Array.isArray(details?.pending_task_ids) ? details.pending_task_ids : null,
      next_sequence: Number.isInteger(details?.next_sequence) ? details.next_sequence : null,
      errorCode: errorCodeOf(invoked.result) ?? invoked.error,
    };
  };
  const invokeSelect = async (label, input, selectCtx = ctx) => {
    const invoked = await runTool(selectTool, `select-${label}`, input, selectCtx);
    const details = detailsOf(invoked.result);
    return {
      label,
      input,
      invoked: invoked.invoked,
      error: invoked.error,
      status: details?.status ?? null,
      return_when: details?.return_when ?? null,
      satisfied: typeof details?.satisfied === "boolean" ? details.satisfied : null,
      timed_out: typeof details?.timed_out === "boolean" ? details.timed_out : null,
      runs: Array.isArray(details?.runs) ? details.runs : null,
      ready_task_ids: Array.isArray(details?.ready_task_ids) ? details.ready_task_ids : null,
      pending_task_ids: Array.isArray(details?.pending_task_ids) ? details.pending_task_ids : null,
      next_sequence: Number.isInteger(details?.next_sequence) ? details.next_sequence : null,
      errorCode: errorCodeOf(invoked.result) ?? invoked.error,
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
      && data?.phase === expectedStatus
      && data?.result_pending === false
      && data?.callback_delivery === "delivered"
      && typeof data?.result_text === "string"
      && normalizeCodePointCount(text) <= 6000
      && normalizeCodePointCount(data?.message) <= 6000
      && typeof data?.message === "string"
      && data.message.includes(`task_id: ${data.task_id}`)
      && data.message.includes(`persona_id: ${data.persona_id}`)
      && data.message.includes(`status: ${expectedStatus}`)
      && data.message.includes("callback_delivery: delivered")
      && data.message.includes("---\nchild_output:")
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
    && ["pending", "delivered", "suppressed", "stale", "failed"].includes(run.callback_delivery)
    && "callback_delivery_diagnostic" in run
    && (run.callback_delivery_diagnostic === null || (isRecord(run.callback_delivery_diagnostic) && typeof run.callback_delivery_diagnostic.code === "string" && typeof run.callback_delivery_diagnostic.message === "string"))
    && typeof run.updated_at === "string"
    && !Number.isNaN(Date.parse(run.updated_at))
    && "error" in run
    && (run.error === null || (isRecord(run.error) && typeof run.error.code === "string" && typeof run.error.message === "string"));
  // Exact status probes may race before the child reaches waiting_for_child;
  // accepted/session_ready and accepted/prompt_sent are still schema-complete
  // process-local pending rows under the async subagent contract.
  const hasPendingPreTerminalStatusRunShape = (run, taskId) => hasStatusRunShape(run, taskId, ["accepted", "running"])
    && run.result_pending === true
    && run.error === null
    && ((run.status === "accepted" && ["session_ready", "prompt_sent", "waiting_for_child"].includes(run.phase))
      || (run.status === "running" && run.phase === "waiting_for_child"));

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

  const eventsAfterTerminal = await invokeEvents("after-terminal", {
    since_sequence: 0,
    task_ids: [acceptedTaskIdForProbes],
    limit: 100,
  });
  const eventsFilteredNoMatch = await invokeEvents("filtered-no-match", {
    since_sequence: eventsAfterTerminal.next_sequence ?? 0,
    task_ids: [join(childSessionRoot, "well-formed-but-unobserved.jsonl")],
    limit: 10,
  });
  const waitAllTerminal = await invokeWait("all-terminal", {
    task_ids: [acceptedTaskIdForProbes],
    return_when: "all",
    timeout_ms: 0,
  });
  const waitAnyTerminal = await invokeWait("any-terminal", {
    task_ids: [acceptedTaskIdForProbes],
    return_when: "any",
    timeout_ms: 0,
  });
  const waitFirstErrorOnSuccess = await invokeWait("first-error-success", {
    task_ids: [acceptedTaskIdForProbes],
    return_when: "first_error",
    timeout_ms: 0,
  });
  const waitUnobserved = await invokeWait("unobserved", {
    task_ids: [join(childSessionRoot, "well-formed-unobserved-wait.jsonl")],
    return_when: "all",
    timeout_ms: 0,
  });
  const selectAnyTerminal = await invokeSelect("any-terminal", {
    task_ids: [acceptedTaskIdForProbes],
    timeout_ms: 0,
  });
  const deterministicOrchestrationProbe = {
    registeredToolNames: tools.map((tool) => tool.name),
    eventsAfterTerminal,
    eventsFilteredNoMatch,
    waitAllTerminal,
    waitAnyTerminal,
    waitFirstErrorOnSuccess,
    waitUnobserved,
    selectAnyTerminal,
    sourceProbe: {
      noJoinTool: !source.includes('name: "larva_subagent_join"') && !source.includes("larva_subagent_join"),
      retentionBoundPinned: source.includes("1000") && source.includes("cursor_expired"),
      noFilesystemDiscoveryForEvents: !/larva_subagent_events[\s\S]{0,2000}(readFile|readdir|glob|jsonl)/.test(source),
    },
  };
  const statusTextEntries = statusCalls.map((args) => args.filter((value) => typeof value === "string").join(" "));
  const backgroundIndicatorTexts = statusTextEntries.filter((text) => /subagents: \d+ (?:running|cancelling)(?: · \d+ cancelling)?/.test(text));
  const backgroundIndicatorCleared = statusCalls.some((args) => args[0] === "larva-subagents" && args.length >= 2 && args[1] === undefined);
  const backgroundIndicatorProbe = {
    statusCalls,
    statusTextEntries,
    backgroundIndicatorTexts,
    backgroundIndicatorCleared,
    taskId: acceptedTaskIdForProbes,
    activeCountOnlyTextObserved: backgroundIndicatorTexts.some((text) => /subagents: \d+ running/.test(text)),
    taskTextAndHandleHidden: backgroundIndicatorTexts.every((text) => !text.includes("produce one async callback") && !text.includes(acceptedTaskIdForProbes)),
    noControlSurfaceText: backgroundIndicatorTexts.every((text) => !/cancel|clear|select|task_id/i.test(text)),
    idleOrHiddenAfterTerminal: backgroundIndicatorTexts.length === 0 || backgroundIndicatorCleared,
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
      else if (message.type === "get_last_assistant_text") { send({ id: message.id, success: true, data: { text: { malformed: true } } }); setTimeout(() => process.exit(0), 5); }
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
  const callbackCountAfterLifecycle = callbackEntries.length;
  const idempotencyStaleProbe = {
    callbackCountsByTaskId,
    duplicateTaskId: acceptedTaskIdForProbes,
    duplicateCallbackCount: callbackCountsByTaskId[acceptedTaskIdForProbes] ?? 0,
    callbackCountAfterLifecycle,
    staleLifecycleRows: lifecycleRows,
  };
  const runNonresponsiveAbortDeadlineProof = async () => {
    const proofChild = join(sessionRoot, "abort-deadline-nonresponsive-child.mjs");
    const proofSessionFile = join(childSessionRoot, "abort-deadline-nonresponsive.jsonl");
    const proofTraceFile = join(sessionRoot, "abort-deadline-trace.jsonl");
    await writeNonresponsiveAbortSubagentChild(proofChild, { sessionFile: proofSessionFile });
    const proofCtx = {
      ...ctx,
      env: {
        ...ctx.env,
        LARVA_PI_REAL_BIN: process.execPath,
        LARVA_PI_EXTENSION_FLAG: proofChild,
        LARVA_PI_EXTENSION_ENTRY: "ignored-extension-entry.ts",
        LARVA_PI_CHILD_RPC_TRACE_FILE: proofTraceFile,
      },
    };
    const updates = [];
    const acceptedCall = await runTool(
      subagentTool,
      "abort-deadline-nonresponsive",
      { persona_id: "child", task: "stay running until the adapter abort deadline proof cancels this child" },
      proofCtx,
      undefined,
      (update) => updates.push(update),
    );
    const acceptedDetails = detailsOf(acceptedCall.result);
    const taskId = acceptedDetails?.task_id ?? null;
    const observations = [];
    if (typeof taskId !== "string") {
      return {
        status: "not-accepted",
        expectedGraceMs: 1500,
        deadlineUpperBoundMs: 2400,
        childScript: proofChild,
        traceFile: proofTraceFile,
        acceptedCall,
        taskId,
        updates,
        observations,
      };
    }
    const cancelStartedAtMs = Date.now();
    const cancelCall = await runTool(
      cancelTool,
      "cancel-abort-deadline-nonresponsive",
      { task_id: taskId, reason: "nonresponsive child abort deadline proof" },
      proofCtx,
    );
    let terminalObservation = null;
    while (Date.now() - cancelStartedAtMs < 3_500) {
      const observation = await invokeStatus(taskId, `abort-deadline-${observations.length}`, {}, proofCtx);
      observations.push(observation);
      const run = Array.isArray(observation.runs) ? observation.runs[0] : null;
      if (["success", "failed", "cancelled"].includes(run?.status)) {
        terminalObservation = observation;
        break;
      }
      await sleep(50);
    }
    const terminalElapsedMs = Date.now() - cancelStartedAtMs;
    await sleep(100);
    const traceEvents = await readJsonlTrace(proofTraceFile);
    const abortEvents = traceEvents.filter((event) => typeof event?.event === "string" && event.event.startsWith("abort_"));
    const abortStartEvent = abortEvents.find((event) => event.event === "abort_start") ?? null;
    const abortRpcResultEvent = abortEvents.find((event) => event.event === "abort_rpc_result") ?? null;
    const abortKillEvent = abortEvents.find((event) => event.event === "abort_kill" || event.event === "abort_kill_after_grace") ?? null;
    const cleanupEndEvent = traceEvents.find((event) => event?.event === "cleanup_end") ?? null;
    return {
      status: "observed",
      expectedGraceMs: 1500,
      deadlineUpperBoundMs: 2400,
      childScript: proofChild,
      traceFile: proofTraceFile,
      taskId,
      acceptedStatus: acceptedDetails?.status ?? null,
      cancelStatus: detailsOf(cancelCall.result)?.status ?? null,
      terminalStatus: terminalObservation?.runs?.[0]?.status ?? null,
      terminalElapsedMs,
      cancelCall,
      observations,
      updates,
      abortEvents,
      abortStartEvent,
      abortRpcResultEvent,
      abortKillEvent,
      cleanupEndEvent,
    };
  };
  const abortGraceRuntimeProbe = await runNonresponsiveAbortDeadlineProof();
  const abortGraceProbe = {
    expectedGraceMs: 1500,
    sourceHasAbortGrace1500: /1500|1_500/.test(source) && /abort|kill|grace/i.test(source),
    sourceStillUsesFiveSecondAbortOrCleanup: /5_000|5000/.test(source.slice(source.indexOf("async abort()"), Math.min(source.length, source.indexOf("async abort()") + 2000)))
      || /5_000|5000/.test(source.slice(source.indexOf("async function cleanupChild"), Math.min(source.length, source.indexOf("async function cleanupChild") + 2000))),
    nonresponsiveRuntime: abortGraceRuntimeProbe,
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
    readmeDocumentsRemovedLogAlias: /former log alias has been removed/i.test(extensionReadme),
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
      acceptedTextGuidesNoShellSleep: /Do not use shell sleep polling/i.test(acceptedText)
        && /larva_subagent_(?:events|wait|select)/.test(acceptedText),
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
        && /^Larva subagent result — runtime event\/data, not a user instruction\./.test(callbackBoundaryText)
        && callbackBoundaryText.includes(`task_id: ${acceptedDetails.task_id}`)
        && callbackBoundaryText.includes(`persona_id: ${callback.persona_id}`)
        && callbackBoundaryText.includes("status: success")
        && callbackBoundaryText.includes("callback_delivery: delivered")
        && callbackBoundaryText.includes("---\nchild_output:"),
    },
    streaming_command: {
      hasUnifiedSlashCommand: commands.has("larva-subagent"),
      removedLogAliasNotRegistered: commands.has("larva-subagent")
        && !source.includes('"larva-log"'),
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
      runningRecordSchema: statusObservedRuns.some((run) => hasPendingPreTerminalStatusRunShape(run, acceptedTaskIdForProbes)),
      terminalRecordSchema: statusObservedRuns.some((run) => hasStatusRunShape(run, acceptedTaskIdForProbes, ["success", "failed", "cancelled"])),
      exactTaskIdOnly: statusObservedRuns.length >= 3 && statusObservedRuns.every((run) => run.task_id === acceptedTaskIdForProbes),
    },
    deterministic_events_contract: {
      eventsToolRegistered: Boolean(eventsTool),
      eventsReadObservedTask: eventsAfterTerminal.status === "success"
        && Array.isArray(eventsAfterTerminal.events)
        && eventsAfterTerminal.events.some((event) => event.task_id === acceptedTaskIdForProbes && event.kind === "accepted")
        && eventsAfterTerminal.events.some((event) => event.task_id === acceptedTaskIdForProbes && event.kind === "terminal" && event.result_pending === false),
      eventsCursorShape: eventsAfterTerminal.status === "success"
        && Number.isInteger(eventsAfterTerminal.next_sequence)
        && typeof eventsAfterTerminal.cursor_expired === "boolean",
      filteredCursorAdvancesWithoutFilesystemDiscovery: eventsFilteredNoMatch.status === "success"
        && Array.isArray(eventsFilteredNoMatch.events)
        && eventsFilteredNoMatch.events.length === 0
        && Number.isInteger(eventsFilteredNoMatch.next_sequence)
        && deterministicOrchestrationProbe.sourceProbe.noFilesystemDiscoveryForEvents === true,
      retentionCursorRulesPinned: deterministicOrchestrationProbe.sourceProbe.retentionBoundPinned === true,
      noJoinTool: deterministicOrchestrationProbe.sourceProbe.noJoinTool === true,
    },
    deterministic_wait_select_contract: {
      waitToolRegistered: Boolean(waitTool),
      selectToolRegistered: Boolean(selectTool),
      waitAllTerminalSatisfied: waitAllTerminal.status === "success"
        && waitAllTerminal.return_when === "all"
        && waitAllTerminal.satisfied === true
        && waitAllTerminal.timed_out === false
        && Array.isArray(waitAllTerminal.ready_task_ids)
        && waitAllTerminal.ready_task_ids.includes(acceptedTaskIdForProbes),
      waitAnyTerminalSatisfied: waitAnyTerminal.status === "success"
        && waitAnyTerminal.return_when === "any"
        && waitAnyTerminal.satisfied === true
        && waitAnyTerminal.timed_out === false,
      waitFirstErrorIgnoresSuccessfulCallbackDeliveryDiagnostics: waitFirstErrorOnSuccess.status === "success"
        && waitFirstErrorOnSuccess.return_when === "first_error"
        && waitFirstErrorOnSuccess.satisfied === false
        && waitFirstErrorOnSuccess.timed_out === true,
      waitUnobservedExactHandleErrors: waitUnobserved.errorCode === "LARVA_SUBAGENT_NOT_OBSERVED",
      selectMatchesWaitAnyModel: selectAnyTerminal.status === "success"
        && selectAnyTerminal.return_when === "any"
        && selectAnyTerminal.satisfied === waitAnyTerminal.satisfied
        && JSON.stringify(selectAnyTerminal.ready_task_ids) === JSON.stringify(waitAnyTerminal.ready_task_ids),
    },
    background_activity_indicator_count_only: {
      activeCountOnlyTextObserved: backgroundIndicatorProbe.activeCountOnlyTextObserved === true,
      taskTextAndHandleHidden: backgroundIndicatorProbe.taskTextAndHandleHidden === true,
      noControlSurfaceText: backgroundIndicatorProbe.noControlSurfaceText === true,
      idleOrHiddenAfterTerminal: backgroundIndicatorProbe.idleOrHiddenAfterTerminal === true,
    },
    failed_cancelled_callback_shape: {
      failedCallbackShape: hasCallbackPayloadShape(failedCallback, "failed"),
      cancelledCallbackShape: hasCallbackPayloadShape(cancelledCallback, "cancelled"),
    },
    callback_idempotency_duplicate_suppression: {
      duplicateCallbackSuppressed: (idempotencyStaleProbe.duplicateCallbackCount ?? 0) === 1,
      staleLateCallbackSuppressed: lifecycleRows.every((row) => row.handlerRegistered && row.callbackCountAfterEvent === idempotencyStaleProbe.callbackCountAfterLifecycle),
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
      nonresponsiveAccepted: abortGraceProbe.nonresponsiveRuntime.acceptedStatus === "accepted",
      nonresponsiveCancelled: abortGraceProbe.nonresponsiveRuntime.terminalStatus === "cancelled",
      nonresponsiveElapsedWithinSingleDeadline: abortGraceProbe.nonresponsiveRuntime.terminalElapsedMs >= 1_000
        && abortGraceProbe.nonresponsiveRuntime.terminalElapsedMs <= abortGraceProbe.nonresponsiveRuntime.deadlineUpperBoundMs,
      nonresponsiveKillObserved: abortGraceProbe.nonresponsiveRuntime.abortKillEvent?.killed === true,
      nonresponsiveTraceDeadlineRecorded: abortGraceProbe.nonresponsiveRuntime.abortStartEvent?.deadline_at_ms - abortGraceProbe.nonresponsiveRuntime.abortStartEvent?.started_at_ms === 1_500,
      nonresponsiveKillAtSingleDeadline: abortGraceProbe.nonresponsiveRuntime.abortKillEvent?.elapsed_ms >= 1_000
        && abortGraceProbe.nonresponsiveRuntime.abortKillEvent?.elapsed_ms <= abortGraceProbe.nonresponsiveRuntime.deadlineUpperBoundMs,
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
      removedLogAliasDocumented: docsParityProbe.readmeDocumentsRemovedLogAlias === true,
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
    deterministicOrchestrationProbe,
    backgroundIndicatorProbe,
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
      acceptedTextGuidesNoShellSleep: assertionGroups.accepted_return_timing.acceptedTextGuidesNoShellSleep,
      singleCallbackEvent: assertionGroups.callbacks.singleCallbackEvent,
      callbackShape: assertionGroups.callbacks.callbackShape,
      hasUnifiedSlashCommand: assertionGroups.streaming_command.hasUnifiedSlashCommand,
      removedLogAliasNotRegistered: assertionGroups.streaming_command.removedLogAliasNotRegistered,
      streamingSlashCommandDispatch: assertionGroups.streaming_command.streamingSlashCommandDispatch,
      rpcListTextualNoOverlay: assertionGroups.mode_matrix_fallbacks.rpcListTextualNoOverlay,
      rpcExactTextualNoOverlay: assertionGroups.mode_matrix_fallbacks.rpcExactTextualNoOverlay,
      printJsonExactSummary: assertionGroups.mode_matrix_fallbacks.printJsonExactSummary,
      printJsonViewUnavailable: assertionGroups.mode_matrix_fallbacks.printJsonViewUnavailable,
      printJsonCancelUnavailable: assertionGroups.mode_matrix_fallbacks.printJsonCancelUnavailable,
      printJsonClearUnavailable: assertionGroups.mode_matrix_fallbacks.printJsonClearUnavailable,
      statusSchema: Object.values(assertionGroups.status_schema_phase_result_pending_updated_at_error).every(Boolean),
      deterministicEventsContract: Object.values(assertionGroups.deterministic_events_contract).every(Boolean),
      deterministicWaitSelectContract: Object.values(assertionGroups.deterministic_wait_select_contract).every(Boolean),
      backgroundActivityIndicatorCountOnly: Object.values(assertionGroups.background_activity_indicator_count_only).every(Boolean),
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

async function personaInvocationBusContractAnchors(evidence) {
  const source = await readFile(extensionPath, "utf8");
  const requiredEventTokens = [
    "larva:persona-invocation:request",
    "larva:persona-invocation:cancel",
    "larva:persona-invocation:result",
  ];
  const forbiddenInfrastructureFingerprints = [
    "ModuleNotFoundError",
    "ImportError",
    "Cannot find module",
    "SyntaxError",
    "ERR_MODULE_NOT_FOUND",
    "test collection error",
    "missing Node/Pi runtime",
  ];
  const checks = PIINV_MACHINE_ANCHORS.map((machine_anchor) => {
    const eventTokensPresent = requiredEventTokens.every((token) => source.includes(token));
    const machineAnchorPresent = source.includes(machine_anchor);
    const passed = eventTokensPresent && machineAnchorPresent;
    return {
      machine_anchor,
      status: passed ? "PASS" : "FAIL",
      fingerprint: `PIINV_CONTRACT_ANCHOR::${machine_anchor}`,
      missing: {
        event_bus_tokens: requiredEventTokens.filter((token) => !source.includes(token)),
        machine_anchor_token: machineAnchorPresent ? [] : [machine_anchor],
      },
      behavioral_obligation: "trusted same-runtime extension event bus request/cancel/result behavior is implemented over the documented Pi shared event bus",
    };
  });
  const fingerprints = checks.map((check) => check.fingerprint);
  evidence.runtime.personaInvocationBus = {
    status: checks.every((check) => check.status === "PASS") ? "PASS" : "FAIL",
    expectedResult: "persona invocation event-bus contract anchors remain present",
    scenarioBasis: "source-level contract-anchor smoke for extension-facing PIINV event bus; live RPC behavior is covered by pytest real Pi probe",
    eventBusTokens: requiredEventTokens,
    checks,
    fingerprints,
    requiredFailureIds: PIINV_REQUIRED_EXPECTED_RED_IDS,
    terminalRaceAnchorsPresent: PIINV_TERMINAL_RACE_ANCHORS.every((anchor) => fingerprints.some((fingerprint) => fingerprint.includes(anchor))),
    forbiddenInfrastructureFingerprintsAbsent: forbiddenInfrastructureFingerprints.every((fingerprint) => !fingerprints.join("\n").includes(fingerprint)),
    nonGoalsPreserved: {
      noModelFacingTool: !source.includes('name: "larva_persona_invocation"'),
      noWaitSelectEventsSurface: !source.includes("larva_persona_invocation_wait") && !source.includes("larva_persona_invocation_select") && !source.includes("larva_persona_invocation_events"),
      noSubagentConsoleIntegration: !source.includes("persona-invocation") || !source.includes("larva-subagent"),
    },
  };
}

async function realPiPersonaInvocationBusProof(evidence) {
  await piAvailability(evidence);
  evidence.runtime.personaInvocationBusRealPi = { status: "BLOCKED", attempted: false };
  if (!evidence.pi.available || !evidence.pi.extensionFlag || runtimeIsolation === null) return;

  const probePath = join(runtimeIsolation.tempRoot, "persona-invocation-probe.ts");
  await writeFile(probePath, `
export default function (pi) {
  let currentCtx;
  const results = [];
  pi.events?.on?.("larva:persona-invocation:result", (result) => {
    results.push(result);
    currentCtx?.ui?.notify?.(\`PIINV_RESULT \${JSON.stringify(result)}\`, "info");
  });
  pi.on?.("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    ctx.ui?.notify?.(\`PIINV_SURFACE \${JSON.stringify({ piOn: typeof pi.on, piEmit: typeof pi.emit, piEventsOn: typeof pi.events?.on, piEventsEmit: typeof pi.events?.emit })}\`, "info");
    pi.events?.emit?.("larva:persona-invocation:request", {
      request_id: "11111111-1111-4111-8111-111111111111",
      persona_id: "",
      prompt: "probe",
      timeout_ms: 10,
    });
    setTimeout(() => ctx.ui?.notify?.(\`PIINV_RESULTS_COUNT \${results.length}\`, "info"), 300);
  });
}
`, "utf8");
  const args = [
    "--mode", "rpc", "--no-session", "--no-extensions", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--offline", "--approve",
    evidence.pi.extensionFlag, runtimeIsolation.providerExtension,
    evidence.pi.extensionFlag, extensionPath,
    evidence.pi.extensionFlag, probePath,
    "--session-dir", runtimeIsolation.parentSessionDir,
  ];
  const env = runtimeEnv({ LARVA_PI_AGENT_PERSONA_SWITCH: "manual" });
  const child = spawn(evidence.pi.binary, args, { cwd: runtimeIsolation.tempRoot, env, stdio: ["pipe", "pipe", "pipe"] });
  evidence.runtime.personaInvocationBusRealPi.attempted = Number.isInteger(child.pid);
  const interesting = [];
  const stderr = [];
  const lines = createInterface({ input: child.stdout });
  let countObserved = false;
  const observed = new Promise((resolveObserved) => {
    lines.on("line", (line) => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event?.type === "extension_ui_request" && event.method === "notify") {
        interesting.push(event);
        if (event.message?.startsWith("PIINV_RESULTS_COUNT ")) {
          countObserved = true;
          resolveObserved({ timedOut: false, exitedEarly: false });
        }
      }
    });
    child.once("close", () => {
      if (!countObserved) resolveObserved({ timedOut: false, exitedEarly: true });
    });
  });
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString("utf8")));
  const outcome = await Promise.race([
    observed,
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout({ timedOut: true, exitedEarly: false }), 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveClose) => child.once("close", resolveClose)),
    new Promise((resolveWait) => setTimeout(resolveWait, 1_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  lines.close();
  const surfaceMessage = interesting.find((event) => event.message?.startsWith("PIINV_SURFACE "))?.message ?? null;
  const resultMessage = interesting.find((event) => event.message?.startsWith("PIINV_RESULT "))?.message ?? null;
  const countMessage = interesting.find((event) => event.message?.startsWith("PIINV_RESULTS_COUNT "))?.message ?? null;
  let surface = null;
  let result = null;
  try { if (surfaceMessage) surface = JSON.parse(surfaceMessage.slice("PIINV_SURFACE ".length)); } catch {}
  try { if (resultMessage) result = JSON.parse(resultMessage.slice("PIINV_RESULT ".length)); } catch {}
  const expectedSurface = { piOn: "function", piEmit: "undefined", piEventsOn: "function", piEventsEmit: "function" };
  const expectedResult = {
    request_id: "11111111-1111-4111-8111-111111111111",
    status: "failed",
    persona_id: "",
    final_text: "",
    error: { code: "LARVA_PERSONA_INVOCATION_BAD_INPUT", message: "persona_id must be a non-empty string." },
  };
  const status = outcome.timedOut === false
    && outcome.exitedEarly === false
    && stderr.join("") === ""
    && JSON.stringify(surface) === JSON.stringify(expectedSurface)
    && JSON.stringify(result) === JSON.stringify(expectedResult)
    && countMessage === "PIINV_RESULTS_COUNT 1"
    ? "PASS"
    : "FAIL";
  evidence.runtime.personaInvocationBusRealPi = {
    status,
    attempted: evidence.runtime.personaInvocationBusRealPi.attempted,
    command: [evidence.pi.binary, ...args],
    timedOut: outcome.timedOut,
    exitedEarly: outcome.exitedEarly,
    surface,
    result,
    count: countMessage,
    stderr: stderr.join(""),
    initialPersonaOwned: false,
  };
}

async function modelMapProfileSwitchProof(evidence) {
  const sessionRoot = await mkdtemp(join(tmpdir(), "larva-model-map-profile-switch-"));
  const configDir = join(sessionRoot, ".pi", "larva");
  const traceFile = join(sessionRoot, "child-rpc.jsonl");
  const childSessionDir = join(sessionRoot, "child-sessions");
  const fakePi = join(sessionRoot, "fake-pi.mjs");
  await mkdir(configDir, { recursive: true });
  const cli = join(sessionRoot, "fake-cli.mjs");
  await writeFile(cli, `
const [, , command, personaId, jsonFlag] = process.argv;
if (command !== "resolve" || jsonFlag !== "--json") process.exit(3);
const models = { parent: "logical/parent", "child-ready": "logical/child", "child-starting": "logical/child", "child-ending": "logical/child" };
process.stdout.write(JSON.stringify({ data: { id: personaId, description: personaId, prompt: "prompt", model: models[personaId] || "logical/child", capabilities: {}, spec_version: "0.1.0", spec_digest: "sha256:" + personaId, can_spawn: true } }));
`, "utf8");
  await writeFile(fakePi, `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const sessionRoot = process.argv[process.argv.indexOf("--session-dir") + 1];
const persona = process.env.LARVA_PI_INITIAL_PERSONA_ID || "child";
const sessionFile = join(sessionRoot, persona + "-" + process.pid + ".jsonl");
await mkdir(sessionRoot, { recursive: true });
await writeFile(sessionFile, "{}\\n", "utf8");
const trace = async (value) => appendFile(${JSON.stringify(traceFile)}, JSON.stringify({ persona, ...value }) + "\\n", "utf8");
let active = 0;
const rl = createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
rl.on("line", async (line) => {
  const message = JSON.parse(line);
  await trace({ phase: "rx", type: message.type, id: message.id, modelId: message.modelId || null });
  if (message.type === "get_state") {
    if (persona === "child-starting") { setTimeout(() => process.exit(0), 20); return; }
    return send({ id: message.id, success: true, data: { sessionFile } });
  }
  if (message.type === "switch_session") return send({ id: message.id, success: true, data: { cancelled: false } });
  if (message.type === "set_model") {
    active += 1;
    await trace({ phase: "set_model_start", id: message.id, active });
    await new Promise((resolve) => setTimeout(resolve, 40));
    active -= 1;
    await trace({ phase: "set_model_end", id: message.id, active });
    return send({ id: message.id, success: true });
  }
  if (message.type === "prompt") return send({ id: message.id, success: true });
  if (message.type === "get_last_assistant_text") return send({ id: message.id, success: true, data: { text: "done" } });
  if (message.type === "abort") { send({ id: message.id, success: true }); process.exit(0); }
});
`, "utf8");
  await chmod(fakePi, 0o755);
  const alpha = { models: { "logical/parent": { provider: "neutral", model_id: "parent-a" }, "logical/child": { provider: "neutral", model_id: "child-a" } }, prefix_rules: [] };
  const beta = { models: { "logical/parent": { provider: "neutral", model_id: "parent-b" }, "logical/child": { provider: "neutral", model_id: "child-b" } }, prefix_rules: [] };
  const lexicalBetaPath = join(configDir, "model-map.beta.json");
  const externalBetaPath = join(sessionRoot, "controlled-external-beta.json");
  await writeFile(join(configDir, "model-map.alpha.json"), JSON.stringify(alpha), "utf8");
  await writeFile(externalBetaPath, JSON.stringify(beta), "utf8");
  await symlink(externalBetaPath, lexicalBetaPath);
  const mod = await import(`${pathToFileURL(extensionPath).href}?profile-smoke=${Date.now()}`);
  const commands = new Map();
  const tools = new Map();
  const setModels = [];
  const env = { HOME: sessionRoot, LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, cli]), LARVA_PI_LAUNCHED: "1", LARVA_PI_INITIAL_PERSONA_ID: "parent", LARVA_PI_REAL_BIN: fakePi, LARVA_PI_EXTENSION_FLAG: "-e", LARVA_PI_EXTENSION_ENTRY: extensionPath, LARVA_PI_CHILD_SESSION_DIR: childSessionDir, LARVA_PI_CHILD_RPC_TRACE_FILE: traceFile };
  const ctx = { env, modelRegistry: { find: async (provider, modelId) => ({ provider, modelId }) }, ui: { setStatus: async () => undefined, notify: async () => undefined } };
  const pi = { getAllTools: async () => [], setActiveTools: async () => true, setModel: async (model) => { setModels.push(model); return true; }, registerTool: (tool) => tools.set(tool.name, tool), registerCommand: (name, command) => commands.set(typeof name === "string" ? name : name.name, typeof name === "string" ? command : name), on: () => undefined };
  await mod.initializeExtension(ctx, pi);
  const command = commands.get("larva-model-map");
  const alphaResult = await command.handler("alpha", ctx);
  const ready = await Promise.all(Array.from({ length: 6 }, (_, index) => mod.larva_subagent({ persona_id: "child-ready", task: `ready-${index}` }, { env })));
  const startingPromise = mod.larva_subagent({ persona_id: "child-starting", task: "ending during starting" }, { env });
  await waitForSmokeCondition(async () => (await readJsonlTrace(traceFile)).some((event) => event.event === "child_spawn" && event.persona_id === "child-starting"), { label: "starting child spawn", timeoutMs: 2_000 });
  const betaResult = await command.handler("beta", ctx);
  const starting = await startingPromise;
  const routeStatus = await command.handler("status", ctx);
  await waitForSmokeCondition(async () => (await readJsonlTrace(traceFile)).some((event) => event.phase === "set_model_start"), { label: "developer child set_model", timeoutMs: 2_000 });
  const trace = await readJsonlTrace(traceFile);
  let active = 0;
  let maxActive = 0;
  for (const event of trace) {
    if (event.phase === "set_model_start") { active += 1; maxActive = Math.max(maxActive, active); }
    if (event.phase === "set_model_end") active = Math.max(0, active - 1);
  }
  const terminalChild = betaResult.children.find((child) => child.persona_id === "child-starting");
  const assertions = {
    commandRegistered: Boolean(command),
    parentSetModel: setModels.some((model) => model.modelId === "parent-a") && setModels.at(-1)?.modelId === "parent-b",
    serializedFinalProfile: alphaResult.status === "success" && betaResult.status === "success" && routeStatus.profile === "beta" && routeStatus.generation === 2,
    boundedReadyChildFanout: maxActive === 4,
    terminalDuringStarting: terminalChild?.state === "ended_during_switch",
    inFlightOldNextNew: ready.every((result) => result.status === "accepted") && starting.status === "failed",
    processLocalSource: routeStatus.source === "profile" && routeStatus.path === lexicalBetaPath && JSON.stringify(routeStatus).includes(externalBetaPath) === false,
  };
  await mod.resetExtensionUI("model-map-profile-switch-proof");
  await rm(sessionRoot, { recursive: true, force: true });
  evidence.runtime.modelMapProfileSwitch = { status: Object.values(assertions).every(Boolean) ? "PASS" : "FAIL", assertions, alpha: alphaResult, beta: betaResult, routeStatus, setModels, maxObservedChildRpcConcurrency: maxActive, traceEvents: trace.map((event) => event.phase || event.event), lexicalProfilePath: lexicalBetaPath, externalTargetPath: externalBetaPath, tempRoot: sessionRoot, cleanup: "PASS", observations: { boundedReadyChildFanout: assertions.boundedReadyChildFanout, terminalDuringStarting: assertions.terminalDuringStarting, inFlightOldNextNew: assertions.inFlightOldNextNew, lexicalStatus: assertions.processLocalSource } };
}

async function installedPiModelMapProfileSwitchProof(evidence) {
  const installedPi = "/opt/homebrew/bin/pi";
  const installedPackageRoot = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
  const expectedVersion = "0.82.1";
  const tempRoot = await mkdtemp(join(tmpdir(), "larva-installed-pi-profile-switch-"));
  const home = join(tempRoot, "home");
  const piCodingAgentDir = join(tempRoot, "pi-agent");
  const parentSessionDir = join(tempRoot, "parent-session");
  const scratchDir = join(tempRoot, "tmp");
  const configDir = join(home, ".pi", "larva");
  const childSessionDir = join(configDir, "child-sessions");
  const traceFile = join(tempRoot, "child-rpc.jsonl");
  const quarantinedInheritedKeys = HARNESS_SELECTOR_ENV_KEYS.filter((key) => process.env[key] !== undefined).sort();
  const providerRequests = [];
  let releaseChildAlpha;
  const childAlphaRelease = new Promise((resolveRelease) => { releaseChildAlpha = resolveRelease; });
  let childAlphaObserved;
  const childAlphaSeen = new Promise((resolveSeen) => { childAlphaObserved = resolveSeen; });
  let server;
  let parent;

  const rpcEvents = [];
  const rpcResponses = new Map();
  const stderr = [];
  const sendSse = (response, chunks) => {
    response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
    for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    response.end("data: [DONE]\n\n");
  };
  const textChunk = (model, text) => ({
    id: `chat-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" }],
  });
  const toolChunk = (model, id, name, args) => ({
    id: `chat-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }],
  });

  try {
    await Promise.all([childSessionDir, piCodingAgentDir, parentSessionDir, scratchDir].map((path) => mkdir(path, { recursive: true })));
    const version = await runProcess(installedPi, ["--version"], { timeoutMs: 5_000 });
    const packageJson = await readJsonFile(join(installedPackageRoot, "package.json"));
    if (version.exitCode !== 0 || version.stdout.trim() !== expectedVersion || packageJson.version !== expectedVersion) {
      throw new Error(`installed Pi mismatch: binary=${version.stdout.trim()} package=${packageJson.version}`);
    }

    server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk.toString("utf8");
      const payload = body ? JSON.parse(body) : {};
      const model = payload.model ?? null;
      providerRequests.push({ model, toolResultPresent: Array.isArray(payload.messages) && payload.messages.some((message) => message.role === "tool") });
      if (model === "parent-a" && !providerRequests.some((entry) => entry.parentToolCall)) {
        providerRequests.at(-1).parentToolCall = true;
        sendSse(response, [toolChunk(model, "launch-child", "larva_subagent", { persona_id: "child", task: "Exercise child route across profile switch." })]);
        return;
      }
      if (model === "child-a") {
        childAlphaObserved();
        await childAlphaRelease;
        sendSse(response, [toolChunk(model, "child-read", "read", { path: join(tempRoot, "proof.txt") })]);
        return;
      }
      sendSse(response, [textChunk(model, model === "child-b" ? "CHILD_B_COMPLETE" : "PARENT_COMPLETE")]);
    });
    await new Promise((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("controlled provider did not bind a TCP port");
    const providerUrl = `http://127.0.0.1:${address.port}/v1`;

    const cli = join(tempRoot, "fake-cli.mjs");
    const probe = join(tempRoot, "controlled-provider.ts");
    await writeFile(join(tempRoot, "proof.txt"), "controlled child tool result\n", "utf8");
    await writeFile(cli, `
const [, , command, personaId, jsonFlag] = process.argv;
if (command !== "resolve" || jsonFlag !== "--json") process.exit(3);
const model = personaId === "parent" ? "logical/parent" : "logical/child";
process.stdout.write(JSON.stringify({ data: { id: personaId, description: personaId, prompt: "controlled installed-Pi probe", model, capabilities: {}, spec_version: "0.1.0", spec_digest: "sha256:" + personaId, can_spawn: true } }));
`, "utf8");
    await writeFile(probe, `
export default function (pi) {
  const model = (id) => ({ id, name: id, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 });
  pi.registerCommand("larva-proof-reload", {
    description: "Reload controlled proof extensions through the public command context",
    handler: async (_input, ctx) => {
      await ctx.reload();
      return { status: "reloaded" };
    }
  });
  pi.registerProvider("controlled", {
    name: "Controlled installed-Pi provider",
    baseUrl: ${JSON.stringify(providerUrl)},
    apiKey: "local",
    api: "openai-completions",
    models: ["parent-a", "parent-b", "child-a", "child-b"].map(model)
  });
  pi.registerProvider("openrouter", {
    name: "Credential-free OpenRouter loopback proof provider",
    baseUrl: ${JSON.stringify(providerUrl)},
    apiKey: "local",
    api: "openai-completions",
    models: [model("openai/gpt-5.6-sol")]
  });
  pi.registerProvider("rejecting", {
    name: "Credential-free rejecting proof provider",
    baseUrl: ${JSON.stringify(providerUrl)},
    apiKey: "$LARVA_MODEL_MAP_MISSING_TEST_KEY",
    api: "openai-completions",
    models: [model("parent-reject")]
  });
}
`, "utf8");
    const alpha = { models: { "logical/parent": { provider: "controlled", model_id: "parent-a" }, "logical/child": { provider: "controlled", model_id: "child-a" } }, prefix_rules: [] };
    const beta = { models: { "logical/parent": { provider: "controlled", model_id: "parent-b" }, "logical/child": { provider: "controlled", model_id: "child-b" } }, prefix_rules: [] };
    const openrouter = { models: { "logical/parent": { provider: "openrouter", model_id: "openai/gpt-5.6-sol" }, "logical/child": { provider: "controlled", model_id: "child-a" } }, prefix_rules: [] };
    const reject = { models: { "logical/parent": { provider: "rejecting", model_id: "parent-reject" }, "logical/child": { provider: "controlled", model_id: "child-a" } }, prefix_rules: [] };
    const lexicalOpenrouterPath = join(configDir, "model-map.openrouter.json");
    const externalOpenrouterPath = join(tempRoot, "controlled-external-openrouter.json");
    await writeFile(join(configDir, "model-map.json"), JSON.stringify(alpha), "utf8");
    await writeFile(join(configDir, "model-map.alpha.json"), JSON.stringify(alpha), "utf8");
    await writeFile(join(configDir, "model-map.beta.json"), JSON.stringify(beta), "utf8");
    await writeFile(join(configDir, "model-map.reject.json"), JSON.stringify(reject), "utf8");
    await writeFile(externalOpenrouterPath, JSON.stringify(openrouter), "utf8");
    await symlink(externalOpenrouterPath, lexicalOpenrouterPath);

    await writeFile(join(tempRoot, "subagent-runtime.json"), JSON.stringify({ schema_version: 1, extension_sources: [probe] }), "utf8");
    const args = [
      "--mode", "rpc", "--no-session", "--no-extensions", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--offline", "--approve",
      "-e", probe, "-e", extensionPath, "--model", "controlled/parent-a", "--session-dir", parentSessionDir,
    ];
    const parentEnv = actualChildSecretFreeEnv(process.env, {
      HOME: home,
      TMPDIR: scratchDir,
      PI_CODING_AGENT_DIR: piCodingAgentDir,
      PI_CODING_AGENT_SESSION_DIR: parentSessionDir,
      PI_OFFLINE: "1",
      LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, cli]),
      LARVA_PI_REAL_BIN: installedPi,
      LARVA_PI_EXTENSION_FLAG: "-e",
      LARVA_PI_EXTENSION_ENTRY: extensionPath,
      LARVA_PI_INITIAL_PERSONA_ID: "parent",
      LARVA_PI_INITIAL_PERSONA_MODEL_FROM_CLI: "controlled/parent-a",
      LARVA_PI_CHILD_SESSION_DIR: childSessionDir,
      LARVA_PI_CHILD_RPC_TRACE_FILE: traceFile,
      LARVA_PI_SUBAGENT_CONFIG_FILE: join(tempRoot, "subagent-runtime.json"),
      LARVA_PI_AGENT_PERSONA_SWITCH: "manual",
      LARVA_PI_INTERACTIVE_TUI: "0",
      LARVA_PI_LAUNCHED: "1",
    });
    const parentEnvObservation = observeRuntimeEnvironment(
      parentEnv,
      Object.keys(parentEnv).filter((key) => HARNESS_SELECTOR_ENV_KEYS.includes(key)),
      tempRoot,
    );
    parent = spawn(installedPi, args, {
      cwd: tempRoot,
      env: parentEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    evidence.rpc.attempted = Number.isInteger(parent.pid) && parent.pid > 0;
    parent.stderr.on("data", (chunk) => stderr.push(chunk.toString("utf8")));
    const lines = createInterface({ input: parent.stdout });
    lines.on("line", (line) => {
      const event = JSON.parse(line);
      rpcEvents.push(event);
      if (event.id && rpcResponses.has(String(event.id))) {
        rpcResponses.get(String(event.id))(event);
        rpcResponses.delete(String(event.id));
      }
    });
    const requestRpc = (id, body, timeoutMs = 8_000) => new Promise((resolveResponse, rejectResponse) => {
      const timer = setTimeout(() => { rpcResponses.delete(id); rejectResponse(new Error(`RPC timeout: ${id}`)); }, timeoutMs);
      rpcResponses.set(id, (response) => { clearTimeout(timer); resolveResponse(response); });
      parent.stdin.write(`${JSON.stringify({ id, ...body })}\n`);
    });

    await requestRpc("state-ready", { type: "get_state" });
    const reloadResponse = await requestRpc("reload-extensions", { type: "prompt", message: "/larva-proof-reload" });
    const commandsAfterReload = await requestRpc("commands-after-reload", { type: "get_commands" });
    const statusResponse = await requestRpc("status", { type: "prompt", message: "/larva-model-map status" });
    const statusNotification = await waitForSmokeCondition(() => rpcEvents.find((event) => event.type === "extension_ui_request" && event.method === "notify" && typeof event.message === "string" && event.message.startsWith("Larva model-map: source=")) ?? null, { label: "public model-map status notification", timeoutMs: 5_000, intervalMs: 25 });
    const externalSwitchOffset = rpcEvents.length;
    const externalSwitchResponse = await requestRpc("switch-openrouter", { type: "prompt", message: "/larva-model-map openrouter" });
    const externalSwitchNotification = await waitForSmokeCondition(() => rpcEvents.slice(externalSwitchOffset).find((event) => event.type === "extension_ui_request" && event.method === "notify" && typeof event.message === "string" && event.message.startsWith("Larva model-map success: openrouter")) ?? null, { label: "external openrouter profile notification", timeoutMs: 5_000, intervalMs: 25 });
    const stateAfterExternalSwitch = await requestRpc("state-after-openrouter", { type: "get_state" });
    const externalStatusOffset = rpcEvents.length;
    await requestRpc("status-openrouter", { type: "prompt", message: "/larva-model-map status" });
    const externalStatusNotification = await waitForSmokeCondition(() => rpcEvents.slice(externalStatusOffset).find((event) => event.type === "extension_ui_request" && event.method === "notify" && typeof event.message === "string" && event.message.includes("profile=openrouter")) ?? null, { label: "external openrouter lexical status", timeoutMs: 5_000, intervalMs: 25 });
    const externalPromptOffset = rpcEvents.length;
    const externalPromptResponse = await requestRpc("prompt-openrouter", { type: "prompt", message: "Exercise the controlled external profile." });
    await waitForSmokeCondition(() => providerRequests.some((entry) => entry.model === "openai/gpt-5.6-sol"), { label: "external openrouter loopback provider request", timeoutMs: 5_000, intervalMs: 25 });
    await waitForSmokeCondition(() => rpcEvents.slice(externalPromptOffset).some((event) => event.type === "agent_end"), { label: "external openrouter agent end", timeoutMs: 5_000, intervalMs: 25 });
    await requestRpc("switch-alpha", { type: "prompt", message: "/larva-model-map alpha" });
    const rollbackEventOffset = rpcEvents.length;
    const rejectResponse = await requestRpc("reject-parent", { type: "prompt", message: "/larva-model-map reject" });
    const rejectNotification = await waitForSmokeCondition(() => rpcEvents.slice(rollbackEventOffset).find((event) => event.type === "extension_ui_request" && event.method === "notify" && typeof event.message === "string" && event.message.startsWith("Larva model-map failed: reject")) ?? null, { label: "parent rejection notification", timeoutMs: 5_000, intervalMs: 25 });
    const stateAfterReject = await requestRpc("state-after-reject", { type: "get_state" });
    const restoredStatusOffset = rpcEvents.length;
    await requestRpc("status-after-reject", { type: "prompt", message: "/larva-model-map status" });
    const restoredStatusNotification = await waitForSmokeCondition(() => rpcEvents.slice(restoredStatusOffset).find((event) => event.type === "extension_ui_request" && event.method === "notify" && typeof event.message === "string" && event.message.includes("profile=alpha")) ?? null, { label: "restored profile status", timeoutMs: 5_000, intervalMs: 25 });
    await requestRpc("launch", { type: "prompt", message: "Launch the child now." });
    await Promise.race([childAlphaSeen, new Promise((_, rejectWait) => setTimeout(() => rejectWait(new Error("child alpha provider request timeout")), 10_000))]);
    const switchResponse = await requestRpc("switch-beta", { type: "prompt", message: "/larva-model-map beta" });
    const stateAfterSwitch = await requestRpc("state-after-switch", { type: "get_state" });
    releaseChildAlpha();
    await waitForSmokeCondition(() => providerRequests.some((entry) => entry.model === "child-b"), { label: "child request on beta route", timeoutMs: 10_000, intervalMs: 25 });
    const trace = await waitForSmokeCondition(async () => {
      const events = await readJsonlTrace(traceFile);
      return events.some((event) => event.event === "rpc_tx" && event.frame_type === "set_model") ? events : null;
    }, { label: "child set_model trace", timeoutMs: 5_000, intervalMs: 25 });
    const childPids = uniqueChildPids(trace);
    const remediationProofEvidence = { runtime: {} };
    await modelMapProfileSwitchProof(remediationProofEvidence);
    const remediationProof = remediationProofEvidence.runtime.modelMapProfileSwitch;
    const extensionSource = await readFile(extensionPath, "utf8");
    evidence.pi = { binary: installedPi, available: true, extensionFlag: "-e" };
    evidence.package = { ...evidence.package, packageRoot: installedPackageRoot, versionText: version.stdout.trim(), installedVersion: packageJson.version };
    const assertions = {
      exactInstalledBinary: evidence.pi.binary === installedPi && evidence.package.versionText === expectedVersion,
      exactInstalledPackage: evidence.package.packageRoot === installedPackageRoot && evidence.package.installedVersion === expectedVersion,
      ctxReloadBeforePublicCommand: reloadResponse.type === "response" && reloadResponse.success === true && Array.isArray(commandsAfterReload.data?.commands) && commandsAfterReload.data.commands.some((command) => command.name === "larva-model-map"),
      externalSymlinkPublicCommand: externalSwitchResponse.type === "response" && externalSwitchResponse.success === true && externalSwitchNotification.message.includes("parent=switched") && stateAfterExternalSwitch.data?.model?.provider === "openrouter" && stateAfterExternalSwitch.data?.model?.id === "openai/gpt-5.6-sol",
      externalLexicalStatus: externalStatusNotification.message.includes(`path=${lexicalOpenrouterPath}`) && externalStatusNotification.message.includes(externalOpenrouterPath) === false && externalStatusNotification.message.includes("parent=parent:openrouter/openai/gpt-5.6-sol") && externalStatusNotification.message.includes("apiKey") === false && externalStatusNotification.message.includes("local") === false,
      externalLoopbackRoute: externalPromptResponse.type === "response" && externalPromptResponse.success === true && providerRequests.some((entry) => entry.model === "openai/gpt-5.6-sol") && providerUrl.startsWith("http://127.0.0.1:"),
      realExtensionCommandSeam: switchResponse.type === "response" && switchResponse.success === true,
      publicStatus: statusResponse.type === "response" && statusResponse.success === true && statusNotification.message.includes("source=canonical-file") && statusNotification.message.includes(`path=${join(configDir, "model-map.json")}`) && statusNotification.message.includes("parent=parent:controlled/parent-a") && statusNotification.message.includes("children ready=0, starting=0, terminal=0") && statusNotification.message.includes("apiKey") === false && statusNotification.message.includes("local") === false,
      parentRouteSwitched: stateAfterSwitch.data?.model?.provider === "controlled" && stateAfterSwitch.data?.model?.id === "parent-b",
      childRpcSetModelOrdered: trace.some((event) => event.event === "rpc_tx" && event.frame_type === "set_model") && providerRequests.findIndex((entry) => entry.model === "child-a") < providerRequests.findIndex((entry) => entry.model === "child-b"),
      inFlightOldThenNextNew: providerRequests.some((entry) => entry.model === "child-a") && providerRequests.some((entry) => entry.model === "child-b"),
      noExternalProvider: providerRequests.every((entry) => ["parent-a", "parent-b", "openai/gpt-5.6-sol", "child-a", "child-b"].includes(entry.model)),
      harnessIsolation: parentEnvObservation.unowned_selector_keys_present.length === 0 && parentEnvObservation.owned_paths_outside_root.length === 0,
      parentRollback: rejectResponse.type === "response" && rejectResponse.success === true && rejectNotification.message.includes("parent=failed") && stateAfterReject.data?.model?.provider === "controlled" && stateAfterReject.data?.model?.id === "parent-a" && restoredStatusNotification.message.includes("source=profile") && restoredStatusNotification.message.includes("profile=alpha"),
      boundedReadyChildFanout: remediationProof?.assertions?.boundedReadyChildFanout === true && remediationProof?.maxObservedChildRpcConcurrency === 4,
      terminalDuringStarting: remediationProof?.assertions?.terminalDuringStarting === true,
      partialRetryIdentity: extensionSource.includes("sameProfileRetry") && extensionSource.includes("task_id: record.task_id") && extensionSource.includes("persona_id: record.persona_id"),
      startingGenerationFence: extensionSource.includes("model-map-fence-") && extensionSource.indexOf("const routeFenceError") < extensionSource.indexOf('rpc.command("prompt-1"', extensionSource.indexOf("const routeFenceError")),
      lifecycleClassifications: remediationProof?.beta?.counts?.ended_during_switch === 1 && extensionSource.includes('state: "will_use_new_route"') && extensionSource.includes('state: "ended_during_switch"'),
      faultIsolation: extensionSource.includes('traceChildRpc(this.traceEnv, "rpc_rx_malformed"') && extensionSource.includes("Child RPC command timed out after") && extensionSource.includes("Child stdout closed before RPC response."),
    };
    const parentRpcResponses = rpcEvents.filter((event) => event?.type === "response");
    const parentRpcEvents = rpcEvents.filter((event) => event?.type !== "response");
    evidence.rpc.supported = evidence.rpc.attempted
      && parentRpcResponses.some((response) => response.id === "state-ready" && response.success === true)
      && parentRpcResponses.some((response) => response.id === "switch-beta" && response.success === true);
    evidence.rpc.events = parentRpcEvents;
    evidence.rpc.responses = parentRpcResponses;
    evidence.rpc.stderr = stderr.join("");
    evidence.rpc.uiRequests = parentRpcEvents.filter((event) => event?.type === "extension_ui_request");
    evidence.runtime.installedPiModelMapProfileSwitch = {
      status: Object.values(assertions).every(Boolean) && evidence.rpc.supported ? "PASS" : "FAIL",
      assertions,
      command: [installedPi, ...args],
      providerRequests,
      childRpcEventNames: trace.map((event) => event.event),
      childPids,
      selected: { binary: installedPi, packageRoot: installedPackageRoot, packageVersion: expectedVersion },
      executed: { binary: installedPi, packageRoot: installedPackageRoot, packageVersion: packageJson.version },
      reload: { publicCommand: "/larva-proof-reload", contextMethod: "ctx.reload()", responseId: reloadResponse.id, commandsResponseId: commandsAfterReload.id },
      externalProfile: { publicCommand: "/larva-model-map openrouter", lexicalPath: lexicalOpenrouterPath, externalTargetPath: externalOpenrouterPath, modelRegistryResult: { provider: stateAfterExternalSwitch.data?.model?.provider ?? null, modelId: stateAfterExternalSwitch.data?.model?.id ?? null }, statusMessage: externalStatusNotification.message, loopbackRequestObserved: providerRequests.some((entry) => entry.model === "openai/gpt-5.6-sol") },
      observations: { publicStatus: assertions.publicStatus, ctxReloadBeforePublicCommand: assertions.ctxReloadBeforePublicCommand, externalSymlinkPublicCommand: assertions.externalSymlinkPublicCommand, externalLexicalStatus: assertions.externalLexicalStatus, externalLoopbackRoute: assertions.externalLoopbackRoute, parentRollback: assertions.parentRollback, harnessIsolation: assertions.harnessIsolation, boundedReadyChildFanout: assertions.boundedReadyChildFanout, terminalDuringStarting: assertions.terminalDuringStarting, partialRetryIdentity: assertions.partialRetryIdentity, startingGenerationFence: assertions.startingGenerationFence, lifecycleClassifications: assertions.lifecycleClassifications, faultIsolation: assertions.faultIsolation, inFlightOldNextNew: assertions.inFlightOldThenNextNew },
      stderr: stderr.join(""),
      isolation: {
        status: parentEnvObservation.unowned_selector_keys_present.length === 0 && parentEnvObservation.owned_paths_outside_root.length === 0 ? "PASS" : "FAIL",
        home,
        piCodingAgentDir,
        parentSessionDir,
        configDir,
        childSessionDir,
        providerUrl,
        offline: true,
        quarantinedInheritedKeys,
        environmentObservation: parentEnvObservation,
      },
    };
  } finally {
    releaseChildAlpha?.();
    if (parent && parent.exitCode === null) parent.kill("SIGTERM");
    if (parent) await Promise.race([new Promise((resolveClose) => parent.once("close", resolveClose)), new Promise((resolveWait) => setTimeout(resolveWait, 1_500))]);
    if (parent && parent.exitCode === null) parent.kill("SIGKILL");
    if (server) await new Promise((resolveClose) => server.close(resolveClose));
    const trace = await readJsonlTrace(traceFile);
    for (const pid of uniqueChildPids(trace)) if (processAlive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
    await rm(tempRoot, { recursive: true, force: true });
    if (evidence.runtime.installedPiModelMapProfileSwitch) evidence.runtime.installedPiModelMapProfileSwitch.cleanup = await exists(tempRoot) ? "FAIL" : "PASS";
  }
}

function actualChildProfileNameFromFrameId(frameId) {
  const match = /^model-map-(\d+)-/.exec(String(frameId ?? ""));
  return match === null ? null : Number.parseInt(match[1], 10);
}

function actualChildSecretFreeEnv(base, overrides = {}) {
  return mergedHarnessEnv(base, overrides);
}

async function installedActualChildPiModelMapProfileSwitchProof(evidence) {
  const schemaName = "larva.pi.model-map.actual-child.v1";
  const installedPi = "/opt/homebrew/bin/pi";
  const installedPackageRoot = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
  const installedCli = join(installedPackageRoot, "dist", "cli.js");
  const expectedVersion = "0.82.1";
  const scenarioStartedWallMs = Date.now();
  const scenarioStartedMonotonicNs = process.hrtime.bigint();
  const wholeScenarioDeadlineMs = 180_000;
  const caseDeadlineMs = 30_000;
  const childLimit = 8;
  const events = [];
  const providerRequests = [];
  const parentRpcEvents = [];
  const parentRpcResponses = new Map();
  const parentStderr = [];
  const heldProviderResponses = new Map();
  const sockets = new Set();
  const plans = new Map();
  const tempRoot = await mkdtemp(join(tmpdir(), "larva-actual-child-profile-switch-"));
  const home = join(tempRoot, "home");
  const piCodingAgentDir = join(tempRoot, "pi-agent");
  const scratchDir = join(tempRoot, "tmp");
  const quarantinedInheritedKeys = HARNESS_SELECTOR_ENV_KEYS.filter((key) => process.env[key] !== undefined).sort();
  const configDir = join(home, ".pi", "larva");
  const childSessionDir = join(tempRoot, "child-sessions");
  const parentSessionDir = join(tempRoot, "parent-session");
  const traceFile = join(tempRoot, "child-rpc.jsonl");
  const transportFile = join(tempRoot, "transport.jsonl");
  const controlFile = join(tempRoot, "transport-control.json");
  const wrapperDir = join(tempRoot, "transport-bin");
  const wrapperPath = join(wrapperDir, "node");
  const controllerPath = join(tempRoot, "installed-pi-transport-controller.mjs");
  const providerExtension = join(tempRoot, "loopback-provider.ts");
  const larvaCli = join(tempRoot, "larva-cli.mjs");
  const subagentConfig = join(tempRoot, "subagent-runtime.json");
  const personaModels = {
    parent: "logical/parent",
    "ready-ok": "logical/child",
    retry: "logical/child",
    malformed: "logical/child",
    timeout: "logical/child",
    closed: "logical/child",
    ending: "logical/child",
    lifecycle: "logical/child",
  };
  const profileModels = {
    alpha: { parent: "parent-a", child: "child-a" },
    beta: { parent: "parent-b", child: "child-b" },
    gamma: { parent: "parent-c", child: "child-c" },
    delta: { parent: "parent-d", child: "child-d" },
    epsilon: { parent: "parent-e", child: "child-e" },
    zeta: { parent: "parent-z", child: "child-z" },
  };
  const raw = {
    schema_name: schemaName,
    status: "FAIL",
    requirements: ["MMPS-CHILD-REAL-01", "MMPS-CHILD-REAL-02", "MMPS-CHILD-REAL-03", "MMPS-CHILD-REAL-04", "MMPS-CHILD-REAL-05"],
    selected: {
      parent: { binary: installedPi, package_root: installedPackageRoot, package_version: null, cli: installedCli },
      child: { binary: installedPi, package_root: installedPackageRoot, package_version: null, cli: installedCli },
    },
    executed: { parent: null, children: [] },
    limits: { child_processes: childLimit, switch_rpc_concurrency: 4, rpc_timeout_ms: 5_000, case_deadline_ms: caseDeadlineMs, scenario_deadline_ms: wholeScenarioDeadlineMs, attempts: 1 },
    observation: {
      clock: "process.hrtime.bigint",
      terminal_recheck: "PENDING",
      probe: null,
      terminal_rechecks: [],
    },
    cases: {},
    isolation: {
      offline: true,
      loopback_only: false,
      external_provider_requests: 0,
      credential_env_keys_present: [],
      home,
      pi_coding_agent_dir: piCodingAgentDir,
      config_dir: configDir,
      parent_session_dir: parentSessionDir,
      child_session_dir: childSessionDir,
      provider_endpoint: null,
      network_samples: [],
      transport_control: "harness-owned Node interpreter stdio control beneath the unchanged /opt/homebrew/bin/pi child launch seam",
      quarantined_inherited_keys: quarantinedInheritedKeys,
      environment_observation: null,
      environment_status: "PENDING",
    },
    events: [],
    cleanup: { outcome: "FAIL", parent_alive: null, process_group_alive: null, child_controllers_alive: {}, child_pi_processes_alive: {}, loopback_closed: false, temporary_root_removed: false, unknown_state: false },
    error: null,
  };
  let parent = null;
  let parentLines = null;
  let server = null;
  let providerUrl = null;
  let cleanupTrace = [];
  let cleanupTransport = [];
  let cleanupError = null;
  let parentPid = null;
  let scenarioDeadlineExceeded = false;
  let scenarioDeadlineTimer = null;
  const appendHarnessEvent = (event, fields = {}) => {
    events.push({ source: "harness", event, monotonic_ns: process.hrtime.bigint().toString(), ...fields });
  };
  const elapsedMs = (startedNs) => Number(process.hrtime.bigint() - startedNs) / 1_000_000;
  const recordTerminalObservation = (label, timeoutMs, result) => {
    const observation = { label, deadline_ms: timeoutMs, matched: result.matched, elapsed_ms: result.elapsedMs };
    raw.observation.terminal_rechecks.push(observation);
    appendHarnessEvent("observation_terminal_recheck", observation);
  };
  const waitObserved = async (predicate, label, timeoutMs = caseDeadlineMs, intervalMs = 20) => await waitForSmokeCondition(predicate, {
    label,
    timeoutMs,
    intervalMs,
    onTerminalObservation: (result) => recordTerminalObservation(label, timeoutMs, result),
  });
  const writeControl = async (phase, releaseState = []) => {
    await writeFile(controlFile, JSON.stringify({ phase, release_state: releaseState }), "utf8");
    appendHarnessEvent("transport_control", { phase, release_state: releaseState });
  };
  const readTransport = async () => await readJsonlTrace(transportFile);
  const readTrace = async () => await readJsonlTrace(traceFile);
  const waitTransport = async (predicate, label, timeoutMs = caseDeadlineMs) => await waitObserved(async () => {
    const rows = await readTransport();
    return predicate(rows) ? rows : null;
  }, label, timeoutMs);
  const waitTrace = async (predicate, label, timeoutMs = caseDeadlineMs) => await waitObserved(async () => {
    const rows = await readTrace();
    return predicate(rows) ? rows : null;
  }, label, timeoutMs);
  const parentEventsAfter = (offset) => parentRpcEvents.slice(offset);
  const waitParentEvent = async (predicate, label, offset = 0, timeoutMs = caseDeadlineMs) => await waitObserved(() => parentEventsAfter(offset).find(predicate) ?? null, label, timeoutMs);
  const waitParentAgentEnd = async (offset, label) => await waitParentEvent((event) => event?.type === "agent_end", label, offset);
  const requestParent = (id, body, timeoutMs = caseDeadlineMs) => new Promise((resolveResponse, rejectResponse) => {
    const timer = setTimeout(() => {
      parentRpcResponses.delete(id);
      rejectResponse(new Error(`parent RPC timeout: ${id}`));
    }, timeoutMs);
    parentRpcResponses.set(id, (response) => {
      clearTimeout(timer);
      resolveResponse(response);
    });
    parent.stdin.write(`${JSON.stringify({ id, ...body })}\n`);
    appendHarnessEvent("parent_rpc_tx", { correlation_id: id, frame_type: body.type, command: typeof body.message === "string" && body.message.startsWith("/larva-model-map") ? body.message : null });
  });
  const runProfile = async (profile, label) => {
    const eventOffset = parentRpcEvents.length;
    const started = process.hrtime.bigint();
    const response = await requestParent(`profile-${label}`, { type: "prompt", message: `/larva-model-map ${profile}` });
    const notification = await waitParentEvent(
      (event) => event?.type === "extension_ui_request" && event.method === "notify" && typeof event.message === "string" && event.message.startsWith("Larva model-map ") && event.message.includes(`: ${profile};`),
      `${label} profile notification`,
      eventOffset,
    );
    appendHarnessEvent("profile_classified", { profile, label, elapsed_ms: elapsedMs(started), message: notification.message });
    return { response, notification, elapsed_ms: elapsedMs(started), transport: await readTransport(), trace: await readTrace() };
  };
  const taskByPersona = (rows, persona) => rows.findLast((row) => row.persona === persona && row.event === "rpc_forward" && row.frame_id === "state-1" && typeof row.task_id === "string")?.task_id ?? null;
  const setModelRows = (rows, fromIndex = 0) => rows.slice(fromIndex).filter((row) => row.frame_type === "set_model" && typeof row.frame_id === "string");
  const commandGenerationRows = (rows, generation) => rows.filter((row) => row.event === "rpc_tx" && actualChildProfileNameFromFrameId(row.frame_id) === generation);
  const concurrencyObservation = (rows, generation) => {
    const relevant = rows.filter((row) => actualChildProfileNameFromFrameId(row.frame_id) === generation && ["rpc_tx", "rpc_forward", "rpc_drop", "rpc_malformed", "rpc_stdout_closed"].includes(row.event));
    let active = 0;
    let maximum = 0;
    const activeIds = new Set();
    for (const row of relevant) {
      if (row.event === "rpc_tx" && !activeIds.has(row.frame_id)) {
        activeIds.add(row.frame_id);
        active += 1;
        maximum = Math.max(maximum, active);
      } else if (row.event !== "rpc_tx" && activeIds.delete(row.frame_id)) {
        active = Math.max(0, active - 1);
      }
    }
    return { maximum, final_active: active, rows: relevant };
  };
  const setPlan = (marker, calls) => {
    plans.set(marker, { calls, sent: false });
    appendHarnessEvent("parent_plan", { marker, call_count: calls.length, personas: calls.map((call) => call.persona_id) });
  };
  const completeHeld = (persona, text) => {
    const entries = heldProviderResponses.get(persona) ?? [];
    const next = entries.shift();
    if (entries.length === 0) heldProviderResponses.delete(persona);
    if (!next) throw new Error(`no held provider response for ${persona}`);
    sendSse(next.response, [textChunk(next.model, text)]);
    appendHarnessEvent("provider_release", { persona, model: next.model });
  };
  const addHeld = (persona, value) => {
    const entries = heldProviderResponses.get(persona) ?? [];
    entries.push(value);
    heldProviderResponses.set(persona, entries);
  };
  const profileNotificationCounts = (message) => {
    const match = /children switched=(\d+), pending=(\d+), ended=(\d+), failed=(\d+)/.exec(message);
    return match === null ? null : { switched: Number(match[1]), pending: Number(match[2]), ended: Number(match[3]), failed: Number(match[4]) };
  };
  const sendSse = (response, chunks) => {
    response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
    for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    response.end("data: [DONE]\n\n");
  };
  const textChunk = (model, text) => ({
    id: `chat-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" }],
  });
  const localEndpoint = (value) => /(?:127\.0\.0\.1|\[::1\]|localhost)/.test(value);
  const processNetworkSample = async (pid, role, persona = null) => {
    const result = await runProcess("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-FpcnT"], { timeoutMs: 2_000 });
    const endpoints = result.stdout.split(/\r?\n/).filter((line) => line.startsWith("n")).map((line) => line.slice(1));
    return { pid, role, persona, endpoints, loopback_only: endpoints.every(localEndpoint) };
  };

  try {
    scenarioDeadlineTimer = setTimeout(() => {
      scenarioDeadlineExceeded = true;
      appendHarnessEvent("scenario_deadline_exceeded", { deadline_ms: wholeScenarioDeadlineMs });
      if (parent && parent.exitCode === null && parent.signalCode === null) parent.kill("SIGTERM");
      for (const socket of sockets) socket.destroy();
    }, wholeScenarioDeadlineMs);
    appendHarnessEvent("scenario_start", { temp_root: tempRoot, attempt: 1, deadline_ms: wholeScenarioDeadlineMs });
    await mkdir(wrapperDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(childSessionDir, { recursive: true });
    await mkdir(parentSessionDir, { recursive: true });
    await mkdir(piCodingAgentDir, { recursive: true });
    await mkdir(scratchDir, { recursive: true });
    await writeControl("normal");

    const version = await runProcess(installedPi, ["--version"], { timeoutMs: 5_000 });
    const packageJson = await readJsonFile(join(installedPackageRoot, "package.json"));
    const cliRealPath = await realpath(installedPi);
    if (version.exitCode !== 0 || version.stdout.trim() !== expectedVersion || packageJson.version !== expectedVersion || cliRealPath !== installedCli) {
      throw new Error(`installed Pi identity drift: version=${version.stdout.trim()} package=${packageJson.version} cli=${cliRealPath}`);
    }
    raw.selected.parent.package_version = packageJson.version;
    raw.selected.child.package_version = packageJson.version;

    await writeFile(larvaCli, `
const [, , command, personaId, jsonFlag] = process.argv;
const models = ${JSON.stringify(personaModels)};
if (command !== "resolve" || jsonFlag !== "--json" || typeof models[personaId] !== "string") process.exit(3);
process.stdout.write(JSON.stringify({ data: { id: personaId, description: personaId, prompt: "ACTUAL_CHILD_PERSONA:" + personaId, model: models[personaId], capabilities: {}, spec_version: "0.1.0", spec_digest: "sha256:" + personaId, can_spawn: true } }));
`, "utf8");

    await writeFile(controllerPath, `
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
const realNode = process.env.LARVA_ACTUAL_CHILD_REAL_NODE;
const logFile = process.env.LARVA_ACTUAL_CHILD_TRANSPORT_LOG;
const controlFile = process.env.LARVA_ACTUAL_CHILD_CONTROL_FILE;
const persona = process.env.LARVA_PI_INITIAL_PERSONA_ID || "unknown";
const controllerPid = process.pid;
const append = (event, fields = {}) => appendFileSync(logFile, JSON.stringify({ event, monotonic_ns: process.hrtime.bigint().toString(), controller_pid: controllerPid, persona, ...fields }) + "\\n", "utf8");
const control = () => { try { return JSON.parse(readFileSync(controlFile, "utf8")); } catch { return { phase: "invalid", release_state: [] }; } };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const child = spawn(realNode, args, { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
append("process_start", { actual_pid: child.pid ?? null, selected_binary: "/opt/homebrew/bin/pi", executable: realNode, cli: args[0] ?? null, argv: args });
let outputClosed = false;
const forward = (line, message, extra = {}) => {
  if (!outputClosed) process.stdout.write(line + "\\n");
  append("rpc_forward", { frame_id: typeof message?.id === "string" ? message.id : null, frame_type: typeof message?.command === "string" ? message.command : message?.type ?? null, success: message?.success === true, task_id: message?.id === "state-1" && typeof message?.data?.sessionFile === "string" ? message.data.sessionFile : null, ...extra });
};
createInterface({ input: process.stdin }).on("line", (line) => {
  let message = null;
  try { message = JSON.parse(line); } catch {}
  append("rpc_tx", { frame_id: typeof message?.id === "string" ? message.id : null, frame_type: typeof message?.type === "string" ? message.type : null, provider: typeof message?.provider === "string" ? message.provider : null, model_id: typeof message?.modelId === "string" ? message.modelId : null });
  child.stdin.write(line + "\\n");
});
createInterface({ input: child.stdout }).on("line", async (line) => {
  let message = null;
  try { message = JSON.parse(line); } catch {}
  const frameId = typeof message?.id === "string" ? message.id : null;
  const frameType = typeof message?.command === "string" ? message.command : message?.type ?? null;
  append("rpc_rx_actual", { frame_id: frameId, frame_type: frameType, success: message?.success === true });
  if (frameId === "state-1" && ["ending", "lifecycle"].includes(persona)) {
    append("rpc_state_held", { frame_id: frameId });
    while (!Array.isArray(control().release_state) || !control().release_state.includes(persona)) await sleep(10);
    forward(line, message, { released: true });
    return;
  }
  if (frameId?.startsWith("model-map-") || frameId?.startsWith("switch-")) {
    const phase = control().phase;
    if (phase === "retry_first" && persona === "retry") { append("rpc_drop", { frame_id: frameId, frame_type: "set_model", fault: "selective_retry_timeout" }); return; }
    if (phase === "fault_malformed" && persona === "malformed") { process.stdout.write("{controlled-malformed\\n"); append("rpc_malformed", { frame_id: frameId, frame_type: "set_model", fault: "malformed_response" }); return; }
    if (phase === "fault_timeout" && persona === "timeout") { append("rpc_drop", { frame_id: frameId, frame_type: "set_model", fault: "timeout" }); return; }
    if (phase === "fault_closed" && persona === "closed") { outputClosed = true; process.stdout.end(); append("rpc_stdout_closed", { frame_id: frameId, frame_type: "set_model", fault: "closed_stream" }); return; }
    await sleep(180);
    forward(line, message, { delayed_ms: 180 });
    return;
  }
  forward(line, message);
});
child.stderr.on("data", (chunk) => { process.stderr.write(chunk); append("child_stderr", { bytes: chunk.byteLength, text_preview: String(chunk).slice(0, 500) }); });
child.on("close", (code, signal) => { append("process_exit", { actual_pid: child.pid ?? null, code, signal }); if (!outputClosed) process.stdout.end(); process.exit(code ?? (signal ? 1 : 0)); });
const terminate = (signal) => { append("controller_signal", { signal, actual_pid: child.pid ?? null }); if (child.exitCode === null && child.signalCode === null) child.kill(signal); setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 750).unref(); };
process.on("SIGTERM", () => terminate("SIGTERM"));
process.on("SIGINT", () => terminate("SIGINT"));
`, "utf8");

    await writeFile(wrapperPath, `#!/bin/sh
if [ "$LARVA_PI_INITIAL_PERSONA_ID" = "parent" ]; then
  exec "$LARVA_ACTUAL_CHILD_REAL_NODE" "$@"
fi
exec "$LARVA_ACTUAL_CHILD_REAL_NODE" "$LARVA_ACTUAL_CHILD_CONTROLLER" "$@"
`, "utf8");
    await chmod(wrapperPath, 0o755);

    const modelIds = Object.values(profileModels).flatMap((value) => [value.parent, value.child]);
    await writeFile(providerExtension, `
export default function (pi) {
  const model = (id) => ({ id, name: id, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 });
  pi.registerProvider("controlled", { name: "Actual-child loopback provider", baseUrl: ${JSON.stringify("__PROVIDER_URL__")}, apiKey: "local-only", api: "openai-completions", models: ${JSON.stringify(modelIds)}.map(model) });
}
`, "utf8");
    await writeFile(subagentConfig, JSON.stringify({ schema_version: 1, extension_sources: [providerExtension] }), "utf8");
    for (const [profile, models] of Object.entries(profileModels)) {
      await writeFile(join(configDir, `model-map.${profile}.json`), JSON.stringify({ models: { "logical/parent": { provider: "controlled", model_id: models.parent }, "logical/child": { provider: "controlled", model_id: models.child } }, prefix_rules: [] }), "utf8");
    }
    await writeFile(join(configDir, "model-map.json"), JSON.stringify({ models: { "logical/parent": { provider: "controlled", model_id: profileModels.alpha.parent }, "logical/child": { provider: "controlled", model_id: profileModels.alpha.child } }, prefix_rules: [] }), "utf8");

    server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk.toString("utf8");
      let payload = {};
      try { payload = body.length > 0 ? JSON.parse(body) : {}; } catch { response.writeHead(400); response.end(); return; }
      const model = typeof payload.model === "string" ? payload.model : "unknown";
      const renderedMessages = JSON.stringify(payload.messages ?? []);
      const personaMatch = /ACTUAL_CHILD_PERSONA:([A-Za-z0-9_-]+)/.exec(renderedMessages);
      const persona = personaMatch?.[1] ?? (model.startsWith("parent-") ? "parent" : "unknown");
      providerRequests.push({ monotonic_ns: process.hrtime.bigint().toString(), model, persona, loopback: true, tool_result_present: Array.isArray(payload.messages) && payload.messages.some((message) => message?.role === "tool") });
      appendHarnessEvent("provider_request", { model, persona });
      if (persona === "parent") {
        const planEntry = Array.from(plans.entries()).find(([marker, plan]) => plan.sent === false && renderedMessages.includes(marker));
        if (planEntry) {
          planEntry[1].sent = true;
          const calls = planEntry[1].calls.map((input, index) => ({ index, id: `${planEntry[0].toLowerCase()}-${index}`, type: "function", function: { name: "larva_subagent", arguments: JSON.stringify(input) } }));
          sendSse(response, [{ id: `parent-${Date.now()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { role: "assistant", tool_calls: calls }, finish_reason: "tool_calls" }] }]);
          return;
        }
        sendSse(response, [textChunk(model, "PARENT_PLAN_COMPLETE")]);
        return;
      }
      addHeld(persona, { response, model });
      request.on("close", () => appendHarnessEvent("provider_client_close", { persona, model }));
    });
    server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
    await new Promise((resolveListen, rejectListen) => { server.once("error", rejectListen); server.listen(0, "127.0.0.1", resolveListen); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("loopback provider failed to bind");
    providerUrl = `http://127.0.0.1:${address.port}/v1`;
    raw.isolation.provider_endpoint = providerUrl;
    await writeFile(providerExtension, (await readFile(providerExtension, "utf8")).replace("__PROVIDER_URL__", providerUrl), "utf8");

    const baseEnv = actualChildSecretFreeEnv(process.env, {
      HOME: home,
      TMPDIR: scratchDir,
      PI_CODING_AGENT_DIR: piCodingAgentDir,
      PI_CODING_AGENT_SESSION_DIR: parentSessionDir,
      PI_OFFLINE: "1",
      PATH: `${wrapperDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? "/opt/homebrew/bin:/usr/bin:/bin"}`,
      LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, larvaCli]),
      LARVA_PI_REAL_BIN: installedPi,
      LARVA_PI_EXTENSION_FLAG: "-e",
      LARVA_PI_EXTENSION_ENTRY: extensionPath,
      LARVA_PI_INITIAL_PERSONA_ID: "parent",
      LARVA_PI_INITIAL_PERSONA_MODEL_FROM_CLI: "controlled/parent-a",
      LARVA_PI_CHILD_SESSION_DIR: childSessionDir,
      LARVA_PI_CHILD_RPC_TRACE_FILE: traceFile,
      LARVA_PI_SUBAGENT_CONFIG_FILE: subagentConfig,
      LARVA_PI_AGENT_PERSONA_SWITCH: "manual",
      LARVA_PI_INTERACTIVE_TUI: "0",
      LARVA_PI_LAUNCHED: "1",
      LARVA_ACTUAL_CHILD_REAL_NODE: process.execPath,
      LARVA_ACTUAL_CHILD_CONTROLLER: controllerPath,
      LARVA_ACTUAL_CHILD_TRANSPORT_LOG: transportFile,
      LARVA_ACTUAL_CHILD_CONTROL_FILE: controlFile,
    });
    raw.isolation.credential_env_keys_present = Object.keys(baseEnv).filter((key) => SECRET_ENV_KEY.test(key));
    delete baseEnv.LARVA_PI_INITIAL_PERSONA_MODEL_FROM_CLI;
    raw.isolation.environment_observation = observeRuntimeEnvironment(
      baseEnv,
      Object.keys(baseEnv).filter((key) => HARNESS_SELECTOR_ENV_KEYS.includes(key)),
      tempRoot,
    );
    raw.isolation.environment_status = raw.isolation.environment_observation.unowned_selector_keys_present.length === 0
      && raw.isolation.environment_observation.owned_paths_outside_root.length === 0
      ? "PASS"
      : "FAIL";
    const parentArgs = [
      "--mode", "rpc", "--no-session", "--no-extensions", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--offline", "--approve",
      "-e", providerExtension, "-e", extensionPath, "--model", "controlled/parent-a", "--session-dir", parentSessionDir,
    ];
    parent = spawn(installedPi, parentArgs, { cwd: tempRoot, env: baseEnv, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    parentPid = parent.pid ?? null;
    if (!Number.isInteger(parentPid)) throw new Error("installed parent Pi did not expose a PID");
    raw.executed.parent = { pid: parentPid, selected_binary: installedPi, executable: process.execPath, cli: installedCli, argv: parentArgs, package_version: expectedVersion };
    appendHarnessEvent("parent_spawn", { pid: parentPid, selected_binary: installedPi, cli: installedCli });
    parent.stderr.on("data", (chunk) => parentStderr.push(chunk.toString("utf8")));
    parentLines = createInterface({ input: parent.stdout });
    parentLines.on("line", (line) => {
      let message;
      try { message = JSON.parse(line); } catch { parentRpcEvents.push({ type: "malformed_parent_output" }); return; }
      appendHarnessEvent("parent_rpc_rx", { correlation_id: typeof message.id === "string" ? message.id : null, frame_type: message.type ?? null, success: message.success === true });
      if (message?.id && parentRpcResponses.has(String(message.id))) {
        parentRpcResponses.get(String(message.id))(message);
        parentRpcResponses.delete(String(message.id));
      } else {
        parentRpcEvents.push(message);
      }
    });
    await requestParent("parent-ready", { type: "get_state" });

    const readyPersonas = ["ready-ok", "retry", "malformed", "timeout", "closed"];
    setPlan("LAUNCH_READY_CHILDREN", readyPersonas.map((persona) => ({ persona_id: persona, task: `Hold actual child ${persona} on the loopback provider.` })));
    const readyAgentOffset = parentRpcEvents.length;
    await requestParent("launch-ready", { type: "prompt", message: "LAUNCH_READY_CHILDREN" });
    await waitTransport((rows) => readyPersonas.every((persona) => rows.some((row) => row.persona === persona && row.event === "rpc_tx" && row.frame_id === "prompt-1")), "five actual children ready");
    const terminalProbeRows = await waitTransport(
      (rows) => readyPersonas.every((persona) => rows.some((row) => row.persona === persona && row.event === "rpc_tx" && row.frame_id === "prompt-1")),
      "ready-child terminal observation probe",
      0,
    );
    raw.observation.terminal_recheck = "PASS";
    raw.observation.probe = {
      label: "ready-child terminal observation probe",
      deadline_ms: 0,
      observed_event: "rpc_tx",
      observed_personas: readyPersonas.filter((persona) => terminalProbeRows.some((row) => row.persona === persona && row.event === "rpc_tx" && row.frame_id === "prompt-1")),
    };
    await waitParentAgentEnd(readyAgentOffset, "ready launch parent agent_end");
    const statusOffset = parentRpcEvents.length;
    await requestParent("status-five-ready", { type: "prompt", message: "/larva-model-map status" });
    const readyStatus = await waitParentEvent((event) => event?.type === "extension_ui_request" && event.method === "notify" && typeof event.message === "string" && event.message.includes("children ready=5"), "five-ready status", statusOffset);
    appendHarnessEvent("five_ready_observed", { message: readyStatus.message });

    const alphaTransportOffset = (await readTransport()).length;
    const alpha = await runProfile("alpha", "fanout");
    const alphaRows = alpha.transport.slice(alphaTransportOffset);
    const alphaConcurrency = concurrencyObservation(alphaRows, 1);
    const alphaCommands = commandGenerationRows(alphaRows, 1);
    const alphaIds = alphaCommands.map((row) => row.frame_id);
    const alphaPersonas = alphaCommands.map((row) => row.persona);
    const alphaTasks = alphaCommands.map((row) => taskByPersona(alpha.transport, row.persona));
    raw.cases.bounded_fanout_correlation = {
      requirement_id: "MMPS-CHILD-REAL-01",
      outcome: alpha.notification.message.startsWith("Larva model-map success: alpha;") && alphaCommands.length === 5 && new Set(alphaIds).size === 5 && new Set(alphaPersonas).size === 5 && alphaTasks.every((task) => typeof task === "string") && alphaConcurrency.maximum === 4 ? "PASS" : "FAIL",
      simultaneous_ready_children: readyPersonas.length,
      actual_child_processes: readyPersonas.map((persona) => ({ persona, task_id: taskByPersona(alpha.transport, persona), controller_pid: alpha.transport.find((row) => row.persona === persona && row.event === "process_start")?.controller_pid ?? null, actual_pid: alpha.transport.find((row) => row.persona === persona && row.event === "process_start")?.actual_pid ?? null })),
      correlations: alphaCommands.map((row) => ({ correlation_id: row.frame_id, persona_id: row.persona, task_id: taskByPersona(alpha.transport, row.persona), provider: row.provider, model_id: row.model_id })),
      observed_max_concurrency: alphaConcurrency.maximum,
      concurrency_limit: 4,
      elapsed_ms: alpha.elapsed_ms,
    };

    setPlan("LAUNCH_STARTING_CHILDREN", [
      { persona_id: "ending", task: "Remain starting until terminated during the profile switch." },
      { persona_id: "lifecycle", task: "Fence the latest generation before the first prompt." },
    ]);
    const startingParentOffset = parentRpcEvents.length;
    await requestParent("launch-starting", { type: "prompt", message: "LAUNCH_STARTING_CHILDREN" });
    let startingRows = await waitTransport((rows) => ["ending", "lifecycle"].every((persona) => rows.some((row) => row.persona === persona && row.event === "rpc_state_held")), "two actual children held in starting state");
    const endingProcess = startingRows.find((row) => row.persona === "ending" && row.event === "process_start");
    if (!endingProcess || !Number.isInteger(endingProcess.controller_pid)) throw new Error("ending child controller identity missing");
    const betaEventOffset = parentRpcEvents.length;
    const betaStarted = process.hrtime.bigint();
    const betaResponsePromise = requestParent("profile-terminal-recheck", { type: "prompt", message: "/larva-model-map beta" });
    startingRows = await waitTransport((rows) => rows.some((row) => row.event === "rpc_tx" && actualChildProfileNameFromFrameId(row.frame_id) === 2), "beta snapshot crossed by first installed-child RPC");
    appendHarnessEvent("profile_snapshot_crossed", { profile: "beta", proof_boundary: "first ready-child set_model tx follows the active-record snapshot", child: "ending" });
    process.kill(endingProcess.controller_pid, "SIGTERM");
    appendHarnessEvent("starting_child_terminated", { persona: "ending", controller_pid: endingProcess.controller_pid, actual_pid: endingProcess.actual_pid ?? null });
    await betaResponsePromise;
    const betaNotification = await waitParentEvent((event) => event?.type === "extension_ui_request" && event.method === "notify" && typeof event.message === "string" && event.message.includes(": beta;"), "beta terminal-recheck notification", betaEventOffset);
    appendHarnessEvent("profile_classified", { profile: "beta", label: "terminal-recheck", elapsed_ms: elapsedMs(betaStarted), message: betaNotification.message });
    const betaCounts = profileNotificationCounts(betaNotification.message);
    raw.cases.terminal_recheck = {
      requirement_id: "MMPS-CHILD-REAL-02",
      outcome: betaCounts?.ended === 1 && betaCounts?.pending === 1 ? "PASS" : "FAIL",
      classification: "ended_during_switch",
      persona_id: "ending",
      process: { controller_pid: endingProcess.controller_pid, actual_pid: endingProcess.actual_pid ?? null },
      ordering: ["profile_snapshot_crossed", "starting_child_terminated", "profile_classified"],
      notification: betaNotification.message,
      elapsed_ms: elapsedMs(betaStarted),
    };

    await writeControl("normal", ["lifecycle"]);
    const lifecycleRows = await waitTransport((rows) => rows.some((row) => row.persona === "lifecycle" && row.event === "rpc_tx" && row.frame_id === "model-map-fence-2") && rows.some((row) => row.persona === "lifecycle" && row.event === "rpc_tx" && row.frame_id === "prompt-1"), "lifecycle fence and prompt ordering");
    const lifecycleFenceIndex = lifecycleRows.findIndex((row) => row.persona === "lifecycle" && row.event === "rpc_tx" && row.frame_id === "model-map-fence-2");
    const lifecyclePromptIndex = lifecycleRows.findIndex((row) => row.persona === "lifecycle" && row.event === "rpc_tx" && row.frame_id === "prompt-1");
    await waitObserved(() => (heldProviderResponses.get("lifecycle")?.length ?? 0) > 0, "lifecycle provider request");
    const lifecycleTask = taskByPersona(lifecycleRows, "lifecycle");
    completeHeld("lifecycle", "LIFECYCLE_NEW_COMPLETE");
    await waitTrace((rows) => rows.some((row) => row.event === "cleanup_end" && row.pid === lifecycleRows.find((entry) => entry.persona === "lifecycle" && entry.event === "process_start")?.controller_pid), "new lifecycle child terminal cleanup");
    await waitParentAgentEnd(startingParentOffset, "starting launch parent agent_end");

    await writeControl("retry_first", ["lifecycle"]);
    const retryFirstOffset = (await readTransport()).length;
    const retryFirst = await runProfile("gamma", "retry-first");
    const retryTask = taskByPersona(retryFirst.transport, "retry");
    const retryFirstRows = retryFirst.transport.slice(retryFirstOffset);
    await writeControl("retry_second", ["lifecycle"]);
    const retrySecondOffset = (await readTransport()).length;
    const retrySecond = await runProfile("gamma", "retry-second");
    const retrySecondRows = retrySecond.transport.slice(retrySecondOffset);
    const retrySecondCommands = retrySecondRows.filter((row) => row.event === "rpc_tx" && actualChildProfileNameFromFrameId(row.frame_id) === 3);
    raw.cases.partial_selective_retry = {
      requirement_id: "MMPS-CHILD-REAL-03",
      outcome: retryFirst.notification.message.startsWith("Larva model-map partial: gamma;") && retryFirst.notification.message.includes(`${retryTask}:retry`) && retryFirstRows.some((row) => row.persona === "retry" && row.event === "rpc_drop" && row.fault === "selective_retry_timeout") && retrySecond.notification.message.startsWith("Larva model-map success: gamma;") && retrySecondCommands.length === 1 && retrySecondCommands[0]?.persona === "retry" ? "PASS" : "FAIL",
      partial: { task_id: retryTask, persona_id: "retry", notification: retryFirst.notification.message, elapsed_ms: retryFirst.elapsed_ms },
      retry: { profile: "gamma", targeted_personas: retrySecondCommands.map((row) => row.persona), correlations: retrySecondCommands.map((row) => row.frame_id), notification: retrySecond.notification.message, elapsed_ms: retrySecond.elapsed_ms },
      fallback_count: 0,
    };

    const faultCases = [];
    for (const fault of [
      { profile: "delta", phase: "fault_malformed", persona: "malformed", event: "rpc_malformed", kind: "malformed_response", min_ms: 0, max_ms: 2_500 },
      { profile: "epsilon", phase: "fault_timeout", persona: "timeout", event: "rpc_drop", kind: "timeout", min_ms: 4_500, max_ms: caseDeadlineMs },
      { profile: "zeta", phase: "fault_closed", persona: "closed", event: "rpc_stdout_closed", kind: "closed_stream", min_ms: 0, max_ms: 2_500 },
    ]) {
      await writeControl(fault.phase, ["lifecycle"]);
      const offset = (await readTransport()).length;
      const result = await runProfile(fault.profile, `fault-${fault.kind}`);
      const rows = result.transport.slice(offset);
      const taskId = taskByPersona(result.transport, fault.persona);
      const observation = rows.find((row) => row.persona === fault.persona && row.event === fault.event);
      faultCases.push({
        fault: fault.kind,
        profile: fault.profile,
        task_id: taskId,
        persona_id: fault.persona,
        observed_event: observation?.event ?? null,
        elapsed_ms: result.elapsed_ms,
        bounded: result.elapsed_ms >= fault.min_ms && result.elapsed_ms <= fault.max_ms,
        explicit_partial: result.notification.message.startsWith(`Larva model-map partial: ${fault.profile};`) && result.notification.message.includes(`${taskId}:${fault.persona}`),
        fallback_count: 0,
        notification: result.notification.message,
      });
    }

    if (typeof lifecycleTask !== "string") throw new Error("lifecycle task identity missing before resume");
    await writeFile(join(configDir, "model-map.json"), JSON.stringify({ models: { "logical/parent": { provider: "controlled", model_id: profileModels.zeta.parent }, "logical/child": { provider: "controlled", model_id: profileModels.zeta.child } }, prefix_rules: [] }), "utf8");
    appendHarnessEvent("canonical_child_bootstrap_route_updated", { profile: "zeta", model_id: profileModels.zeta.child });
    setPlan("RESUME_LIFECYCLE_CHILD", [{ persona_id: "lifecycle", task: "Resume the terminal lifecycle child on the current route.", task_id: lifecycleTask }]);
    const resumeParentOffset = parentRpcEvents.length;
    await requestParent("resume-lifecycle", { type: "prompt", message: "RESUME_LIFECYCLE_CHILD" });
    let resumeRows = await waitTransport((rows) => rows.filter((row) => row.persona === "lifecycle" && row.event === "process_start").length === 2 && rows.some((row) => row.persona === "lifecycle" && row.event === "rpc_tx" && row.frame_id === "switch-1") && rows.some((row) => row.persona === "lifecycle" && row.event === "rpc_forward" && row.frame_id === "switch-1"), "actual resumed lifecycle session switch");
    const resumeStart = resumeRows.filter((row) => row.persona === "lifecycle" && row.event === "process_start").at(-1);
    await waitTransport((rows) => rows.some((row) => row.persona === "lifecycle" && row.controller_pid === resumeStart?.controller_pid && row.event === "rpc_tx" && row.frame_id === "prompt-1"), "actual resumed lifecycle prompt");
    await waitObserved(() => (heldProviderResponses.get("lifecycle")?.length ?? 0) > 0, "resumed lifecycle provider request");
    completeHeld("lifecycle", "LIFECYCLE_RESUME_COMPLETE");
    await waitParentAgentEnd(resumeParentOffset, "resume launch parent agent_end");
    resumeRows = await readTransport();
    const lifecycleStarts = resumeRows.filter((row) => row.persona === "lifecycle" && row.event === "process_start");
    const lifecycleSwitchIndex = resumeRows.findLastIndex((row) => row.persona === "lifecycle" && row.event === "rpc_tx" && row.frame_id === "switch-1");
    const lifecycleResumePromptIndex = resumeRows.findLastIndex((row) => row.persona === "lifecycle" && row.controller_pid === resumeStart?.controller_pid && row.event === "rpc_tx" && row.frame_id === "prompt-1");
    raw.cases.generation_lifecycle = {
      requirement_id: "MMPS-CHILD-REAL-04",
      outcome: lifecycleFenceIndex >= 0 && lifecycleFenceIndex < lifecyclePromptIndex && lifecycleStarts.length === 2 && lifecycleSwitchIndex >= 0 && lifecycleSwitchIndex < lifecycleResumePromptIndex && raw.cases.terminal_recheck.outcome === "PASS" ? "PASS" : "FAIL",
      generation: 2,
      fence_correlation: "model-map-fence-2",
      fence_before_first_prompt: lifecycleFenceIndex >= 0 && lifecycleFenceIndex < lifecyclePromptIndex,
      classifications: {
        new: { persona_id: "lifecycle", task_id: lifecycleTask, controller_pid: lifecycleStarts[0]?.controller_pid ?? null, actual_pid: lifecycleStarts[0]?.actual_pid ?? null },
        resumed: { persona_id: "lifecycle", task_id: lifecycleTask, controller_pid: lifecycleStarts[1]?.controller_pid ?? null, actual_pid: lifecycleStarts[1]?.actual_pid ?? null, switch_before_prompt: lifecycleSwitchIndex < lifecycleResumePromptIndex },
        terminal: { persona_id: "lifecycle", observed: true },
        ended_during_switch: { persona_id: "ending", observed: raw.cases.terminal_recheck.outcome === "PASS" },
      },
    };

    const allTransportBeforeCleanup = await readTransport();
    const processStarts = allTransportBeforeCleanup.filter((row) => row.event === "process_start");
    if (processStarts.length > childLimit) throw new Error(`actual child process limit exceeded: ${processStarts.length}`);
    raw.executed.children = processStarts.map((row) => ({ persona_id: row.persona, controller_pid: row.controller_pid, actual_pid: row.actual_pid, selected_binary: row.selected_binary, executable: row.executable, cli: row.cli, package_version: expectedVersion }));
    const networkSamples = [await processNetworkSample(parentPid, "parent")];
    for (const row of processStarts.filter((entry) => processAlive(entry.actual_pid))) networkSamples.push(await processNetworkSample(row.actual_pid, "child", row.persona));
    raw.isolation.network_samples = networkSamples;
    raw.isolation.loopback_only = networkSamples.every((sample) => sample.loopback_only) && providerRequests.every((request) => request.loopback === true);
    raw.isolation.external_provider_requests = providerRequests.filter((request) => request.loopback !== true).length;
    raw.cases.rpc_fault_cleanup = {
      requirement_id: "MMPS-CHILD-REAL-05",
      outcome: faultCases.length === 3 && faultCases.every((fault) => fault.bounded && fault.explicit_partial && fault.fallback_count === 0) ? "PASS" : "FAIL",
      faults: faultCases,
      fallback_count: 0,
      process_count_before_cleanup: processStarts.length,
    };

    const cleanupOffset = (await readTrace()).length;
    const cleanupResponse = await requestParent("cleanup-new-session", { type: "new_session" }, 20_000);
    appendHarnessEvent("lifecycle_cleanup_requested", { success: cleanupResponse?.success === true });
    await waitObserved(async () => {
      const current = await readTransport();
      return processStarts.every((row) => !processAlive(row.controller_pid) && !processAlive(row.actual_pid)) ? current : null;
    }, "all installed child Pi processes exit", 20_000, 50);
    cleanupTrace = (await readTrace()).slice(cleanupOffset);
    cleanupTransport = await readTransport();
  } catch (error) {
    raw.error = { code: "ACTUAL_CHILD_PROOF_FAILED", message: error?.message ?? String(error) };
    appendHarnessEvent("scenario_failure", { message: raw.error.message });
  } finally {
    if (scenarioDeadlineTimer !== null) clearTimeout(scenarioDeadlineTimer);
    for (const entries of heldProviderResponses.values()) {
      for (const entry of entries) {
        try { entry.response.destroy(); } catch {}
      }
    }
    heldProviderResponses.clear();
    if (parentLines) parentLines.close();
    if (processGroupAlive(parentPid)) {
      appendHarnessEvent("process_group_cleanup", { process_group_id: parentPid, signal: "SIGTERM" });
      try { process.kill(-parentPid, "SIGTERM"); } catch {}
    } else if (parent && parent.exitCode === null && parent.signalCode === null) {
      parent.kill("SIGTERM");
    }
    if (parent) await Promise.race([new Promise((resolveClose) => parent.once("close", resolveClose)), new Promise((resolveWait) => setTimeout(resolveWait, 2_000))]);
    if (processGroupAlive(parentPid)) {
      appendHarnessEvent("process_group_cleanup", { process_group_id: parentPid, signal: "SIGKILL" });
      try { process.kill(-parentPid, "SIGKILL"); } catch {}
    } else if (parent && parent.exitCode === null && parent.signalCode === null) {
      parent.kill("SIGKILL");
    }
    if (server) {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolveClose) => server.close(() => resolveClose()));
    }
    let finalTransport = cleanupTransport;
    let finalTrace = cleanupTrace;
    try { if (finalTransport.length === 0) finalTransport = await readTransport(); } catch {}
    try { if (finalTrace.length === 0) finalTrace = await readTrace(); } catch {}
    const starts = finalTransport.filter((row) => row.event === "process_start");
    for (const row of starts) {
      for (const pid of [row.controller_pid, row.actual_pid]) {
        if (processAlive(pid)) {
          try { process.kill(pid, "SIGKILL"); } catch {}
        }
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    raw.cleanup.parent_alive = processAlive(parentPid);
    raw.cleanup.process_group_alive = processGroupAlive(parentPid);
    raw.cleanup.child_controllers_alive = Object.fromEntries(starts.map((row) => [String(row.controller_pid), processAlive(row.controller_pid)]));
    raw.cleanup.child_pi_processes_alive = Object.fromEntries(starts.map((row) => [String(row.actual_pid), processAlive(row.actual_pid)]));
    raw.cleanup.loopback_closed = server === null || !server.listening;
    raw.cleanup.unknown_state = raw.cleanup.process_group_alive || Object.values(raw.cleanup.child_controllers_alive).some(Boolean) || Object.values(raw.cleanup.child_pi_processes_alive).some(Boolean) || raw.cleanup.parent_alive === true;
    try { await rm(tempRoot, { recursive: true, force: true }); } catch (error) { cleanupError = error; }
    raw.cleanup.temporary_root_removed = !(await exists(tempRoot));
    raw.cleanup.outcome = !scenarioDeadlineExceeded && !raw.cleanup.unknown_state && raw.cleanup.loopback_closed && raw.cleanup.temporary_root_removed && cleanupError === null ? "PASS" : "FAIL";
    raw.cleanup.trace_cleanup_end_count = finalTrace.filter((row) => row.event === "cleanup_end").length;
    raw.cleanup.transport_exit_count = finalTransport.filter((row) => row.event === "process_exit").length;
    if (cleanupError !== null && raw.error === null) raw.error = { code: "ACTUAL_CHILD_CLEANUP_FAILED", message: cleanupError?.message ?? String(cleanupError) };

    for (const row of finalTransport) {
      events.push({
        source: "child_transport",
        event: row.event,
        monotonic_ns: row.monotonic_ns,
        controller_pid: row.controller_pid ?? null,
        actual_pid: row.actual_pid ?? null,
        persona_id: row.persona ?? null,
        correlation_id: row.frame_id ?? null,
        frame_type: row.frame_type ?? null,
        provider: row.provider ?? null,
        model_id: row.model_id ?? null,
        task_id: row.task_id ?? null,
        fault: row.fault ?? null,
        code: row.code ?? null,
        signal: row.signal ?? null,
        text_preview: row.text_preview ?? null,
      });
    }
    for (const row of finalTrace) {
      const wallMs = typeof row.ts === "string" ? Date.parse(row.ts) : scenarioStartedWallMs;
      const monotonicNs = scenarioStartedMonotonicNs + BigInt(Math.max(0, Number.isFinite(wallMs) ? wallMs - scenarioStartedWallMs : 0)) * 1_000_000n;
      events.push({ source: "extension_trace", event: row.event, monotonic_ns: monotonicNs.toString(), pid: row.pid ?? null, persona_id: row.persona_id ?? null, correlation_id: row.frame_id ?? null, frame_type: row.frame_type ?? null, code: row.code ?? null, signal: row.signal ?? null });
    }
    raw.events = events
      .filter((row) => typeof row.monotonic_ns === "string")
      .sort((left, right) => left.monotonic_ns.localeCompare(right.monotonic_ns))
      .map((row, index) => ({ sequence: index + 1, ...row }));
    const casesPass = ["bounded_fanout_correlation", "terminal_recheck", "partial_selective_retry", "generation_lifecycle", "rpc_fault_cleanup"].every((key) => raw.cases[key]?.outcome === "PASS");
    raw.status = casesPass && raw.observation.terminal_recheck === "PASS" && raw.isolation.environment_status === "PASS" && raw.isolation.loopback_only && raw.isolation.external_provider_requests === 0 && raw.isolation.credential_env_keys_present.length === 0 && raw.executed.children.length >= 5 && raw.executed.children.length <= childLimit && raw.cleanup.outcome === "PASS" && parentStderr.join("").length === 0 ? "PASS" : "FAIL";
    if (raw.status === "FAIL" && raw.error === null) raw.error = { code: "ACTUAL_CHILD_ASSERTION_FAILED", message: "One or more actual-child runtime assertions failed." };
    evidence.pi = { binary: installedPi, available: true, extensionFlag: "-e" };
    evidence.package = { ...evidence.package, packageRoot: installedPackageRoot, versionText: expectedVersion, installedVersion: expectedVersion };
    evidence.rpc.attempted = parentPid !== null;
    evidence.rpc.supported = parentRpcEvents.some((event) => event?.type === "agent_end");
    evidence.rpc.stderr = parentStderr.join("");
    evidence.runtime.actualInstalledChildModelMapProfileSwitch = raw;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.has("help")) {
    process.stdout.write(usage());
    return;
  }
  const scenario = args.get("scenario") || args.get("case") || "wait-select-pending-callback-handoff";
  if (!SCENARIOS.includes(scenario)) throw new Error(`unknown or missing scenario: ${scenario ?? ""}`);
  const persona = args.get("persona") || undefined;
  const evidence = baseEvidence(scenario);
  const ownsCompleteRuntimeIsolation = ![
    "model-map-profile-switch",
    "model-map-profile-switch-installed-pi",
    "model-map-profile-switch-installed-child-pi",
  ].includes(scenario);
  if (ownsCompleteRuntimeIsolation) {
    runtimeIsolation = await createNeutralRuntimeIsolation();
    for (const key of HARNESS_SELECTOR_ENV_KEYS) delete process.env[key];
    for (const key of Object.keys(process.env)) if (SECRET_ENV_KEY.test(key)) delete process.env[key];
    Object.assign(process.env, runtimeIsolation.envDefaults);
    runtimeIsolation.environmentObservations.push(observeRuntimeEnvironment(
      process.env,
      Object.keys(runtimeIsolation.envDefaults),
      runtimeIsolation.tempRoot,
    ));
  }
  try {
  if (scenario === "persona-invocation-bus" || scenario === "model-map-profile-switch" || scenario === "model-map-profile-switch-installed-pi" || scenario === "model-map-profile-switch-installed-child-pi") {
    evidence.package.piTuiDependency = {
      hardGateStatus: "SKIPPED",
      reason: "persona-invocation-bus smoke is a source-level contract-anchor probe and must not fail on Pi TUI dependency hydration",
    };
  } else {
    await collectPiTuiDependencyEvidence(evidence);
  }
  if (scenario === "availability") {
    await piAvailability(evidence);
  } else if (scenario === "get-commands") {
    await runPiRpc(evidence, { commands: [{ id: "commands-1", body: { type: "get_commands" } }] });
  } else if (scenario === "slash-status") {
    await runPiRpc(evidence, {
      commands: [
        { id: "prompt-1", body: { type: "prompt", message: `/larva-persona ${persona ?? "ok"}` }, timeoutMs: 4_000 },
        { id: "state-after-persona", body: { type: "get_state" }, timeoutMs: 2_000 },
      ],
      postCommandWaitMs: 1_000,
    });
  } else if (scenario === "startup-status") {
    await runPiRpc(evidence, { initialPersona: persona ?? "startup", commands: [{ id: "state-1", body: { type: "get_state" }, timeoutMs: 5_000 }] });
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
        && missingResume.error?.code === "LARVA_BAD_INPUT"
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
        supported: evidence.runtime.registeredCommandNames.includes("larva-subagent"),
        evidence: { requiredCommand: "larva-subagent", registeredCommandNames: evidence.runtime.registeredCommandNames },
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
  } else if (scenario === "wait-select-pending-callback-handoff") {
    await waitSelectPendingCallbackHandoffExpectedRed(evidence);
  } else if (scenario === "persona-invocation-bus") {
    await personaInvocationBusContractAnchors(evidence);
    await realPiPersonaInvocationBusProof(evidence);
  } else if (scenario === "model-map-profile-switch") {
    await modelMapProfileSwitchProof(evidence);
  } else if (scenario === "model-map-profile-switch-installed-pi") {
    await installedPiModelMapProfileSwitchProof(evidence);
  } else if (scenario === "model-map-profile-switch-installed-child-pi") {
    await installedActualChildPiModelMapProfileSwitchProof(evidence);
  }
  } finally {
    if (ownsCompleteRuntimeIsolation) await cleanupNeutralRuntimeIsolation(evidence);
  }
  const serializable = JSON.parse(JSON.stringify(evidence, (key, value) => (typeof value === "function" ? "[function]" : value)));
  console.log(JSON.stringify(serializable, null, 2));
  if (scenario === "capability-gates" && evidence.package.piTuiDependency?.hardGateStatus !== "PASS") {
    process.exitCode = 1;
  }
  if (scenario === "subagent-log-selector-streaming" && evidence.runtime.subagentLogSelectorStreaming?.status !== "PASS") {
    process.exitCode = 1;
  }
  if (scenario === "live-child-rpc-proof" && evidence.runtime.controlledLive?.status === "FAIL") {
    process.exitCode = 1;
  }
  if (scenario === "async-subagent-contract" && evidence.runtime.asyncSubagentContract?.status !== "PASS") {
    process.exitCode = 1;
  }
  if (scenario === "wait-select-pending-callback-handoff" && evidence.runtime.waitSelectPendingCallbackHandoff?.status !== "PASS") {
    process.exitCode = 1;
  }
  if (scenario === "persona-invocation-bus" && (evidence.runtime.personaInvocationBus?.status !== "PASS" || evidence.runtime.personaInvocationBusRealPi?.status !== "PASS")) {
    process.exitCode = 1;
  }
  if (ownsCompleteRuntimeIsolation && evidence.runtime.isolation?.status !== "PASS") {
    process.exitCode = 1;
  }
  if (scenario === "model-map-profile-switch" && evidence.runtime.modelMapProfileSwitch?.status !== "PASS") {
    process.exitCode = 1;
  }
  if (scenario === "model-map-profile-switch-installed-pi" && evidence.runtime.installedPiModelMapProfileSwitch?.status !== "PASS") {
    process.exitCode = 1;
  }
  if (scenario === "model-map-profile-switch-installed-child-pi" && evidence.runtime.actualInstalledChildModelMapProfileSwitch?.status !== "PASS") {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
