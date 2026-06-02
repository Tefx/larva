#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, mkdtemp, symlink, writeFile } from "node:fs/promises";
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
  "tool-result-renderer-shape",
  "fresh-session-validation",
  "tool-call-block",
  "capability-gates",
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
    package: { versionCommand: null, versionExitCode: null, packageRoot: null, commit: null, commitExitCode: null },
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

async function runtimeHarness(evidence, { initialPersona = "ok", envOverrides = {} } = {}) {
  const mod = await import(pathToFileURL(extensionPath).href);
  const registeredTools = [];
  evidence.runtime.registeredCommandNames = [];
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
  if (scenario === "availability") {
    await piAvailability(evidence);
  } else if (scenario === "get-commands") {
    await runPiRpc(evidence, { commands: [{ id: "commands-1", body: { type: "get_commands" } }] });
  } else if (scenario === "slash-status") {
    await runPiRpc(evidence, { commands: [{ id: "prompt-1", body: { type: "prompt", message: `/larva-persona ${persona ?? "ok"}` }, timeoutMs: 2_000 }] });
  } else if (scenario === "startup-status") {
    await runPiRpc(evidence, { initialPersona: persona ?? "startup", commands: [{ id: "state-1", body: { type: "get_state" } }] });
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
      subagentToolRowProgress: {
        supported: typeof tool?.renderCall === "function" && typeof tool?.renderResult === "function" && typeof tool?.execute === "function",
        evidence: { hasRenderCall: typeof tool?.renderCall, hasRenderResult: typeof tool?.renderResult, hasExecute: typeof tool?.execute },
      },
      subagentLogOverlayCommand: {
        supported: evidence.runtime.registeredCommandNames.includes("larva-subagent-log"),
        evidence: { requiredCommand: "larva-subagent-log", registeredCommandNames: evidence.runtime.registeredCommandNames },
      },
    };
  }
  const serializable = JSON.parse(JSON.stringify(evidence, (key, value) => (typeof value === "function" ? "[function]" : value)));
  console.log(JSON.stringify(serializable, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
