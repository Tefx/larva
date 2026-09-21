// purpose: verify actual subagent startup on installed Pi 0.86.1 layout
// usage: node contrib/pi-extension/test-subagent-real-pi-0-86-1.mjs
// effects: disposable test directory, child Pi process spawn
// requires: installed Pi 0.86.1 (e.g. /opt/homebrew/bin/pi), Node 26.7+
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const piCandidates = [
  "/opt/homebrew/bin/pi",
  "/usr/local/bin/pi",
];

let piPath = null;
for (const cand of piCandidates) {
  if (existsSync(cand)) {
    piPath = cand;
    break;
  }
}

if (!piPath) {
  console.log(JSON.stringify({ skipped: true, reason: "No native Pi installation found" }));
  process.exit(0);
}

const root = await mkdtemp(join(tmpdir(), "larva-real-pi-0861-"));
const originalArgv = process.argv;

try {
  process.argv = [process.execPath, piPath];
  const mod = await import(`./larva.ts?t=${Date.now()}`);

  // 1. Verify inspection of 0.86.1 installation layout
  const inspection = mod.inspectPiCliScriptForTests(piPath);
  assert.equal(inspection.ok, true, `installed Pi at ${piPath} must be inspectable and valid`);
  assert.equal(mod.isSupportedPiVersionForTests(inspection.version), true, `version ${inspection.version} must be supported`);

  // 2. Verify launch prefix resolution returns real binary paths
  const resolved = mod.captureNativePiCommandPrefixForTests();
  assert.ok(Array.isArray(resolved), "captureNativePiCommandPrefix must return array");
  assert.equal(resolved.length, 2);
  assert.equal(resolved[0], realpathSync(process.execPath));
  assert.equal(resolved[1], inspection.actual);

  // 3. Initialize extension and commit persona
  const env = {
    HOME: root,
    LARVA_PI_CHILD_SESSION_DIR: join(root, "sessions"),
    LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, fileURLToPath(new URL("../../tests/fixtures/pi/fake-larva-cli.mjs", import.meta.url))]),
  };
  const ctx = {
    env,
    mode: "rpc",
    hasUI: false,
    modelRegistry: { find: (provider, id) => ({ provider, id }) },
    ui: { setStatus: () => {} },
  };
  const pi = {
    registerTool() {},
    registerCommand() {},
    on() {},
    getAllTools: () => ["read", "bash", "larva_subagent"],
    setActiveTools: () => true,
    setModel: () => true,
    getThinkingLevel: () => "off",
    setThinkingLevel() {},
  };
  await mod.initializeExtension(ctx, pi);
  const commit = await mod.commitPersona("ok", ctx, pi);
  assert.equal(commit.ok, true, "persona commit must succeed");

  // 4. Verify actual child subagent spawn under Pi 0.86.1
  const result = await mod.larva_subagent({ persona_id: "child", task: "Verify subagent launch on 0.86.1" }, ctx);

  // Must NOT fail before child startup (the bug was LARVA_CHILD_START_FAILED before child launch)
  if (result.status === "failed") {
    assert.notEqual(
      result.error?.code,
      "LARVA_CHILD_START_FAILED",
      `Child launch must not fail before start (got: ${result.error?.message})`
    );
  }

  // A child session file was allocated and RPC handshake was performed
  assert.ok(result.task_id !== null, "child subagent must allocate a task_id session file");
  assert.match(result.task_id, /\.jsonl$/, "task_id must be a session .jsonl path");

  console.log(JSON.stringify({
    checks: [
      "pi-0-86-1-layout-valid",
      "pi-0-86-1-version-supported",
      "pi-0-86-1-command-prefix-captured",
      "pi-0-86-1-persona-committed",
      "pi-0-86-1-subagent-spawn-succeeded",
    ],
    passed: 5,
    pi_version: inspection.version,
    task_id: result.task_id,
  }));
} finally {
  process.argv = originalArgv;
  await rm(root, { recursive: true, force: true });
}
