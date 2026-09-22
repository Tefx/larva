// purpose: verify actual subagent startup on installed Pi (filename is historical)
// usage: node contrib/pi-extension/test-subagent-real-pi-0-86-1.mjs
// effects: disposable test directory, child Pi process spawn
// requires: npm ci in contrib/pi-extension, Node 26.7+
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanTestEnv } from "../../scripts/pi-native-support.mjs";

const piPath = process.env.PI_BIN || fileURLToPath(new URL("./node_modules/.bin/pi", import.meta.url));
const cleanEnv = cleanTestEnv({});
for (const key of Object.keys(process.env)) if (!(key in cleanEnv)) delete process.env[key];
assert.ok(existsSync(piPath), `Selected Pi is missing: ${piPath}; run npm ci in contrib/pi-extension`);

const root = await mkdtemp(join(tmpdir(), "larva-real-pi-0861-"));
const originalArgv = process.argv;
let mod;

try {
  process.argv = [process.execPath, piPath];
  mod = await import(`./larva.ts?t=${Date.now()}`);

  // 1. Verify installed package/bin identity
  const inspection = mod.inspectPiCliScriptForTests(piPath);
  assert.equal(inspection.ok, true, `installed Pi at ${piPath} must be inspectable and valid`);

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

  // 4. Verify actual child allocation and RPC handshake on the selected Pi.
  const result = await mod.larva_subagent({ persona_id: "child", task: "Verify selected native subagent launch" }, ctx);

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
      "selected-package-bin-valid",
      "native-command-prefix-captured",
      "persona-committed",
      "child-session-allocated-after-rpc-handshake",
    ],
    passed: 4,
    pi_version: inspection.version,
    task_id: result.task_id,
  }));
} finally {
  await mod?.resetExtensionUI("native-launch-test-cleanup");
  process.argv = originalArgv;
  await rm(root, { recursive: true, force: true });
}
