// purpose: actual OS asynchronous spawn error must release the private capsule
// usage: node contrib/pi-extension/test-native-capsule-spawn-error.mjs
// effects: test-only child-prefix injection, disposable files, backend fixture subprocess
// requires: Node 26.7.0, npm ci; this is controlled API evidence, not native launch proof
import "../../scripts/pi-test-child-loader.mjs";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const mod = await import("./larva.ts");
const root = await mkdtemp(join(tmpdir(), "larva-spawn-error-"));
try {
  const agent = join(root, "agent"); await mkdir(agent);
  const settings = { theme: "dark", defaultModel: "preserve-me" };
  await writeFile(join(agent, "settings.json"), JSON.stringify(settings));
  const denied = join(root, "not-executable"); await writeFile(denied, "fixture", { mode: 0o600 });
  const trace = join(root, "trace.jsonl");
  const env = { HOME: root, PI_CODING_AGENT_DIR: agent, LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, fileURLToPath(new URL("../../tests/fixtures/pi/fake-larva-cli.mjs", import.meta.url))]), LARVA_PI_CHILD_SESSION_DIR: join(root, "sessions"), LARVA_PI_CHILD_RPC_TRACE_FILE: trace, LARVA_PI_TEST_CHILD_ARGV_JSON: JSON.stringify([denied]) };
  const ctx = { env, mode: "rpc", hasUI: false, modelRegistry: { find: (provider, id) => ({ provider, id }) }, ui: { setStatus: () => {} } };
  const pi = { registerTool() {}, registerCommand() {}, on() {}, getAllTools: () => ["read", "bash", "larva_subagent"], setActiveTools: () => true, setModel: () => true, getThinkingLevel: () => "off", setThinkingLevel() {} };
  await mod.initializeExtension(ctx, pi);
  const commit = await mod.commitPersona("ok", ctx, pi);
  assert.equal(commit.ok, true);
  const result = await mod.larva_subagent({ persona_id: "child", task: "Exercise actual EACCES" }, ctx);
  assert.equal(result.status, "failed"); assert.equal(result.error.code, "LARVA_CHILD_START_FAILED");
  const rows = (await readFile(trace, "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(rows.some((r) => r.event === "child_spawn" && r.pid === null));
  assert.ok(rows.some((r) => r.event === "child_error"));
  assert.deepEqual(await readdir(join(root, ".pi/larva/runtime")), []);
  assert.deepEqual(JSON.parse(await readFile(join(agent, "settings.json"), "utf8")), settings);
  const runtime = join(root, ".pi/larva/runtime");
  await rm(runtime, { recursive: true }); await writeFile(runtime, "creation must fail");
  const creationFailure = await mod.larva_subagent({ persona_id: "child", task: "Fail capsule creation before OS spawn" }, ctx);
  assert.equal(creationFailure.error.code, "LARVA_CHILD_START_FAILED");
  assert.equal((await readFile(trace, "utf8")).trim().split("\n").map(JSON.parse).filter((r) => r.event === "child_spawn").length, 1);
  assert.deepEqual(JSON.parse(await readFile(join(agent, "settings.json"), "utf8")), settings);
  console.log(JSON.stringify({ checks: ["actual-asynchronous-EACCES", "typed-startup-error", "capsule-removed", "base-settings-preserved", "capsule-creation-failure-before-spawn", "no-base-fallback"], passed: 6 }));
} finally { await rm(root, { recursive: true, force: true }); }
