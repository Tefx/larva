import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const extensionPath = join(root, "contrib/pi-extension/larva.ts");
const extensionUrl = pathToFileURL(extensionPath);

async function importFresh(name) {
  return await import(`${extensionUrl.href}?case=${encodeURIComponent(name)}-${Date.now()}-${Math.random()}`);
}

async function makeFakeCli(dir) {
  const cli = join(dir, "fake-larva-cli.mjs");
  await writeFile(cli, `
const [, , command, personaId, jsonFlag] = process.argv;
if (command !== "resolve" || jsonFlag !== "--json") process.exit(3);
process.stdout.write(JSON.stringify({ data: {
  id: personaId,
  description: "Persona " + personaId,
  prompt: "Prompt for " + personaId,
  model: "provider/model",
  capabilities: {},
  spec_version: "0.1.0",
  spec_digest: "sha256:" + personaId,
  can_spawn: true
}}));
`, "utf8");
  return cli;
}

async function makeFakePi(dir) {
  const fakePi = join(dir, "fake-pi.mjs");
  await writeFile(fakePi, `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const sessionDirIndex = process.argv.indexOf("--session-dir");
const sessionDir = sessionDirIndex >= 0 ? process.argv[sessionDirIndex + 1] : process.cwd();
const sessionFile = join(sessionDir, "child-session.jsonl");
const releaseFile = process.env.LARVA_TEST_RELEASE_FILE;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const rl = createInterface({ input: process.stdin });

rl.on("line", async (line) => {
  const message = JSON.parse(line);
  if (message.type === "get_state") {
    await mkdir(sessionDir, { recursive: true });
    await writeFile(sessionFile, "", "utf8");
    send({ id: message.id, success: true, data: { sessionFile } });
    return;
  }
  if (message.type === "switch_session") {
    send({ id: message.id, success: true, data: {} });
    return;
  }
  if (message.type === "prompt") {
    send({ id: message.id, success: true, data: {} });
    const timer = setInterval(() => {
      if (!releaseFile || existsSync(releaseFile)) {
        clearInterval(timer);
        send({ type: "agent_end" });
      }
    }, 10);
    return;
  }
  if (message.type === "get_last_assistant_text") {
    send({ id: message.id, success: true, data: { text: "child final text" } });
  }
});
`, "utf8");
  await chmod(fakePi, 0o755);
  return fakePi;
}

function assertFailedLimit(mod, input) {
  const result = mod.larva_subagent_sessions(input);
  assert.equal(result.isError, true);
  assert.equal(result.details.status, "failed");
  assert.deepEqual(result.details.sessions, []);
  assert.equal(result.details.error.code, "LARVA_BAD_INPUT");
  assert.equal(result.content[0].text, "LARVA_BAD_INPUT: limit must be an integer from 1 to 25.");
}

const mod = await importFresh("subagent-sessions-helper");
mod.resetSubagentPresentationStateForTests();

assert.equal(mod.larva_subagent_sessions().isError, false);
assert.equal(mod.larva_subagent_sessions().details.sessions.length, 0);
assertFailedLimit(mod, { limit: 0 });
assertFailedLimit(mod, { limit: 26 });
assertFailedLimit(mod, { limit: 1.5 });
assertFailedLimit(mod, { limit: "2" });
assertFailedLimit(mod, 5);
console.log("limit validation: PASS");

mod.recordSubagentPresentationEntryForTests(null, "ignored", "success");
mod.recordSubagentPresentationEntryForTests("/tmp/one.jsonl", "alpha", "success");
mod.recordSubagentPresentationEntryForTests("/tmp/two.jsonl", "beta", "running");
mod.recordSubagentPresentationEntryForTests("/tmp/one.jsonl", "alpha", "cancelled");
const unique = mod.larva_subagent_sessions({ limit: 10 });
assert.equal(Object.hasOwn(unique, "sessions"), false);
assert.deepEqual(unique.details.sessions.map((session) => [session.task_id, session.persona_id, session.last_status]), [
  ["/tmp/one.jsonl", "alpha", "cancelled"],
  ["/tmp/two.jsonl", "beta", "running"],
]);
assert.ok(unique.details.sessions[0].sequence > unique.details.sessions[1].sequence);
console.log("newest-first unique summaries: PASS");

mod.resetSubagentPresentationStateForTests();
for (let index = 0; index < 26; index += 1) {
  mod.recordSubagentPresentationEntryForTests(`/tmp/evicted-${index}.jsonl`, "evict", "success");
}
const retained = mod.larva_subagent_sessions({ limit: 25 }).details.sessions;
assert.equal(retained.length, 25);
assert.equal(retained.some((session) => session.task_id === "/tmp/evicted-0.jsonl"), false);
assert.equal(retained[0].task_id, "/tmp/evicted-25.jsonl");
mod.resetSubagentPresentationStateForTests();
assert.equal(mod.larva_subagent_sessions({ limit: 25 }).details.sessions.length, 0);
console.log("retention eviction and reset: PASS");

const runtimeDir = await mkdtemp(join(tmpdir(), "larva-pi-sessions-helper-"));
const fakeCli = await makeFakeCli(runtimeDir);
const fakePi = await makeFakePi(runtimeDir);
const sessionDir = join(runtimeDir, "sessions");
const releaseFile = join(runtimeDir, "release");
await mkdir(sessionDir, { recursive: true });

const env = {
  LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, fakeCli]),
  LARVA_PI_REAL_BIN: fakePi,
  LARVA_PI_EXTENSION_FLAG: "-e",
  LARVA_PI_EXTENSION_ENTRY: join(runtimeDir, "extension.ts"),
  LARVA_PI_CHILD_SESSION_DIR: sessionDir,
  LARVA_TEST_RELEASE_FILE: releaseFile,
};
const ctx = {
  env,
  ui: { setStatus: async () => undefined },
  modelRegistry: { find: async () => ({}) },
};
const pi = {
  getAllTools: async () => ["larva_subagent"],
  setActiveTools: async () => true,
  setModel: async () => true,
  registerCommand: () => undefined,
  registerTool: () => undefined,
  on: () => undefined,
};
const committed = await mod.handlePersonaCommand("parent", ctx, pi);
assert.equal(committed.ok, true);

const runningPromise = mod.larva_subagent({ persona_id: "child", task: "wait until released" }, { env });
let runningSummary = null;
for (let attempt = 0; attempt < 80; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 25));
  const sessions = mod.larva_subagent_sessions({ limit: 10 }).details.sessions;
  if (sessions[0]?.last_status === "running") {
    runningSummary = sessions[0];
    break;
  }
}
assert.ok(runningSummary, "allocated session should be visible while the child is still running");
assert.equal(mod.isSubagentTaskBusyForTests(runningSummary.task_id), true);
const busyResume = await mod.larva_subagent({ persona_id: "child", task: "resume while busy", task_id: runningSummary.task_id }, { env });
assert.equal(busyResume.status, "failed");
assert.equal(busyResume.error.code, "LARVA_SESSION_BUSY");

await writeFile(releaseFile, "release", "utf8");
const finalResult = await runningPromise;
assert.equal(finalResult.status, "success");
assert.equal(finalResult.task_id, runningSummary.task_id);
assert.equal(mod.isSubagentTaskBusyForTests(runningSummary.task_id), false);
const finalSummary = mod.larva_subagent_sessions({ limit: 10 }).details.sessions[0];
assert.equal(finalSummary.task_id, runningSummary.task_id);
assert.equal(finalSummary.last_status, "success");
assert.ok(finalSummary.sequence > runningSummary.sequence);
console.log("running allocation and busy resume: PASS");

const source = await readFile(extensionPath, "utf8");
const helperStart = source.indexOf("export function larva_subagent_sessions");
const helperEnd = source.indexOf("function subagentMode", helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart);
const helperSource = source.slice(helperStart, helperEnd);
for (const forbidden of ["readdir(", "opendir(", "glob(", "readFile(", "realpath(", "stat(", "lstat(", "JSON.parse("]) {
  assert.equal(helperSource.includes(forbidden), false, `helper must not use ${forbidden}`);
}
assert.equal(source.includes("recentSubagentSessions"), false);
assert.ok(source.includes("retainedSubagentPresentationLog"));
console.log("no filesystem scan or raw JSONL helper dependency: PASS");

console.log("subagent sessions helper: PASS");
