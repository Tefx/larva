#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const extensionUrl = pathToFileURL(join(root, "contrib/pi-extension/larva.ts"));
const results = [];

function piPackageRoot() {
  const envPath = process.env.LARVA_TEST_PI_CODING_AGENT;
  if (typeof envPath === "string" && envPath.length > 0) return envPath;
  const localPkg = join(root, "contrib/pi-extension/node_modules/@earendil-works/pi-coding-agent");
  if (existsSync(localPkg)) return localPkg;
  throw new Error("LARVA_TEST_PI_CODING_AGENT must point at the worktree Pi package");
}

async function importFresh(name) {
  return await import(`${extensionUrl.href}?resolver=${encodeURIComponent(name)}-${Date.now()}-${Math.random()}`);
}

async function loadEventBus() {
  const { createEventBus } = await import(pathToFileURL(join(piPackageRoot(), "dist/core/event-bus.js")).href);
  return createEventBus();
}

async function makeFakeCli(name, personas = ["origin", "target"]) {
  const dir = await mkdtemp(join(tmpdir(), `larva-resolver-${name}-`));
  const cli = join(dir, "fake-larva-cli.mjs");
  await writeFile(cli, `
const [, , command, arg, jsonFlag] = process.argv;
if (command === "resolve" && jsonFlag === "--json") {
  process.stdout.write(JSON.stringify({ data: {
    id: arg,
    description: "Persona " + arg,
    prompt: "Prompt for " + arg,
    model: "loopback/model",
    capabilities: {},
    spec_version: "0.1.0",
    spec_digest: "sha256:" + arg,
    can_spawn: true
  }}));
  process.exit(0);
}
if (command === "list" && arg === "--json") {
  process.stdout.write(JSON.stringify({ data: ${JSON.stringify(personas.map((id) => ({ id, description: id, model: "loopback/model", spec_digest: `sha256:${id}`, capabilities: {} })))} }));
  process.exit(0);
}
process.exit(3);
`, "utf8");
  return cli;
}

async function boot(name, env = {}, extraPi = {}) {
  const mod = await importFresh(name);
  const events = await loadEventBus();
  const cli = await makeFakeCli(name);
  const handlers = {};
  const auditEntries = [];
  const chatMessages = [];
  const runtimeMessages = [];
  const ctx = {
    env: {
      LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, cli]),
      LARVA_PI_AGENT_PERSONA_SWITCH: "auto",
      ...env,
    },
    ui: { setStatus: async () => {}, notify: async () => {} },
    modelRegistry: { find: async () => ({ id: "model" }) },
    session: { appendEntry: (entry) => auditEntries.push(entry) },
    appendEntry: (customType, data) => auditEntries.push({ customType, data }),
    sendMessage: async (message, options) => runtimeMessages.push({ message, options }),
    sendUserMessage: async (message, options) => chatMessages.push({ message, options }),
  };
  const pi = {
    events,
    getAllTools: async () => ["read", "larva_persona_switch", "larva_personas"],
    setActiveTools: async () => true,
    setModel: async () => true,
    registerCommand: () => {},
    registerTool: () => {},
    on: (event, handler) => { handlers[event] = handler; },
    ...extraPi,
  };
  await mod.initializeExtension(ctx, pi);
  return { mod, ctx, pi, events, handlers, auditEntries, chatMessages, runtimeMessages };
}

function emitResolve(events, eventName, systemPrompt, extra = {}) {
  const replies = [];
  events.emit(eventName, {
    scope: "main",
    systemPrompt,
    reply: (result) => replies.push(result),
    ...extra,
  });
  return replies;
}

async function run(name, fn) {
  try {
    await fn();
    results.push({ name, status: "PASS" });
  } catch (error) {
    results.push({ name, status: "FAIL", message: error?.stack || String(error) });
  }
}

await run("ready none cleans stale managed text and keeps pure base", async () => {
  const runtime = await boot("ready-none", { LARVA_PI_AGENT_PERSONA_SWITCH: "manual" });
  const stale = [
    "<!-- larva:identity-policy:begin -->",
    "stale identity",
    "<!-- larva:identity-policy:end -->",
    "",
    "Only Pi base",
    "",
    "<!-- larva:active-persona:begin -->",
    "<!-- larva-spec: old@x -->",
    "stale prompt",
    "<!-- larva:active-persona:end -->",
  ].join("\n");
  const replies = emitResolve(runtime.events, runtime.mod.LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, stale);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].status, "ok");
  assert.equal(replies[0].systemPrompt.includes("stale identity"), false);
  assert.equal(replies[0].systemPrompt.includes("stale prompt"), false);
  assert.ok(replies[0].systemPrompt.includes("Only Pi base"));
  const pure = emitResolve(runtime.events, runtime.mod.LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, "Only Pi base");
  assert.equal(pure[0].status, "ok");
  assert.equal(pure[0].systemPrompt, "Only Pi base");
});

await run("A-B-A restore deletes B blocks and equals current A composition", async () => {
  const runtime = await boot("aba", { LARVA_PI_INITIAL_PERSONA_ID: "origin" });
  const first = emitResolve(runtime.events, runtime.mod.LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, "shared base");
  assert.equal(first[0].status, "ok");
  assert.ok(first[0].systemPrompt.includes("Prompt for origin"));
  const switched = await runtime.mod.larva_persona_switch({
    persona_id: "target",
    reason: "specialized response after inspecting target description",
  }, runtime.ctx, runtime.pi);
  assert.equal(switched.status, "success");
  const borrowed = emitResolve(runtime.events, runtime.mod.LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, first[0].systemPrompt);
  assert.equal(borrowed[0].status, "ok");
  assert.ok(borrowed[0].systemPrompt.includes("Prompt for target"));
  assert.equal(borrowed[0].systemPrompt.includes("Prompt for origin"), false);
  await runtime.handlers.agent_end({ messages: [{ role: "assistant", stopReason: "stop" }] }, runtime.ctx);
  const restored = emitResolve(runtime.events, runtime.mod.LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, borrowed[0].systemPrompt);
  assert.equal(restored[0].status, "ok");
  assert.equal(restored[0].systemPrompt, first[0].systemPrompt);
  assert.ok(restored[0].systemPrompt.includes("Prompt for origin"));
  assert.equal(restored[0].systemPrompt.includes("Prompt for target"), false);
});

await run("pending ended and manually cleared continuation stay out of composition", async () => {
  const runtime = await boot("cont-lifecycle", { LARVA_PI_INITIAL_PERSONA_ID: "origin" });
  const switched = await runtime.mod.larva_persona_switch({
    persona_id: "target",
    reason: "specialized response after inspecting target description",
    continue_task: true,
  }, runtime.ctx, runtime.pi);
  assert.equal(switched.status, "success");
  const pending = emitResolve(runtime.events, runtime.mod.LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, "Pi base");
  assert.equal(pending[0].status, "ok");
  assert.equal(pending[0].systemPrompt.includes("<larva_persona_switch_continuation>"), false);
  await runtime.handlers.agent_end({ messages: [{ role: "assistant", stopReason: "stop" }] }, runtime.ctx);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const running = emitResolve(runtime.events, runtime.mod.LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, "Pi base");
  assert.equal(running[0].status, "ok");
  assert.ok(running[0].systemPrompt.includes("<larva_persona_switch_continuation>"));
  const fixed = emitResolve(runtime.events, runtime.mod.LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, running[0].systemPrompt);
  assert.equal(fixed[0].systemPrompt, running[0].systemPrompt);
  await runtime.handlers.agent_end({ messages: [{ role: "assistant", stopReason: "stop" }] }, runtime.ctx);
  const ended = emitResolve(runtime.events, runtime.mod.LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, running[0].systemPrompt);
  assert.equal(ended[0].status, "ok");
  assert.equal(ended[0].systemPrompt.includes("<larva_persona_switch_continuation>"), false);
  assert.ok(ended[0].systemPrompt.includes("Prompt for origin"));

  const runtime2 = await boot("cont-manual", { LARVA_PI_INITIAL_PERSONA_ID: "origin" });
  await runtime2.mod.larva_persona_switch({
    persona_id: "target",
    reason: "specialized response after inspecting target description",
    continue_task: true,
  }, runtime2.ctx, runtime2.pi);
  await runtime2.handlers.agent_end({ messages: [{ role: "assistant", stopReason: "stop" }] }, runtime2.ctx);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const beforeManual = emitResolve(runtime2.events, runtime2.mod.LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, "Pi base");
  assert.ok(beforeManual[0].systemPrompt.includes("<larva_persona_switch_continuation>"));
  const manual = await runtime2.mod.handlePersonaCommand("origin", runtime2.ctx, runtime2.pi);
  assert.equal(manual.ok, true);
  const afterManual = emitResolve(runtime2.events, runtime2.mod.LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, beforeManual[0].systemPrompt);
  assert.equal(afterManual[0].systemPrompt.includes("<larva_persona_switch_continuation>"), false);
});

await run("true post-resolution state change still projects", async () => {
  const runtime = await boot("post-change", { LARVA_PI_INITIAL_PERSONA_ID: "origin" });
  const origin = emitResolve(runtime.events, runtime.mod.LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, "Pi base");
  const switched = await runtime.mod.larva_persona_switch({
    persona_id: "target",
    reason: "specialized response after inspecting target description",
  }, runtime.ctx, runtime.pi);
  assert.equal(switched.status, "success");
  const eventCtx = { model: { api: "openai-completions" }, ui: runtime.ctx.ui };
  const projected = await runtime.handlers.before_provider_request({
    payload: { messages: [{ role: "system", content: origin[0].systemPrompt }, { role: "user", content: "hi" }] },
  }, eventCtx);
  assert.ok(projected.messages[0].content.includes("Prompt for target"));
  assert.equal(projected.messages[0].content.includes("Prompt for origin"), false);
  assert.equal(projected.messages[1].content, "hi");
});

await run("synchronous invalid reply-throw and nested queries isolate one attempt each", async () => {
  const runtime = await boot("sync-errors", { LARVA_PI_AGENT_PERSONA_SWITCH: "manual" });
  const eventName = runtime.mod.LARVA_RESOLVE_SYSTEM_PROMPT_EVENT;
  const invalid = emitResolve(runtime.events, eventName, "base", { scope: "child" });
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0].status, "unavailable");
  assert.equal(typeof invalid[0].reason, "string");
  assert.ok(invalid[0].reason.length > 0);

  const silent = [];
  runtime.events.emit(eventName, { scope: "main", systemPrompt: "base" });
  runtime.events.emit(eventName, { scope: "main", systemPrompt: 1, reply: (result) => silent.push(result) });
  assert.equal(silent.length, 1);
  assert.equal(silent[0].status, "unavailable");

  let attempts = 0;
  runtime.events.emit(eventName, {
    scope: "main",
    systemPrompt: "base",
    reply: () => {
      attempts += 1;
      throw new Error("consumer boom");
    },
  });
  assert.equal(attempts, 1);

  const outer = [];
  const inner = [];
  runtime.events.emit(eventName, {
    scope: "main",
    systemPrompt: "outer",
    reply: (result) => {
      outer.push(result);
      runtime.events.emit(eventName, {
        scope: "main",
        systemPrompt: "inner",
        reply: (nested) => inner.push(nested),
      });
    },
  });
  assert.equal(outer.length, 1);
  assert.equal(inner.length, 1);
  assert.equal(outer[0].status, "ok");
  assert.equal(inner[0].status, "ok");
  assert.ok(outer[0].systemPrompt.includes("outer"));
  assert.ok(inner[0].systemPrompt.includes("inner"));
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.equal(outer.length, 1);
  assert.equal(inner.length, 1);
});

await run("resolver reads do not mutate lease continuation counters or queues", async () => {
  const runtime = await boot("readonly", { LARVA_PI_INITIAL_PERSONA_ID: "origin" });
  await runtime.mod.larva_persona_switch({
    persona_id: "target",
    reason: "specialized response after inspecting target description",
    continue_task: true,
  }, runtime.ctx, runtime.pi);
  const before = JSON.stringify({
    envelope: runtime.mod.getActiveEnvelope(),
    audit: runtime.auditEntries,
    chat: runtime.chatMessages,
    runtimeMessages: runtime.runtimeMessages,
  });
  for (let index = 0; index < 3; index += 1) {
    const replies = emitResolve(runtime.events, runtime.mod.LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, "Pi base");
    assert.equal(replies[0].status, "ok");
  }
  const after = JSON.stringify({
    envelope: runtime.mod.getActiveEnvelope(),
    audit: runtime.auditEntries,
    chat: runtime.chatMessages,
    runtimeMessages: runtime.runtimeMessages,
  });
  assert.equal(after, before);
});

await run("incomplete initialization replies unavailable then current state after commit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "larva-resolver-hang-"));
  const gate = join(dir, "go");
  const cli = join(dir, "cli.mjs");
  await writeFile(cli, `
import { existsSync } from "node:fs";
const [, , command, arg, jsonFlag] = process.argv;
const gate = ${JSON.stringify(gate)};
if (command === "resolve" && jsonFlag === "--json") {
  const start = Date.now();
  while (!existsSync(gate) && Date.now() - start < 5000) {}
  process.stdout.write(JSON.stringify({ data: {
    id: arg, description: arg, prompt: "Prompt for " + arg, model: "loopback/model",
    capabilities: {}, spec_version: "0.1.0", spec_digest: "sha256:" + arg, can_spawn: true
  }}));
  process.exit(0);
}
process.exit(3);
`, "utf8");
  const mod = await importFresh("interleave");
  const events = await loadEventBus();
  const ctx = {
    env: {
      LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, cli]),
      LARVA_PI_INITIAL_PERSONA_ID: "origin",
      LARVA_PI_AGENT_PERSONA_SWITCH: "manual",
    },
    ui: { setStatus: async () => {}, notify: async () => {} },
    modelRegistry: { find: async () => ({ id: "model" }) },
  };
  const pi = {
    events,
    getAllTools: async () => ["read"],
    setActiveTools: async () => true,
    setModel: async () => true,
    registerCommand: () => {},
    registerTool: () => {},
    on: () => {},
  };
  const pending = mod.initializeExtension(ctx, pi);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const during = emitResolve(events, mod.LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, "Pi base");
  assert.equal(during.length, 1);
  assert.equal(during[0].status, "unavailable");
  await writeFile(gate, "go", "utf8");
  await pending;
  const after = emitResolve(events, mod.LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, "Pi base");
  assert.equal(after[0].status, "ok");
  assert.ok(after[0].systemPrompt.includes("Prompt for origin"));
});

await run("shutdown unsubscribes before async cleanup and late init cannot revive", async () => {
  const runtime = await boot("shutdown", { LARVA_PI_AGENT_PERSONA_SWITCH: "manual" });
  const before = emitResolve(runtime.events, runtime.mod.LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, "Pi base");
  assert.equal(before[0].status, "ok");
  const shutdown = runtime.handlers.session_shutdown({ reason: "reload" });
  const after = emitResolve(runtime.events, runtime.mod.LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, "Pi base");
  assert.equal(after.length, 0);
  await shutdown;
  const later = emitResolve(runtime.events, runtime.mod.LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, "Pi base");
  assert.equal(later.length, 0);
});

await run("idempotent setup keeps a single listener", async () => {
  const runtime = await boot("idempotent-setup", { LARVA_PI_AGENT_PERSONA_SWITCH: "manual" });
  await runtime.mod.initializeExtension(runtime.ctx, runtime.pi);
  const replies = emitResolve(runtime.events, runtime.mod.LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, "Pi base");
  assert.equal(replies.length, 1);
});

await run("crossed identity and persona markers fail without swallowing foreign text", async () => {
  const mod = await importFresh("crossed");
  const damaged = "<!-- larva:identity-policy:begin -->\nKeep foreign\n<!-- larva:active-persona:end -->";
  const result = mod.composeLarvaSystemPrompt(damaged, { envelope: null, switchGuidance: null, continuationMessage: null });
  assert.equal(result.status, "unavailable");
  assert.equal(damaged.includes("Keep foreign"), true);
});

await run("no-persona known slot without stale content stays unchanged and does not insert empty slots", async () => {
  const mod = await importFresh("no-persona-slots");
  assert.equal(mod.projectLarvaIdentityIntoProviderPayload({
    messages: [{ role: "user", content: "hi" }],
  }, null, "openai-completions").status, "unchanged");
  assert.equal(mod.projectLarvaIdentityIntoProviderPayload({
    config: { temperature: 0.2 },
  }, null, "google-generative-ai").status, "unchanged");
});

const failed = results.filter((result) => result.status === "FAIL");
for (const result of results) {
  process.stdout.write(`${result.status} ${result.name}${result.message ? `\n${result.message}` : ""}\n`);
}
if (failed.length > 0) process.exit(1);
