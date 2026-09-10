#!/usr/bin/env node
// purpose: native Pi 0.85.1 package/admission/runtime acceptance for contrib/pi-extension
// usage: node scripts/pi-native-acceptance.mjs --scenario <name>
// effects: disposable scratch HOME/agent/session/provider only; no user/global install
// requires: /opt/homebrew/bin/pi 0.85.1, local contrib/pi-extension after npm ci

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const EXTENSION_DIR = join(ROOT, "contrib", "pi-extension");
const EXTENSION_ENTRY = join(EXTENSION_DIR, "larva.ts");
const FAKE_CLI = join(ROOT, "tests", "fixtures", "pi", "fake-larva-cli.mjs");
const MODE_OBSERVER = join(ROOT, "tests", "fixtures", "pi", "mode-observer.ts");
const PI_BIN = process.env.PI_BIN || "/opt/homebrew/bin/pi";
const NODE_BIN = process.execPath;

const SCENARIOS = [
  "package-discovery",
  "disable-and-explicit-e",
  "duplicate-copies",
  "pi-owned-unknown-flag",
  "pi-owned-missing-value",
  "larva-bad-input-persona",
  "larva-bad-input-mode",
  "fresh-explicit-success",
  "fresh-explicit-model-fail",
  "missing-cli-binding",
  "missing-extension-explicit-persona",
  "print-mode",
  "rpc-mode",
  "tui-mode",
  "backend-a-project-b",
  "resume-stored-wins-unused-explicit",
  "resume-unresolvable-explicit-fails",
  "resume-stored-restore-nonfatal",
  "parent-shutdown-active-child",
  "native-state", "native-children", "native-invocation", "native-consumers", "native-tui", "native-watchdog", "native-failures", "native-admission", "native-print", "native-capsule-aging", "native-capsule-removal", "native-installed-loading",
];

function usage() {
  return `Usage: node scripts/pi-native-acceptance.mjs --scenario <name>\n\nScenarios:\n${SCENARIOS.map((name) => `  - ${name}`).join("\n")}\n`;
}

function parseArgs(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--scenario") args.set("scenario", argv[++i]);
    else if (arg === "--help" || arg === "-h") args.set("help", true);
  }
  return args;
}

function sanitizedEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key === "VIRTUAL_ENV"
      || key === "UV_PROJECT_ENVIRONMENT"
      || key === "PYTHONPATH"
      || key.startsWith("LARVA_")
      || key.startsWith("PI_CODING_AGENT")
      || key.startsWith("PI_SESSION")
      || key === "PI_MODEL"
      || key === "PI_PROVIDER"
      || /API[_-]?KEY|TOKEN|SECRET|PASSWORD/i.test(key)
    ) {
      delete env[key];
    }
  }
  return { ...env, ...overrides };
}

function runRpcUntil(command, args, options = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs ?? 12_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (typeof options.onStdout === "function") options.onStdout(stdout, child);
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveRun({ exitCode: null, error: error.message, stdout, stderr, pid: child.pid ?? null });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveRun({ exitCode: code, signal, stdout, stderr, pid: child.pid ?? null });
    });
    if (options.stdinText) child.stdin.write(options.stdinText);
  });
}

function runProcess(command, args, options = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs ?? 12_000);
    if (options.stdinText) {
      child.stdin.write(options.stdinText);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveRun({ exitCode: null, error: error.message, stdout, stderr, pid: child.pid ?? null });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveRun({ exitCode: code, signal, stdout, stderr, pid: child.pid ?? null });
    });
  });
}

async function createScratch() {
  const tempRoot = await mkdtemp(join(tmpdir(), "larva-native-accept-"));
  const home = join(tempRoot, "home");
  const agent = join(tempRoot, "agent");
  const sessions = join(tempRoot, "sessions");
  const tmp = join(tempRoot, "tmp");
  const cwd = join(tempRoot, "cwd");
  const config = join(tempRoot, "larva-config");
  await Promise.all([home, agent, sessions, tmp, cwd, config].map((path) => mkdir(path, { recursive: true })));
  await writeFile(join(agent, "settings.json"), JSON.stringify({
    defaultProjectTrust: "yes",
    packages: [],
    extensions: [],
    defaultProvider: "larva-neutral",
    defaultModel: "neutral",
    defaultThinkingLevel: "low",
  }, null, 2), "utf8");
  return { tempRoot, home, agent, sessions, tmp, cwd, config };
}

async function startLoopback(scratch) {
  const requests = [];
  const sockets = new Set();
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk.toString("utf8");
    const hold = body.includes("HOLD_CHILD");
    requests.push({ method: request.method, url: request.url, body: body.slice(0, 2000), hold });
    response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
    if (hold) return;
    response.write(`data: ${JSON.stringify({ id: "n", object: "chat.completion.chunk", created: 0, model: "neutral", choices: [{ index: 0, delta: { role: "assistant", content: "NEUTRAL_LOOPBACK_OK" }, finish_reason: "stop" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const providerPath = join(scratch.tempRoot, "loopback-provider.ts");
  await writeFile(providerPath, `export default function (pi) {
  pi.registerProvider("larva-neutral", {
    name: "Larva native loopback",
    baseUrl: "http://127.0.0.1:${port}/v1",
    apiKey: "loopback-only",
    api: "openai-completions",
    models: [{ id: "neutral", name: "neutral", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 256 }],
  });
}
`, "utf8");
  await writeFile(join(scratch.config, "model-map.json"), JSON.stringify({
    models: { "openai/gpt-5.5": { provider: "larva-neutral", model_id: "neutral" } },
    prefix_rules: [],
  }), "utf8");
  return {
    requests,
    providerPath,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolveClose) => server.close(resolveClose));
    },
  };
}

function baseEnv(scratch, extra = {}) {
  return sanitizedEnv({
    HOME: scratch.home,
    TMPDIR: scratch.tmp,
    PI_CODING_AGENT_DIR: scratch.agent,
    PI_CODING_AGENT_SESSION_DIR: scratch.sessions,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    TERM: "xterm-256color",
    LARVA_CLI_ARGV_JSON: JSON.stringify([NODE_BIN, FAKE_CLI]),
    LARVA_PI_MODEL_MAP_FILE: join(scratch.config, "model-map.json"),
    PATH: `/opt/homebrew/bin:/usr/bin:/bin:${dirname(NODE_BIN)}`,
    ...extra,
  });
}

async function piInstall(scratch) {
  return runProcess(PI_BIN, ["install", EXTENSION_DIR], { env: baseEnv(scratch), cwd: scratch.cwd, timeoutMs: 20_000 });
}

function larvaLoaded(text) {
  return /larva-persona|Larva persona|larva: /.test(text);
}

async function withScratch(fn) {
  const scratch = await createScratch();
  const loopback = await startLoopback(scratch);
  try {
    return await fn(scratch, loopback);
  } finally {
    await loopback.close();
    await rm(scratch.tempRoot, { recursive: true, force: true });
  }
}

async function runScenario(scenario) {
  const evidence = { scenario, pi: PI_BIN, extensionDir: EXTENSION_DIR, pass: false };
  if (scenario.startsWith("native-") || scenario === "backend-a-project-b" || scenario === "resume-stored-restore-nonfatal") {
    const { runJourney } = await import("./pi-native-journeys.mjs");
    return { ...await runJourney(scenario === "backend-a-project-b" ? "environment" : scenario === "resume-stored-restore-nonfatal" ? "stored-restore" : scenario.slice(7)), scenario };
  }
  if (scenario === "package-discovery") {
    await withScratch(async (scratch, loopback) => {
      const install = await piInstall(scratch);
      evidence.install = { exitCode: install.exitCode, stderr: install.stderr.slice(0, 800), stdout: install.stdout.slice(0, 800) };
      const settings = JSON.parse(await readFile(join(scratch.agent, "settings.json"), "utf8"));
      evidence.settingsPackages = settings.packages ?? settings.extensions ?? [];
      const help = await runProcess(PI_BIN, ["--help"], { env: baseEnv(scratch), cwd: scratch.cwd, timeoutMs: 8_000 });
      evidence.help = { exitCode: help.exitCode, hasLarvaPersonaFlag: /--larva-persona/.test(`${help.stdout}${help.stderr}`) };
      const rpc = await runProcess(PI_BIN, ["--mode", "rpc", "--no-session", "--offline", "--approve", "-e", loopback.providerPath], {
        env: baseEnv(scratch),
        cwd: scratch.cwd,
        timeoutMs: 8_000,
        stdinText: `${JSON.stringify({ id: "c1", type: "get_commands" })}\n`,
      });
      evidence.rpc = { exitCode: rpc.exitCode, stdout: rpc.stdout.slice(0, 2000), stderr: rpc.stderr.slice(0, 800) };
      evidence.loadedWithoutExplicitE = /larva-persona/.test(rpc.stdout) || /larva-persona/.test(rpc.stderr);
      evidence.pass = install.exitCode === 0 && evidence.help.hasLarvaPersonaFlag === true && evidence.loadedWithoutExplicitE === true;
    });
  } else if (scenario === "disable-and-explicit-e") {
    await withScratch(async (scratch, loopback) => {
      await piInstall(scratch);
      const disabled = await runProcess(PI_BIN, ["--mode", "rpc", "--no-session", "--offline", "--approve", "--no-extensions", "-e", loopback.providerPath], {
        env: baseEnv(scratch),
        cwd: scratch.cwd,
        timeoutMs: 8_000,
        stdinText: `${JSON.stringify({ id: "c1", type: "get_commands" })}\n`,
      });
      const explicit = await runProcess(PI_BIN, ["--mode", "rpc", "--no-session", "--offline", "--approve", "--no-extensions", "-e", loopback.providerPath, "-e", EXTENSION_ENTRY], {
        env: baseEnv(scratch),
        cwd: scratch.cwd,
        timeoutMs: 8_000,
        stdinText: `${JSON.stringify({ id: "c1", type: "get_commands" })}\n`,
      });
      evidence.disabledHasLarva = larvaLoaded(`${disabled.stdout}${disabled.stderr}`);
      evidence.explicitHasLarva = larvaLoaded(`${explicit.stdout}${explicit.stderr}`);
      evidence.disabled = { exitCode: disabled.exitCode, stderr: disabled.stderr.slice(0, 400) };
      evidence.explicit = { exitCode: explicit.exitCode, stderr: explicit.stderr.slice(0, 400) };
      evidence.pass = evidence.disabledHasLarva === false && evidence.explicitHasLarva === true;
    });
  } else if (scenario === "duplicate-copies") {
    await withScratch(async (scratch, loopback) => {
      await piInstall(scratch);
      const copyDir = join(scratch.tempRoot, "larva-copy");
      await mkdir(copyDir, { recursive: true });
      const { cp } = await import("node:fs/promises");
      await cp(EXTENSION_ENTRY, join(copyDir, "larva.ts"));
      await cp(join(EXTENSION_DIR, "child-rpc-frame-preload.mjs"), join(copyDir, "child-rpc-frame-preload.mjs"));
      await cp(join(EXTENSION_DIR, "package.json"), join(copyDir, "package.json"));
      const { symlink } = await import("node:fs/promises");
      await symlink(join(EXTENSION_DIR, "node_modules"), join(copyDir, "node_modules"));
      const result = await runProcess(PI_BIN, ["--mode", "rpc", "--no-session", "--offline", "--approve", "-e", loopback.providerPath, "-e", join(copyDir, "larva.ts")], {
        env: baseEnv(scratch),
        cwd: scratch.cwd,
        timeoutMs: 8_000,
        stdinText: `${JSON.stringify({ id: "c1", type: "get_commands" })}\n`,
      });
      evidence.stderr = result.stderr.slice(0, 1500);
      evidence.duplicateDiagnosed = /second Larva Pi extension copy/.test(result.stderr);
      evidence.pass = evidence.duplicateDiagnosed === true;
    });
  } else if (scenario === "pi-owned-unknown-flag") {
    await withScratch(async (scratch, loopback) => {
      await piInstall(scratch);
      const result = await runProcess(PI_BIN, ["--mode", "print", "--offline", "--no-session", "--approve", "-e", loopback.providerPath, "--not-a-larva-flag", "x"], {
        env: baseEnv(scratch),
        cwd: scratch.cwd,
        timeoutMs: 8_000,
      });
      evidence.exitCode = result.exitCode;
      evidence.stderr = result.stderr.slice(0, 800);
      evidence.piOwned = /Unknown option/.test(result.stderr) && !/LARVA_BAD_INPUT/.test(result.stderr);
      evidence.pass = result.exitCode === 1 && evidence.piOwned === true;
    });
  } else if (scenario === "pi-owned-missing-value") {
    await withScratch(async (scratch, loopback) => {
      await piInstall(scratch);
      const result = await runProcess(PI_BIN, ["--mode", "print", "--offline", "--no-session", "--approve", "-e", loopback.providerPath, "--larva-persona"], {
        env: baseEnv(scratch),
        cwd: scratch.cwd,
        timeoutMs: 8_000,
      });
      evidence.exitCode = result.exitCode;
      evidence.stderr = result.stderr.slice(0, 800);
      evidence.piOwned = /requires a value|Unknown option/.test(result.stderr) && !/LARVA_BAD_INPUT/.test(result.stderr);
      evidence.pass = result.exitCode !== 0 && evidence.piOwned === true && result.exitCode !== 2;
    });
  } else if (scenario === "larva-bad-input-persona") {
    await withScratch(async (scratch, loopback) => {
      await piInstall(scratch);
      const result = await runProcess(PI_BIN, ["--mode", "print", "--offline", "--no-session", "--approve", "-e", loopback.providerPath, "--larva-persona", "Not A Valid Id"], {
        env: baseEnv(scratch),
        cwd: scratch.cwd,
        timeoutMs: 8_000,
      });
      evidence.exitCode = result.exitCode;
      evidence.stderr = result.stderr.slice(0, 800);
      evidence.requests = loopback.requests.length;
      evidence.pass = result.exitCode === 2 && /LARVA_BAD_INPUT/.test(result.stderr) && loopback.requests.length === 0;
    });
  } else if (scenario === "larva-bad-input-mode") {
    await withScratch(async (scratch, loopback) => {
      await piInstall(scratch);
      const result = await runProcess(PI_BIN, ["--mode", "rpc", "--offline", "--no-session", "--approve", "-e", loopback.providerPath, "--larva-agent-persona-switch", "bogus"], {
        env: baseEnv(scratch),
        cwd: scratch.cwd,
        timeoutMs: 8_000,
      });
      evidence.exitCode = result.exitCode;
      evidence.stderr = result.stderr.slice(0, 800);
      evidence.requests = loopback.requests.length;
      evidence.pass = result.exitCode === 2 && /LARVA_BAD_INPUT/.test(result.stderr) && loopback.requests.length === 0;
    });
  } else if (scenario === "fresh-explicit-success") {
    await withScratch(async (scratch, loopback) => {
      await piInstall(scratch);
      const result = await runProcess(PI_BIN, ["--mode", "rpc", "--offline", "--no-session", "--approve", "-e", loopback.providerPath, "--larva-persona", "ok"], {
        env: baseEnv(scratch),
        cwd: scratch.cwd,
        timeoutMs: 8_000,
        stdinText: `${JSON.stringify({ id: "s1", type: "get_state" })}\n`,
      });
      evidence.exitCode = result.exitCode;
      evidence.stdout = result.stdout.slice(0, 2000);
      evidence.stderr = result.stderr.slice(0, 800);
      evidence.statusOk = /"statusText":"larva: ok"/.test(result.stdout);
      evidence.stateOk = /"command":"get_state"/.test(result.stdout) && /"success":true/.test(result.stdout);
      evidence.pass = result.exitCode === 0 && evidence.statusOk === true && evidence.stateOk === true && !/LARVA_/.test(result.stderr);
    });
  } else if (scenario === "fresh-explicit-model-fail") {
    await withScratch(async (scratch, loopback) => {
      await piInstall(scratch);
      const result = await runProcess(PI_BIN, ["--mode", "rpc", "--offline", "--no-session", "--approve", "-e", loopback.providerPath, "--larva-persona", "ok"], {
        env: baseEnv(scratch, { FAKE_LARVA_MODEL: "missing-provider/missing-model" }),
        cwd: scratch.cwd,
        timeoutMs: 8_000,
        stdinText: `${JSON.stringify({ id: "p1", type: "prompt", message: "must not reach the model" })}\n`,
      });
      evidence.exitCode = result.exitCode;
      evidence.stderr = result.stderr.slice(0, 1200);
      evidence.requests = loopback.requests.length;
      evidence.queuedPrompt = true;
      evidence.pass = result.exitCode === 2 && /LARVA_MODEL_UNAVAILABLE/.test(result.stderr) && /larva pi:/.test(result.stderr) && loopback.requests.length === 0;
    });
  } else if (scenario === "missing-cli-binding") {
    await withScratch(async (scratch, loopback) => {
      await piInstall(scratch);
      const env = baseEnv(scratch);
      delete env.LARVA_CLI_ARGV_JSON;
      const unselected = await runProcess(PI_BIN, ["--mode", "rpc", "--offline", "--no-session", "--approve", "-e", loopback.providerPath], {
        env,
        cwd: scratch.cwd,
        timeoutMs: 8_000,
        stdinText: `${JSON.stringify({ id: "s1", type: "get_state" })}\n`,
      });
      const explicit = await runProcess(PI_BIN, ["--mode", "rpc", "--offline", "--no-session", "--approve", "-e", loopback.providerPath, "--larva-persona", "ok"], {
        env,
        cwd: scratch.cwd,
        timeoutMs: 8_000,
      });
      evidence.unselectedExit = unselected.exitCode;
      evidence.unselectedStderr = unselected.stderr.slice(0, 400);
      evidence.explicitExit = explicit.exitCode;
      evidence.explicitStderr = explicit.stderr.slice(0, 800);
      evidence.unselectedUsable = unselected.exitCode === 0 && /"statusText":"larva: none"/.test(unselected.stdout) && /"success":true/.test(unselected.stdout);
      evidence.pass = evidence.unselectedUsable === true && explicit.exitCode === 2 && /LARVA_PERSONA_NOT_FOUND/.test(explicit.stderr) && loopback.requests.length === 0;
    });
  } else if (scenario === "missing-extension-explicit-persona") {
    await withScratch(async (scratch, loopback) => {
      const result = await runProcess(PI_BIN, ["--mode", "print", "--offline", "--no-session", "--no-extensions", "--larva-persona", "ok", "-p", "must not issue a vanilla request"], {
        env: baseEnv(scratch),
        cwd: scratch.cwd,
        timeoutMs: 8_000,
      });
      evidence.exitCode = result.exitCode;
      evidence.stderr = result.stderr.slice(0, 800);
      evidence.requests = loopback.requests.length;
      evidence.pass = result.exitCode !== 0 && /Unknown option/.test(result.stderr) && loopback.requests.length === 0;
    });
  } else if (scenario === "print-mode" || scenario === "rpc-mode" || scenario === "tui-mode") {
    await withScratch(async (scratch, loopback) => {
      const observe = join(scratch.tempRoot, "observe.json");
      const args = ["--offline", "--no-session", "--approve", "--no-extensions", "-e", loopback.providerPath, "-e", EXTENSION_ENTRY, "-e", MODE_OBSERVER];
      if (scenario === "print-mode") args.unshift("--mode", "print");
      if (scenario === "rpc-mode") args.unshift("--mode", "rpc");
      const env = baseEnv(scratch, { LARVA_NATIVE_OBSERVE: observe });
      const result = await runProcess(PI_BIN, args, {
        env,
        cwd: scratch.cwd,
        timeoutMs: 8_000,
        stdinText: scenario === "rpc-mode" ? `${JSON.stringify({ id: "c1", type: "get_commands" })}\n` : undefined,
      });
      evidence.exitCode = result.exitCode;
      evidence.stderr = result.stderr.slice(0, 600);
      if (existsSync(observe)) evidence.observation = JSON.parse(await readFile(observe, "utf8"));
      const expected = scenario === "tui-mode" ? "tui" : scenario === "rpc-mode" ? "rpc" : "print";
      evidence.pass = result.exitCode === 0 && evidence.observation?.mode === expected && (expected !== "rpc" || evidence.observation?.hasUI === true);
    });
  } else if (scenario === "resume-stored-wins-unused-explicit" || scenario === "resume-unresolvable-explicit-fails") {
    await withScratch(async (scratch, loopback) => {
      await piInstall(scratch);
      const { SessionManager } = await import("/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js");
      const manager = SessionManager.create(scratch.cwd, scratch.sessions);
      manager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        api: "test",
        provider: "test",
        model: "test",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now(),
      });
      manager.appendCustomEntry("larva-active-persona-commit", {
        schema_version: 1,
        persona_id: "ok",
        spec_digest: "digest-ok",
        source: "startup",
        committed_at: "2026-09-10T00:00:00.000Z",
      });
      const session = manager.getSessionFile();
      evidence.sessionFiles = [session];
      evidence.sessionExists = existsSync(session);
      if (scenario === "resume-stored-wins-unused-explicit") {
        const resumed = await runProcess(PI_BIN, ["--mode", "rpc", "--offline", "--approve", "-e", loopback.providerPath, "--session", session, "--larva-persona", "startup"], {
          env: baseEnv(scratch, { FAKE_LARVA_MODEL_startup: "missing-provider/missing-model" }),
          cwd: scratch.cwd,
          timeoutMs: 10_000,
          stdinText: `${JSON.stringify({ id: "s1", type: "get_state" })}\n`,
        });
        evidence.resumedExit = resumed.exitCode;
        evidence.resumedStdout = resumed.stdout.slice(0, 1500);
        evidence.resumedStderr = resumed.stderr.slice(0, 800);
        evidence.pass = resumed.exitCode === 0 && /larva: ok/.test(resumed.stdout) && !/LARVA_MODEL_UNAVAILABLE/.test(resumed.stderr);
      } else if (scenario === "resume-unresolvable-explicit-fails") {
        const resumed = await runProcess(PI_BIN, ["--mode", "rpc", "--offline", "--approve", "-e", loopback.providerPath, "--session", session, "--larva-persona", "missing"], {
          env: baseEnv(scratch),
          cwd: scratch.cwd,
          timeoutMs: 10_000,
        });
        evidence.resumedExit = resumed.exitCode;
        evidence.resumedStderr = resumed.stderr.slice(0, 800);
        evidence.pass = resumed.exitCode === 2 && /LARVA_PERSONA_NOT_FOUND/.test(resumed.stderr);
      }
    });
  } else if (scenario === "parent-shutdown-active-child") {
    await withScratch(async (scratch, loopback) => {
      const audit = join(scratch.tempRoot, "audit");
      await mkdir(audit, { recursive: true });
      await mkdir(join(scratch.tempRoot, "children"), { recursive: true });
      const driver = join(ROOT, "tests", "fixtures", "pi", "native-parent-main.ts");
      const subagentConfig = join(scratch.tempRoot, "subagent-runtime.json");
      await writeFile(subagentConfig, JSON.stringify({ schema_version: 1, extension_sources: [loopback.providerPath, join(ROOT, "tests/fixtures/pi/native-child-observer.ts")] }), "utf8");
      const env = baseEnv(scratch, {
        AUDIT_ROOT: audit,
        NATIVE_AUDIT_ROOT: audit,
        LARVA_PI_CHILD_RPC_TRACE_FILE: join(audit, "child-trace.jsonl"),
        LARVA_PI_CHILD_SESSION_DIR: join(scratch.tempRoot, "children"),
        LARVA_PI_SUBAGENT_CONFIG_FILE: subagentConfig,
      });
      const args = ["--mode", "rpc", "--offline", "--approve", "--no-extensions", "-e", loopback.providerPath, "-e", driver, "--larva-persona", "ok", "--session-dir", scratch.sessions];
      const proc = spawn(PI_BIN, args, { env, cwd: scratch.cwd, detached: true, stdio: ["pipe", "pipe", "pipe"] });
      const closed = new Promise((resolveClose) => { proc.once("error", (error) => resolveClose({ error: error.message })); proc.once("close", (code, signal) => resolveClose({ code, signal })); });
      let stdout = "";
      let stderr = "";
      let childPid = null;
      try {
      proc.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
      proc.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
      const observations = async () => {
        try {
          const text = await readFile(join(audit, "main-observations.jsonl"), "utf8");
          return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
        } catch { return []; }
      };
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline && !(await observations()).some((row) => row.event === "ready")) {
        await new Promise((r) => setTimeout(r, 80));
      }
      proc.stdin.write(`${JSON.stringify({ id: "hold", type: "prompt", message: "/audit-child-hold" })}\n`);
      while (Date.now() < deadline && !(await observations()).some((row) => row.event === "accepted")) {
        await new Promise((r) => setTimeout(r, 80));
      }
      let traces = [];
      try {
        traces = (await readFile(join(audit, "child-trace.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      } catch { traces = []; }
      evidence.traceCount = traces.length;
      evidence.traceEvents = traces.map((row) => row.event);
      const obs = await observations();
      const acceptedObs = obs.find((row) => row.event === "accepted");
      evidence.acceptedStatus = acceptedObs?.value?.status ?? acceptedObs?.value?.details?.status ?? null;
      evidence.acceptedError = acceptedObs?.value?.error ?? acceptedObs?.value?.details?.error ?? null;
      const spawnRow = traces.find((row) => row.event === "child_spawn");
      childPid = spawnRow?.pid ?? null;
      let childAliveBefore = false;
      if (childPid) {
        try { process.kill(childPid, 0); childAliveBefore = true; } catch { childAliveBefore = false; }
      }
      const runtimeRoot = join(scratch.home, ".pi", "larva", "runtime");
      let capsulesBefore = existsSync(runtimeRoot) ? (await import("node:fs")).readdirSync(runtimeRoot) : [];
      while (Date.now() < deadline && !loopback.requests.some((row) => row.hold)) await new Promise((r) => setTimeout(r, 20));
      evidence.inFlightProvider = loopback.requests.some((row) => row.hold);
      proc.stdin.write(`${JSON.stringify({ id: "stop", type: "prompt", message: "/audit-stop" })}\n`);
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; try { process.kill(-proc.pid, "SIGKILL"); } catch {} }, 8000);
      const exit = await closed;
      clearTimeout(timer);
      evidence.timedOut = timedOut;
      let childAliveAfter = false;
      if (childPid) {
        try { process.kill(childPid, 0); childAliveAfter = true; } catch { childAliveAfter = false; }
      }
      const capsulesAfter = existsSync(runtimeRoot) ? (await import("node:fs")).readdirSync(runtimeRoot) : [];
      evidence.exit = exit;
      evidence.stderr = stderr.slice(0, 800);
      evidence.childPid = childPid;
      evidence.childAliveBefore = childAliveBefore;
      evidence.childAliveAfter = childAliveAfter;
      evidence.capsulesBefore = capsulesBefore;
      evidence.capsulesAfter = capsulesAfter;
      evidence.observations = (await observations()).map((row) => row.event);
      const taskId = acceptedObs?.value?.task_id ?? acceptedObs?.value?.details?.task_id;
      evidence.retainedSession = typeof taskId === "string" && existsSync(taskId) && (await readFile(taskId, "utf8")).includes("HOLD_CHILD");
      const childObservations = (await readFile(join(audit, "children.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
      evidence.childBeforePrompt = childObservations.find((row) => row.event === "before_prompt");
      evidence.pass = evidence.acceptedStatus === "accepted" && exit.code === 0 && exit.signal === null && !timedOut && evidence.retainedSession && evidence.inFlightProvider && capsulesBefore.length === 1 && evidence.childBeforePrompt?.frame?.configured === true && childAliveBefore === true && childAliveAfter === false && evidence.observations.includes("session_shutdown") && capsulesAfter.length === 0;
      } finally {
        // Exceptions before acceptance still own the parent process group.
        if (proc.exitCode === null && proc.signalCode === null) { try { process.kill(-proc.pid, "SIGKILL"); } catch {} }
        await closed;
        if (childPid) { try { process.kill(childPid, 0); process.kill(childPid, "SIGKILL"); } catch {} }
      }
    });
  } else {
    evidence.error = `unknown scenario ${scenario}`;
  }
  return evidence;
}

const args = parseArgs(process.argv.slice(2));
if (args.get("help") || !args.get("scenario")) {
  process.stdout.write(usage());
  process.exit(args.get("help") ? 0 : 2);
}
if (!existsSync(PI_BIN) || !existsSync(EXTENSION_ENTRY) || !existsSync(FAKE_CLI)) {
  process.stderr.write("native acceptance prerequisites missing\n");
  process.exit(2);
}
const evidence = await runScenario(args.get("scenario"));
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
process.exitCode = evidence.pass ? 0 : 1;
