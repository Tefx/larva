#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const extensionUrl = pathToFileURL(join(root, "contrib/pi-extension/larva.ts"));
const results = [];
const fixtureDirs = [];

async function importFresh(name) {
  return await import(`${extensionUrl.href}?agent-persona-switch-policy=${encodeURIComponent(name)}-${Date.now()}-${Math.random()}`);
}

async function makeFakeLarvaCli(name) {
  const dir = await mkdtemp(join(tmpdir(), `larva-agent-persona-switch-${name}-`));
  fixtureDirs.push(dir);
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

async function makeRuntime(name, env = {}, overrides = {}) {
  const mod = await importFresh(name);
  const cli = await makeFakeLarvaCli(name);
  const registeredTools = [];
  const commands = {};
  const statuses = [];
  const notifications = [];
  const auditEntries = [];
  const chatMessages = [];
  const runtimeMessages = [];
  const handlers = {};
  const activeToolSets = [];
  const modelSetCalls = [];
  const ctx = {
    mode: overrides.mode ?? "headless",
    env: {
      HOME: dirname(cli),
      LARVA_PI_PERSONA_CANDIDATES_CACHE_FILE: join(dirname(cli), "persona-candidates.json"),
      LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, cli]),
      ...env,
    },
    ui: {
      setStatus: async (...args) => statuses.push(args),
      notify: async (message, type) => notifications.push({ message, type }),
      ...(overrides.ui ?? {}),
    },
    modelRegistry: { find: async () => ({ id: "model" }) },
    session: { appendEntry: (entry) => auditEntries.push(entry) },
    appendEntry: (customType, data) => auditEntries.push({ customType, data }),
    sendMessage: async (message, options) => runtimeMessages.push({ message, options }),
    sendUserMessage: async (message, options) => chatMessages.push({ message, options }),
    ...(overrides.ctx ?? {}),
  };
  const pi = {
    getAllTools: async () => ["read", "bash", "larva_persona_switch", "larva_personas", "larva_subagent_status"],
    setActiveTools: async (tools) => { activeToolSets.push(tools); return true; },
    setModel: async (model) => { modelSetCalls.push(model); return true; },
    registerCommand: (name, options) => { commands[name] = options; },
    registerTool: (tool) => { registeredTools.push(tool); },
    on: (event, handler) => { handlers[event] = handler; },
  };
  await mod.initializeExtension(ctx, pi);
  return { mod, ctx, pi, registeredTools, commands, statuses, notifications, auditEntries, chatMessages, runtimeMessages, handlers, activeToolSets, modelSetCalls };
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

await run("confirm mode auto-denies on timeout without mutating state", async () => {
  let selectOpts = null;
  const runtime = await makeRuntime("confirm-timeout", {
    LARVA_PI_AGENT_PERSONA_SWITCH: "confirm",
    LARVA_PI_AGENT_PERSONA_SWITCH_TIMEOUT_MS: "50",
  }, {
    mode: "tui",
    ui: {
      select: async (title, options, opts) => {
        selectOpts = opts;
        return new Promise(() => {});
      },
    },
  });
  const before = runtime.mod.getActiveEnvelope();
  const result = await runtime.mod.larva_persona_switch({ persona_id: "target", reason: "testing timeout auto-deny" }, runtime.ctx, runtime.pi);
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "LARVA_BAD_INPUT");
  assert.ok(result.error.message.includes("timed out"), "error message must indicate timeout");
  assert.ok(result.error.message.includes("automatically denied"), "error message must indicate automatic denial");
  assert.deepEqual(runtime.mod.getActiveEnvelope(), before, "persona state must remain unchanged after timeout");
  assert.ok(selectOpts, "select must receive options");
  assert.equal(selectOpts.timeout, 50, "select must receive configured timeout");
  assert.ok(selectOpts.signal, "select must receive abort signal");
  assert.ok(runtime.notifications.some((n) => n.message.includes("timed out")), "timeout warning notification emitted");
  assert.ok(runtime.auditEntries.some((e) => e.data?.approved === false && e.data?.denial_reason === "timeout"), "audit entry recorded denial_reason=timeout");
});

await run("routing guidance projection in prompt and tool descriptions (structural only)", async () => {
  const runtime = await makeRuntime("routing-guidance", { LARVA_PI_AGENT_PERSONA_SWITCH: "auto" });
  await runtime.commands["larva-persona"].handler("origin", runtime.ctx);
  const prompt = await runtime.mod.before_agent_start({ systemPrompt: "base prompt" }, runtime.ctx, runtime.pi);
  const systemPrompt = prompt?.systemPrompt ?? "";
  for (const token of [
    "current conversation or runtime continuity",
    "clean context",
    "route rationale",
    "larva_persona_switch.reason",
    "larva_subagent.task",
    "Do not ask the user for separate chat confirmation",
  ]) {
    assert.ok(systemPrompt.includes(token), `missing injected routing guidance token ${token}`);
  }

  const switchTool = runtime.registeredTools.find((item) => item.name === "larva_persona_switch");
  const subagentTool = runtime.registeredTools.find((item) => item.name === "larva_subagent");
  assert.ok(switchTool, "switch tool registered");
  assert.ok(subagentTool, "subagent tool registered");
  const switchText = JSON.stringify(switchTool);
  for (const token of [
    "inspected the target persona description or resolved definition",
    "reason must cite",
    "Call larva_persona_switch alone",
  ]) {
    assert.ok(switchText.includes(token), `missing switch tool token ${token}`);
  }
  const subagentText = JSON.stringify(subagentTool);
  for (const token of [
    "clean-context work",
    "independent review",
    "parallelizable work",
    "top of larva_subagent.task",
    "Do not use shell sleep polling",
  ]) {
    assert.ok(subagentText.includes(token), `missing subagent tool token ${token}`);
  }
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

await run("continue_task uses hidden custom runtime message plus minimal trigger and one-turn prompt addon", async () => {
  const runtime = await makeRuntime("continue-task", { LARVA_PI_AGENT_PERSONA_SWITCH: "auto" });
  await runtime.commands["larva-persona"].handler("origin", runtime.ctx);
  const switched = await runtime.mod.larva_persona_switch({ persona_id: "target", reason: "specialized response", handoff: "finish the task", continue_task: true }, runtime.ctx, runtime.pi);
  assert.equal(switched.status, "success");
  assert.equal(switched.terminate, true);
  await runtime.handlers.agent_end({ messages: [{ role: "assistant", stopReason: "stop" }] }, runtime.ctx);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(runtime.chatMessages.length, 1);
  assert.equal(runtime.chatMessages[0].message, "Continue.");
  assert.equal(runtime.runtimeMessages.length, 1);
  assert.equal(runtime.runtimeMessages[0].message.customType, "larva-agent-persona-switch-continuation");
  assert.equal(runtime.runtimeMessages[0].message.display, false);
  assert.deepEqual(runtime.runtimeMessages[0].options, { deliverAs: "nextTurn" });
  const prompt = await runtime.handlers.before_agent_start({ prompt: "Continue.", systemPrompt: "base" }, runtime.ctx);
  assert.ok(prompt.systemPrompt.includes("[Larva-generated continuation after persona switch]"));
  assert.ok(prompt.systemPrompt.includes("Prompt for target"));
  assert.ok(!prompt.systemPrompt.includes("Prompt for origin"));
  await runtime.handlers.agent_end({ messages: [{ role: "assistant", stopReason: "stop" }] }, runtime.ctx);
  assert.equal(runtime.mod.getActiveEnvelope().persona_id, "origin");
});

for (const [name, handoff] of [
  ["omitted", undefined],
  ["empty", ""],
  ["whitespace", " \n\t "],
  ["short", "  保留约束 😀\n文件 /tmp/notes.md  "],
  ["ascii-boundary", "a".repeat(1999) + "Z"],
  ["chinese-boundary", "中".repeat(1999) + "尾"],
  ["emoji-boundary", "😀".repeat(1999) + "🧪"],
  ["combined-emoji-boundary", "a".repeat(1997) + "👩‍💻"],
  ["trimmed-boundary", " \n" + "中".repeat(2000) + "\t "],
]) {
  await run(`handoff ${name} reaches continuation intact after trimming`, async () => {
    const runtime = await makeRuntime(`handoff-${name}`, { LARVA_PI_AGENT_PERSONA_SWITCH: "auto" });
    await runtime.commands["larva-persona"].handler("origin", runtime.ctx);
    const tool = runtime.registeredTools.find((item) => item.name === "larva_persona_switch");
    const input = { persona_id: "target", reason: "continue same-session work", continue_task: true };
    if (handoff !== undefined) input.handoff = handoff;
    const switched = await tool.execute("handoff", input, undefined, undefined, runtime.ctx);
    assert.equal(switched.isError, false);
    assert.equal(runtime.mod.getActiveEnvelope().persona_id, "target");
    await runtime.handlers.agent_end({ messages: [{ role: "assistant", stopReason: "stop" }] }, runtime.ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const expected = handoff?.trim() ?? "";
    assert.equal(runtime.runtimeMessages.length, 1);
    assert.equal(runtime.runtimeMessages[0].message.details.handoff, expected);
    const prompt = await runtime.handlers.before_agent_start({ prompt: "Continue.", systemPrompt: "base" }, runtime.ctx);
    assert.ok(prompt.systemPrompt.includes(`Handoff: ${expected}\nYou are now operating`));
    await runtime.handlers.agent_end({ messages: [{ role: "assistant", stopReason: "stop" }] }, runtime.ctx);
    assert.equal(runtime.mod.getActiveEnvelope().persona_id, "origin");
  });
}

for (const mode of ["auto", "free", "confirm"]) {
  await run(`invalid handoff fails before effects in ${mode} mode`, async () => {
    let confirmations = 0;
    const runtime = await makeRuntime(`handoff-rejected-${mode}`, { LARVA_PI_AGENT_PERSONA_SWITCH: mode }, {
      ui: { select: async () => { confirmations += 1; return "borrow_once"; } },
    });
    await runtime.commands["larva-persona"].handler("origin", runtime.ctx);
    const tool = runtime.registeredTools.find((item) => item.name === "larva_persona_switch");
    const before = runtime.mod.getActiveEnvelope();
    const toolCalls = runtime.activeToolSets.length;
    const modelCalls = runtime.modelSetCalls.length;
    for (const handoff of [
      "a".repeat(2000) + "TAIL_MARKER",
      "中".repeat(2001),
      "😀".repeat(2001),
      "a".repeat(1998) + "👩‍💻",
      null, 42, false, {}, [],
    ]) {
      const rejected = await tool.execute("invalid-handoff", {
        persona_id: "target", reason: "continue work", handoff,
        continue_task: true, max_switches_per_chain: 1,
      }, undefined, undefined, runtime.ctx);
      assert.equal(rejected.isError, true);
      assert.equal(rejected.details.error.code, "LARVA_BAD_INPUT");
      if (typeof handoff === "string") {
        assert.match(rejected.details.error.message, /2000 Unicode code points/);
      }
      assert.deepEqual(runtime.mod.getActiveEnvelope(), before);
      assert.equal(runtime.activeToolSets.length, toolCalls);
      assert.equal(runtime.modelSetCalls.length, modelCalls);
      assert.equal(confirmations, 0);
    }
    await runtime.handlers.agent_end({ messages: [{ role: "assistant", stopReason: "stop" }] }, runtime.ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(runtime.chatMessages.length, 0);
    assert.equal(runtime.runtimeMessages.length, 0);
    assert.deepEqual(runtime.mod.getActiveEnvelope(), before);
    assert.equal(runtime.activeToolSets.length, toolCalls, "no lease restore caused by rejected requests");
    if (mode !== "confirm") {
      const valid = await tool.execute("valid-after-rejection", {
        persona_id: "target", reason: "continue work", max_switches_per_chain: 1,
      }, undefined, undefined, runtime.ctx);
      assert.equal(valid.isError, false, "rejection must not consume the switch budget");
      await runtime.handlers.agent_end({ messages: [{ role: "assistant", stopReason: "stop" }] }, runtime.ctx);
    }
  });
}

await run("rejected handoff preserves an existing borrow and its pending continuation", async () => {
  const runtime = await makeRuntime("handoff-existing-lease", { LARVA_PI_AGENT_PERSONA_SWITCH: "auto" });
  await runtime.commands["larva-persona"].handler("origin", runtime.ctx);
  const switched = await runtime.mod.larva_persona_switch({
    persona_id: "target", reason: "same-session work", handoff: "original notes", continue_task: true,
  }, runtime.ctx, runtime.pi);
  assert.equal(switched.status, "success");
  const rejected = await runtime.mod.larva_persona_switch({
    persona_id: "other", reason: "invalid replacement", handoff: "中".repeat(2001), continue_task: true,
  }, runtime.ctx, runtime.pi);
  assert.equal(rejected.error.code, "LARVA_BAD_INPUT");
  assert.equal(runtime.mod.getActiveEnvelope().persona_id, "target");
  await runtime.handlers.agent_end({ messages: [{ role: "assistant", stopReason: "stop" }] }, runtime.ctx);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(runtime.runtimeMessages.length, 1);
  assert.equal(runtime.runtimeMessages[0].message.details.handoff, "original notes");
  assert.equal(runtime.runtimeMessages[0].message.details.to_persona_id, "target");
  await runtime.handlers.before_agent_start({ prompt: "Continue.", systemPrompt: "base" }, runtime.ctx);
  await runtime.handlers.agent_end({ messages: [{ role: "assistant", stopReason: "stop" }] }, runtime.ctx);
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

await Promise.all(fixtureDirs.map((dir) => rm(dir, { recursive: true, force: true })));
const failed = results.filter((result) => result.status === "FAIL");
console.log(JSON.stringify({ status: failed.length === 0 ? "PASS" : "FAIL", results }, null, 2));
if (failed.length > 0) process.exit(1);
