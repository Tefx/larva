// purpose: verify Larva defaultPersona setting support in settings.json
// usage: node contrib/pi-extension/test-default-persona-setting.mjs
// effects: disposable scratch directories only; no global configuration changes
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = await mkdtemp(join(tmpdir(), "larva-default-persona-"));
try {
  const extensionPath = new URL("./larva.ts", import.meta.url).pathname;
  const mod = await import(pathToFileURL(extensionPath).href);

  // 1. resolveDefaultPersonaFromSettings parses larva.defaultPersona
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ larva: { defaultPersona: "general" } })
  );

  const env = {
    HOME: root,
    PI_CODING_AGENT_DIR: agentDir,
  };
  const resolved = mod.resolveDefaultPersonaFromSettings(env);
  assert.equal(resolved, "general", "should resolve larva.defaultPersona from settings.json");

  // 2. resolveDefaultPersonaFromSettings supports top-level larvaDefaultPersona
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ larvaDefaultPersona: "archimedes" })
  );
  const resolvedTop = mod.resolveDefaultPersonaFromSettings(env);
  assert.equal(resolvedTop, "archimedes", "should resolve larvaDefaultPersona from settings.json");

  // 3. Project settings.json overrides global settings.json
  const projectPiDir = join(root, "project", ".pi");
  await mkdir(projectPiDir, { recursive: true });
  await writeFile(
    join(projectPiDir, "settings.json"),
    JSON.stringify({ larva: { defaultPersona: "forgemaster" } })
  );

  const prevCwd = process.cwd();
  try {
    process.chdir(join(root, "project"));
    const resolvedProject = mod.resolveDefaultPersonaFromSettings(env);
    assert.equal(resolvedProject, "forgemaster", "project .pi/settings.json should override global settings");
  } finally {
    process.chdir(prevCwd);
  }

  // 4. Invalid persona name is safely ignored
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ larva: { defaultPersona: "INVALID PERSONA NAME WITH SPACES" } })
  );
  const resolvedInvalid = mod.resolveDefaultPersonaFromSettings(env);
  assert.equal(resolvedInvalid, null, "invalid persona id should return null");

  // 5. Live Pi RPC tests (fresh session default, explicit flag override, session resume priority)
  const piBin = "/opt/homebrew/bin/pi";
  const { SessionManager } = await import(
    "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js"
  );

  const runPiRpc = (args, customCwd = root) => {
    const cpEnv = { ...process.env };
    delete cpEnv.LARVA_CLI_ARGV_JSON;
    delete cpEnv.LARVA_PI_INITIAL_PERSONA_ID;
    const cp = spawn(piBin, ["--mode", "rpc", ...args], {
      cwd: customCwd,
      env: cpEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    return new Promise((resolve, reject) => {
      let larvaStatus = null;
      let stderr = "";
      const rl = createInterface({ input: cp.stdout });
      rl.on("line", (line) => {
        try {
          const data = JSON.parse(line);
          if (
            data.type === "extension_ui_request" &&
            data.method === "setStatus" &&
            data.statusKey === "larva" &&
            typeof data.statusText === "string" &&
            data.statusText.startsWith("larva: ")
          ) {
            larvaStatus = data.statusText.slice("larva: ".length);
            cp.kill();
          }
        } catch {}
      });
      cp.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      cp.on("exit", (code) => {
        resolve({ code, larvaStatus, stderr });
      });
      cp.on("error", reject);
      setTimeout(() => cp.kill(), 8000);
    });
  };

  // 5a. Fresh session uses defaultPersona "general" from ~/.pi/agent/settings.json
  const freshRes = await runPiRpc(["--no-session"]);
  assert.equal(freshRes.larvaStatus, "general", "fresh session should load defaultPersona from settings");

  // 5b. Explicit --larva-persona flag overrides defaultPersona
  const explicitRes = await runPiRpc(["--no-session", "--larva-persona", "archimedes"]);
  assert.equal(explicitRes.larvaStatus, "archimedes", "--larva-persona should override defaultPersona");

  // 5c. Resumed session restores recorded persona instead of resetting to defaultPersona
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir, { recursive: true });
  const manager = SessionManager.create(root, sessionDir);
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
    persona_id: "archimedes",
    spec_digest: "sha256:e6b5024b417b0a3ec68f9a5b5b03c6fa40616a4f34261332435452640ba8e740",
    source: "startup",
    committed_at: new Date().toISOString(),
  });
  const sessionPath = manager.getSessionFile();

  const resumeRes = await runPiRpc(["--session", sessionPath]);
  assert.equal(resumeRes.larvaStatus, "archimedes", "resumed session should restore saved persona");

  console.log("test-default-persona-setting: PASS (parsing, project override, validation, fresh default, explicit override, resume restore)");
} finally {
  await rm(root, { recursive: true, force: true });
}
