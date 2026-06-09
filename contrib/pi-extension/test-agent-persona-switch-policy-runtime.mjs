#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const extensionUrl = pathToFileURL(join(root, "contrib/pi-extension/larva.ts"));
const results = [];

async function importFresh(name) {
  return await import(`${extensionUrl.href}?agent-persona-switch-policy=${encodeURIComponent(name)}-${Date.now()}-${Math.random()}`);
}

async function makeFakeLarvaCli(name) {
  const dir = await mkdtemp(join(tmpdir(), `larva-agent-persona-switch-${name}-`));
  const cli = join(dir, "fake-larva-cli.mjs");
  await writeFile(cli, `
const [, , command, arg, jsonFlag] = process.argv;
if (command === "resolve" && jsonFlag === "--json") {
  process.stdout.write(JSON.stringify({ data: {
    id: arg,
    description: "Persona " + arg,
    prompt: "Prompt for " + arg,
    model: "provider/model",
    capabilities: {},
    spec_version: "0.1.0",
    spec_digest: "sha256:" + arg,
    can_spawn: true
  }}));
  process.exit(0);
}
if (command === "list" && arg === "--json") {
  process.stdout.write(JSON.stringify({ data: [
    { id: "origin", description: "Origin", model: "provider/model", spec_digest: "sha256:origin", capabilities: {} },
    { id: "target", description: "Target", model: "provider/model", spec_digest: "sha256:target", capabilities: {} }
  ] }));
  process.exit(0);
}
process.exit(3);
`, "utf8");
  return cli;
}

async function makeRuntime(name, env = {}) {
  const mod = await importFresh(name);
  const cli = await makeFakeLarvaCli(name);
  const registeredTools = [];
  const commands = {};
  const statuses = [];
  const notifications = [];
  const auditEntries = [];
  const chatMessages = [];
  const activeToolSets = [];
  const ctx = {
    env: {
      LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, cli]),
      ...env,
    },
    ui: {
      setStatus: async (...args) => statuses.push(args),
      notify: async (message, type) => notifications.push({ message, type }),
    },
    modelRegistry: { find: async () => ({ id: "model" }) },
    session: { appendEntry: (entry) => auditEntries.push(entry) },
    appendEntry: (customType, data) => auditEntries.push({ customType, data }),
    sendUserMessage: async (message, options) => chatMessages.push({ message, options }),
  };
  const pi = {
    getAllTools: async () => ["read", "bash", "larva_persona_switch", "larva_personas", "larva_subagent_status"],
    setActiveTools: async (tools) => { activeToolSets.push(tools); return true; },
    setModel: async () => true,
    registerCommand: (name, options) => { commands[name] = options; },
    registerTool: (tool) => { registeredTools.push(tool); },
    on: () => undefined,
  };
  await mod.initializeExtension(ctx, pi);
  return { mod, ctx, pi, registeredTools, commands, statuses, notifications, auditEntries, chatMessages, activeToolSets };
}

async function run(name, fn) {
  try {
    await fn();
    results.push({ name, status: "PASS" });
  } catch (error) {
    results.push({ name, status: "FAIL", message: error?.stack || String(error) });
  }
}

await run("modes are exactly manual/confirm/auto/free with default confirm and no aliases", async () => {
  const runtime = await makeRuntime("default-mode");
  const completions = await runtime.commands["larva-mode"].getArgumentCompletions("");
  assert.deepEqual(completions.map((item) => item.value), ["manual", "confirm", "auto", "free"]);
  assert.ok(runtime.registeredTools.some((tool) => tool.name === "larva_persona_switch"), "default confirm exposes request tool");

  for (const legacy of ["off", "ask"]) {
    const legacyRuntime = await makeRuntime(`legacy-${legacy}`, { LARVA_PI_AGENT_PERSONA_SWITCH: legacy });
    assert.ok(legacyRuntime.registeredTools.some((tool) => tool.name === "larva_persona_switch"), `${legacy} must fail-safe to confirm`);
    assert.ok(legacyRuntime.notifications.some((notice) => /unknown|invalid/i.test(notice.message) && /confirm/.test(notice.message)));
  }
});

await run("manual mode rejects autonomous switch tools while /larva-persona still works and creates no lease", async () => {
  const runtime = await makeRuntime("manual", { LARVA_PI_AGENT_PERSONA_SWITCH: "manual" });
  assert.ok(!runtime.registeredTools.some((tool) => tool.name === "larva_persona_switch"));
  assert.equal(runtime.mod.decideToolCall("larva_persona_switch").action, "deny");
  const forged = await runtime.mod.larva_persona_switch({ persona_id: "target", reason: "forged stale call" }, runtime.ctx, runtime.pi);
  assert.equal(forged.status, "failed");
  assert.equal(forged.error.code, "LARVA_AGENT_PERSONA_SWITCH_MANUAL");
  const manual = await runtime.commands["larva-persona"].handler("target", runtime.ctx);
  assert.equal(manual.ok, true);
  assert.equal(runtime.mod.getActiveEnvelope().persona_id, "target");
  assert.ok(!JSON.stringify(runtime.auditEntries).includes("PersonaLease"));
});

await run("confirm mode has four outcomes and all non-approval paths fail safely", async () => {
  const runtime = await makeRuntime("confirm", { LARVA_PI_AGENT_PERSONA_SWITCH: "confirm" });
  const mode = await runtime.commands["larva-mode"].handler("confirm", runtime.ctx);
  assert.equal(mode.ok, true);
  const tool = runtime.registeredTools.find((item) => item.name === "larva_persona_switch");
  assert.ok(tool, "confirm exposes request tool");
  const serialized = JSON.stringify(tool);
  for (const label of ["Borrow once", "Deny", "Auto-borrow for this session", "Switch persistently"]) {
    assert.ok(serialized.includes(label), `missing confirm outcome ${label}`);
  }
  const before = runtime.mod.getActiveEnvelope();
  const deniedOrUnavailable = await runtime.mod.larva_persona_switch({ persona_id: "target", reason: "needs target" }, runtime.ctx, runtime.pi);
  assert.equal(deniedOrUnavailable.status, "failed");
  assert.deepEqual(runtime.mod.getActiveEnvelope(), before, "missing UI/deny/cancel/timeout must preserve state");
});

await run("auto mode borrows temporarily and restores at assistant turn end", async () => {
  const runtime = await makeRuntime("auto", { LARVA_PI_AGENT_PERSONA_SWITCH: "auto" });
  const origin = await runtime.commands["larva-persona"].handler("origin", runtime.ctx);
  assert.equal(origin.ok, true);
  const switched = await runtime.mod.larva_persona_switch({ persona_id: "target", reason: "specialized response" }, runtime.ctx, runtime.pi);
  assert.equal(switched.status, "success");
  assert.equal(switched.details.lease.scope, "turn");
  assert.equal(switched.details.lease.originPersonaId, "origin");
  assert.equal(runtime.mod.getActiveEnvelope().persona_id, "target");
  await runtime.mod.before_agent_start({ systemPrompt: "base", terminal: "success" });
  assert.equal(runtime.mod.getActiveEnvelope().persona_id, "origin");
});

await run("free mode switches persistently without lease or restore", async () => {
  const runtime = await makeRuntime("free", { LARVA_PI_AGENT_PERSONA_SWITCH: "free" });
  await runtime.commands["larva-persona"].handler("origin", runtime.ctx);
  const switched = await runtime.mod.larva_persona_switch({ persona_id: "target", reason: "free switch" }, runtime.ctx, runtime.pi);
  assert.equal(switched.status, "success");
  assert.equal(switched.details.lease, null);
  await runtime.mod.before_agent_start({ systemPrompt: "base", terminal: "success" });
  assert.equal(runtime.mod.getActiveEnvelope().persona_id, "target");
});

await run("manual user switch during active lease clears lease and blocks old-origin restore", async () => {
  const runtime = await makeRuntime("manual-wins", { LARVA_PI_AGENT_PERSONA_SWITCH: "auto" });
  await runtime.commands["larva-persona"].handler("origin", runtime.ctx);
  await runtime.mod.larva_persona_switch({ persona_id: "target", reason: "borrow target" }, runtime.ctx, runtime.pi);
  await runtime.commands["larva-persona"].handler("manual-choice", runtime.ctx);
  await runtime.mod.before_agent_start({ systemPrompt: "base", terminal: "success" });
  assert.equal(runtime.mod.getActiveEnvelope().persona_id, "manual-choice");
});

await run("restore notices are status/event/audit only and never assistant chat body", async () => {
  const runtime = await makeRuntime("restore-notices", { LARVA_PI_AGENT_PERSONA_SWITCH: "auto" });
  await runtime.commands["larva-persona"].handler("origin", runtime.ctx);
  await runtime.mod.larva_persona_switch({ persona_id: "target", reason: "borrow target" }, runtime.ctx, runtime.pi);
  await runtime.mod.before_agent_start({ systemPrompt: "base", terminal: "success" });
  assert.ok(runtime.statuses.length > 0 || runtime.auditEntries.length > 0 || runtime.notifications.length > 0);
  assert.equal(runtime.chatMessages.length, 0, "restore must not inject chat-body messages");
});

await run("generic deterministic subagent orchestration tasks do not own persona leases", async () => {
  const runtime = await makeRuntime("generic-tasks", { LARVA_PI_AGENT_PERSONA_SWITCH: "auto" });
  const deterministicTools = runtime.registeredTools.filter((tool) => /larva_subagent_(status|events|wait|select|cancel)/.test(tool.name));
  assert.ok(deterministicTools.length >= 5, "deterministic orchestration tools should still be registered");
  assert.ok(!JSON.stringify(deterministicTools).includes("agent_session"));
  assert.ok(!JSON.stringify(deterministicTools).includes("PersonaLease"));
});

const failed = results.filter((result) => result.status === "FAIL");
console.log(JSON.stringify({ status: failed.length === 0 ? "PASS" : "FAIL", results }, null, 2));
if (failed.length > 0) process.exit(1);
