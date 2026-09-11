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

const LARVA_IDENTITY_POLICY_BEGIN = "<!-- larva:identity-policy:begin -->";
const LARVA_IDENTITY_POLICY_END = "<!-- larva:identity-policy:end -->";
const LARVA_ACTIVE_PERSONA_BEGIN = "<!-- larva:active-persona:begin -->";
const LARVA_ACTIVE_PERSONA_END = "<!-- larva:active-persona:end -->";
const LARVA_PERSONA_SWITCH_CONTINUATION_PROMPT_BEGIN = "<larva_persona_switch_continuation>";
const LARVA_PERSONA_SWITCH_CONTINUATION_PROMPT_END = "</larva_persona_switch_continuation>";

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
  const records = personas.map((id) => ({
    id,
    description: "Persona " + id,
    prompt: "Prompt for " + id,
    model: "loopback/model",
    spec_digest: `sha256:${id}`,
    capabilities: {},
    can_spawn: true,
    spec_version: "0.1.0",
  }));
  await writeFile(cli, `
const [, , command, arg, jsonFlag] = process.argv;
const records = ${JSON.stringify(records)};
if (command === "resolve" && jsonFlag === "--json") {
  const found = records.find((r) => r.id === arg);
  if (found) {
    process.stdout.write(JSON.stringify({ data: found }));
    process.exit(0);
  }
  process.exit(1);
}
if (command === "list" && arg === "--json") {
  process.stdout.write(JSON.stringify({ data: records }));
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
  let getAllToolsCalls = 0;
  let setActiveToolsCalls = 0;
  let setModelCalls = 0;
  const sessionEntries = [];
  const ctx = {
    env: {
      LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, cli]),
      LARVA_PI_AGENT_PERSONA_SWITCH: "auto",
      ...env,
    },
    ui: { setStatus: async () => {}, notify: async () => {} },
    modelRegistry: { find: async () => ({ id: "model", provider: "loopback" }) },
    session: {
      entries: sessionEntries,
      getEntries: () => sessionEntries,
      appendEntry: (customType, data) => {
        const entry = { customType, data };
        auditEntries.push(entry);
        sessionEntries.push(entry);
      },
    },
    appendEntry: (customType, data) => {
      const entry = { customType, data };
      auditEntries.push(entry);
      sessionEntries.push(entry);
    },
    sendMessage: async (message, options) => runtimeMessages.push({ message, options }),
    sendUserMessage: async (message, options) => chatMessages.push({ message, options }),
  };
  const pi = {
    events,
    getAllTools: async () => { getAllToolsCalls += 1; return ["read", "larva_persona_switch", "larva_personas"]; },
    setActiveTools: async () => { setActiveToolsCalls += 1; return true; },
    setModel: async () => { setModelCalls += 1; return true; },
    getThinkingLevel: () => "off",
    setThinkingLevel: () => {},
    registerCommand: () => {},
    registerTool: () => {},
    on: (event, handler) => { handlers[event] = handler; },
    ...extraPi,
  };
  await mod.initializeExtension(ctx, pi);
  const counts = {
    get getAllTools() { return getAllToolsCalls; },
    get setActiveTools() { return setActiveToolsCalls; },
    get setModel() { return setModelCalls; },
  };
  return { mod, ctx, pi, events, handlers, auditEntries, chatMessages, runtimeMessages, counts, sessionEntries };
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

// ---------------------------------------------------------------------------
// F1: Caller-owned whitespace preservation and whole-string fixed points
// ---------------------------------------------------------------------------
await run("F1 whitespace-only base preservation under persona and ready none", async () => {
  const runtime = await boot("f1-whitespace", { LARVA_PI_INITIAL_PERSONA_ID: "origin" });
  for (const ws of ["\t", " ", "   ", "\n", "\n\n", "  \t\n  "]) {
    const replies = emitResolve(runtime.events, runtime.mod.LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, ws);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].status, "ok");
    const composed = replies[0].systemPrompt;

    // Verify fixed point: resolving composed prompt again yields identical string
    const again = emitResolve(runtime.events, runtime.mod.LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, composed);
    assert.equal(again[0].systemPrompt, composed);

    // Verify provider projection on first output is unchanged
    const proj = runtime.mod.projectLarvaIdentityIntoProviderPayload(
      { messages: [{ role: "system", content: composed }], temperature: 0 },
      runtime.mod.getActiveEnvelope(),
      "openai-completions",
    );
    assert.equal(proj.status, "unchanged");

    // Verify ready none preserves exact whitespace when stripping managed blocks
    const noneComposed = runtime.mod.composeLarvaSystemPrompt(composed, { envelope: null, switchGuidance: null, continuationMessage: null });
    assert.equal(noneComposed.status, "ok");
    assert.equal(noneComposed.systemPrompt, ws);
  }
});

// ---------------------------------------------------------------------------
// F2: Structural validation of crossed markers & opaque persona marker examples
// ---------------------------------------------------------------------------
await run("F2 crossed identity and persona markers explicitly fail as unavailable", async () => {
  const mod = await importFresh("f2-crossed");
  const crossedCases = [
    LARVA_IDENTITY_POLICY_BEGIN + "x" + LARVA_ACTIVE_PERSONA_BEGIN + "y" + LARVA_IDENTITY_POLICY_END + "KEEP" + LARVA_ACTIVE_PERSONA_END,
    LARVA_ACTIVE_PERSONA_BEGIN + "x" + LARVA_IDENTITY_POLICY_BEGIN + "y" + LARVA_ACTIVE_PERSONA_END + "KEEP" + LARVA_IDENTITY_POLICY_END,
    LARVA_ACTIVE_PERSONA_BEGIN + "x" + LARVA_PERSONA_SWITCH_CONTINUATION_PROMPT_BEGIN + "y" + LARVA_ACTIVE_PERSONA_END + "z" + LARVA_PERSONA_SWITCH_CONTINUATION_PROMPT_END,
    LARVA_IDENTITY_POLICY_BEGIN + "x" + LARVA_ACTIVE_PERSONA_END,
  ];
  for (const damaged of crossedCases) {
    const result = mod.composeLarvaSystemPrompt(damaged, { envelope: null, switchGuidance: null, continuationMessage: null });
    assert.equal(result.status, "unavailable", `damaged input must fail: ${damaged}`);
  }
});

await run("F2 opaque persona with complete same-kind marker example preserves fixed point and clean switch", async () => {
  const mod = await importFresh("f2-nested");
  const nestedPrompt = [
    "You are a meta-prompting engineer.",
    "Example format:",
    LARVA_ACTIVE_PERSONA_BEGIN,
    "<!-- larva-spec: example@sha256:ex -->",
    "Nested prompt content",
    LARVA_ACTIVE_PERSONA_END,
    "TAIL instructions after example.",
  ].join("\n");
  const envelope = {
    persona_id: "meta",
    spec_digest: "sha256:meta",
    model: "loopback/model",
    prompt: nestedPrompt,
    tool_policy: {},
  };

  const composed1 = mod.composeLarvaSystemPrompt("Base foreign text", { envelope, switchGuidance: null, continuationMessage: null });
  assert.equal(composed1.status, "ok");
  assert.ok(composed1.systemPrompt.includes("Nested prompt content"));
  assert.ok(composed1.systemPrompt.includes("TAIL instructions after example."));

  // Fixed point test: recomposing output must strictly equal output
  const composed2 = mod.composeLarvaSystemPrompt(composed1.systemPrompt, { envelope, switchGuidance: null, continuationMessage: null });
  assert.equal(composed2.status, "ok");
  assert.equal(composed2.systemPrompt, composed1.systemPrompt);

  // Switching away to another persona must remove the old nested example and TAIL completely
  const nextEnvelope = {
    persona_id: "next",
    spec_digest: "sha256:next",
    model: "loopback/model",
    prompt: "New simple prompt",
    tool_policy: {},
  };
  const switched = mod.composeLarvaSystemPrompt(composed1.systemPrompt, { envelope: nextEnvelope, switchGuidance: null, continuationMessage: null });
  assert.equal(switched.status, "ok");
  assert.ok(switched.systemPrompt.includes("New simple prompt"));
  assert.equal(switched.systemPrompt.includes("Nested prompt content"), false);
  assert.equal(switched.systemPrompt.includes("TAIL instructions after example."), false);
  assert.ok(switched.systemPrompt.includes("Base foreign text"));
});

// ---------------------------------------------------------------------------
// F3: Robust synchronous event error handling and single reply
// ---------------------------------------------------------------------------
await run("F3 throwing scope or systemPrompt getters produce bounded unavailable without escaping to bus", async () => {
  const runtime = await boot("f3-errors", { LARVA_PI_INITIAL_PERSONA_ID: "origin" });
  const eventName = runtime.mod.LARVA_RESOLVE_SYSTEM_PROMPT_EVENT;

  // Throwing scope getter
  const scopeReplies = [];
  runtime.events.emit(eventName, {
    get scope() { throw new Error("throwing scope getter"); },
    systemPrompt: "base",
    reply: (res) => scopeReplies.push(res),
  });
  assert.equal(scopeReplies.length, 1);
  assert.equal(scopeReplies[0].status, "unavailable");
  assert.ok(scopeReplies[0].reason.includes("throwing scope getter"));

  // Throwing systemPrompt getter
  const promptReplies = [];
  runtime.events.emit(eventName, {
    scope: "main",
    get systemPrompt() { throw new Error("throwing systemPrompt getter"); },
    reply: (res) => promptReplies.push(res),
  });
  assert.equal(promptReplies.length, 1);
  assert.equal(promptReplies[0].status, "unavailable");
  assert.ok(promptReplies[0].reason.includes("throwing systemPrompt getter"));

  // Throwing reply function does not crash or emit second reply
  let replyAttempts = 0;
  runtime.events.emit(eventName, {
    scope: "main",
    systemPrompt: "base",
    reply: () => {
      replyAttempts += 1;
      throw new Error("consumer reply threw");
    },
  });
  assert.equal(replyAttempts, 1);

  // Microtask check: no late second reply
  await new Promise((r) => queueMicrotask(r));
  assert.equal(scopeReplies.length, 1);
  assert.equal(promptReplies.length, 1);
  assert.equal(replyAttempts, 1);
});

// ---------------------------------------------------------------------------
// F4: State transitions, barriers, failed restoration, and valid rollback
// ---------------------------------------------------------------------------
await run("F4 failed restore sets failure state and keeps resolver unavailable", async () => {
  const runtime = await boot("f4-restore-fail", { LARVA_PI_INITIAL_PERSONA_ID: "origin" });
  const eventName = runtime.mod.LARVA_RESOLVE_SYSTEM_PROMPT_EVENT;

  // Initial state is origin
  const initReplies = emitResolve(runtime.events, eventName, "base");
  assert.equal(initReplies[0].status, "ok");

  // Borrow target
  const switched = await runtime.mod.larva_persona_switch({
    persona_id: "target",
    reason: "test borrow",
  }, runtime.ctx, runtime.pi);
  assert.equal(switched.status, "success");

  // Make setModel reject during restore
  runtime.pi.setModel = async () => {
    throw new Error("model restore auth check failed");
  };

  // Trigger agent_end restore
  await runtime.handlers.agent_end({ messages: [{ role: "assistant", stopReason: "stop" }] }, runtime.ctx);

  // Resolver must return unavailable because restore failed
  const failReplies = emitResolve(runtime.events, eventName, "base");
  assert.equal(failReplies.length, 1);
  assert.equal(failReplies[0].status, "unavailable");
  assert.ok(failReplies[0].reason.length > 0);
});

await run("F4 valid rollback after switch failure restores ok on old state", async () => {
  const runtime = await boot("f4-rollback", { LARVA_PI_INITIAL_PERSONA_ID: "origin" });
  const eventName = runtime.mod.LARVA_RESOLVE_SYSTEM_PROMPT_EVENT;

  const initReplies = emitResolve(runtime.events, eventName, "base");
  assert.equal(initReplies[0].status, "ok");
  assert.ok(initReplies[0].systemPrompt.includes("Prompt for origin"));

  // Attempt switch to non-existent persona
  const failSwitch = await runtime.mod.larva_persona_switch({
    persona_id: "nonexistent",
    reason: "should fail",
  }, runtime.ctx, runtime.pi);
  assert.equal(failSwitch.status, "failed");

  // Resolver must return ok with origin persona
  const afterRollback = emitResolve(runtime.events, eventName, "base");
  assert.equal(afterRollback.length, 1);
  assert.equal(afterRollback[0].status, "ok");
  assert.ok(afterRollback[0].systemPrompt.includes("Prompt for origin"));
});

// ---------------------------------------------------------------------------
// F5: Lifecycle suppression: pending initialization across shutdown
// ---------------------------------------------------------------------------
await run("F5 pending initialization across shutdown does not revive after completion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "larva-f5-suppress-"));
  const gate = join(dir, "go");
  const cli = join(dir, "cli.mjs");
  await writeFile(cli, `
import { existsSync } from "node:fs";
const [, , command, arg, jsonFlag] = process.argv;
const gate = ${JSON.stringify(gate)};
if (command === "resolve" && jsonFlag === "--json") {
  const start = Date.now();
  while (!existsSync(gate) && Date.now() - start < 10000) {}
  process.stdout.write(JSON.stringify({ data: {
    id: arg, description: arg, prompt: "Prompt for " + arg, model: "loopback/model",
    capabilities: {}, spec_version: "0.1.0", spec_digest: "sha256:" + arg, can_spawn: true
  }}));
  process.exit(0);
}
process.exit(3);
`, "utf8");

  const mod = await importFresh("f5-shutdown-interleave");
  const events = await loadEventBus();
  const handlers = {};
  const ctx = {
    env: {
      LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, cli]),
      LARVA_PI_INITIAL_PERSONA_ID: "origin",
      LARVA_PI_AGENT_PERSONA_SWITCH: "manual",
    },
    ui: { setStatus: async () => {}, notify: async () => {} },
  };
  const pi = {
    events,
    getAllTools: async () => ["read"],
    setActiveTools: async () => true,
    setModel: async () => true,
    registerCommand: () => {},
    registerTool: () => {},
    on: (evt, fn) => { handlers[evt] = fn; },
  };

  // Extension initializes without modelRegistry, synchronously registering all handlers
  await mod.initializeExtension(ctx, pi);
  assert.equal(typeof handlers.session_shutdown, "function");
  assert.equal(typeof handlers.session_start, "function");

  // session_start arrives with modelRegistry on eventCtx, starting initialization that pauses on gate
  const eventCtx = { ...ctx, modelRegistry: { find: async () => ({ id: "model" }) } };
  const pendingSessionStart = handlers.session_start({ reason: "startup" }, eventCtx);
  await new Promise((r) => setTimeout(r, 20));

  // During init, resolver replies unavailable
  const duringInit = emitResolve(events, mod.LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, "base");
  assert.equal(duringInit.length, 1);
  assert.equal(duringInit[0].status, "unavailable");

  // Emit session_shutdown while init is still pending!
  handlers.session_shutdown({ reason: "reload" });

  // Post-shutdown: zero replies on the bus
  const afterShutdown = emitResolve(events, mod.LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, "base");
  assert.equal(afterShutdown.length, 0);

  // Now release gate and wait for old initialization to finish
  await writeFile(gate, "go", "utf8");
  await pendingSessionStart;

  // Verify that the old initialization completing does NOT revive the listener
  const afterLateInit = emitResolve(events, mod.LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, "base");
  assert.equal(afterLateInit.length, 0);
});

await run("F5 lifecycle re-establishment on session_start new, resume, fork", async () => {
  const runtime = await boot("f5-lifecycle-reasons", { LARVA_PI_INITIAL_PERSONA_ID: "origin" });
  const eventName = runtime.mod.LARVA_RESOLVE_SYSTEM_PROMPT_EVENT;

  for (const reason of ["new", "resume", "fork"]) {
    await runtime.handlers.session_start({ reason }, runtime.ctx);
    const replies = emitResolve(runtime.events, eventName, "base");
    assert.equal(replies.length, 1);
    assert.equal(replies[0].status, "ok");
    assert.ok(replies[0].systemPrompt.includes("Prompt for origin"));
  }
});

// ---------------------------------------------------------------------------
// F5: Comprehensive read-side purity observation
// ---------------------------------------------------------------------------
await run("F5 resolver reads strictly observe zero effect on state, queues, tools, and CLI", async () => {
  const runtime = await boot("f5-purity", { LARVA_PI_INITIAL_PERSONA_ID: "origin" });
  await runtime.mod.larva_persona_switch({
    persona_id: "target",
    reason: "test purity",
    continue_task: true,
  }, runtime.ctx, runtime.pi);

  const baseline = {
    envelope: runtime.mod.getActiveEnvelope(),
    auditCount: runtime.auditEntries.length,
    chatCount: runtime.chatMessages.length,
    runtimeMessageCount: runtime.runtimeMessages.length,
    getAllToolsCalls: runtime.counts.getAllTools,
    setActiveToolsCalls: runtime.counts.setActiveTools,
    setModelCalls: runtime.counts.setModel,
  };

  // Perform multiple resolver queries
  for (let i = 0; i < 5; i++) {
    const replies = emitResolve(runtime.events, runtime.mod.LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, "Base text " + i);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].status, "ok");
  }

  assert.deepEqual(runtime.mod.getActiveEnvelope(), baseline.envelope);
  assert.equal(runtime.auditEntries.length, baseline.auditCount);
  assert.equal(runtime.chatMessages.length, baseline.chatCount);
  assert.equal(runtime.runtimeMessages.length, baseline.runtimeMessageCount);
  assert.equal(runtime.counts.getAllTools, baseline.getAllToolsCalls);
  assert.equal(runtime.counts.setActiveTools, baseline.setActiveToolsCalls);
  assert.equal(runtime.counts.setModel, baseline.setModelCalls);
});

// ---------------------------------------------------------------------------
// F5: Resolver-to-serializer-to-provider consistency across all APIs
// ---------------------------------------------------------------------------
await run("F5 resolver output fed to provider serializers returns unchanged for all supported APIs", async () => {
  const runtime = await boot("f5-serializers", { LARVA_PI_INITIAL_PERSONA_ID: "origin" });
  const eventName = runtime.mod.LARVA_RESOLVE_SYSTEM_PROMPT_EVENT;
  const resolved = emitResolve(runtime.events, eventName, "Base text");
  assert.equal(resolved[0].status, "ok");
  const prompt = resolved[0].systemPrompt;
  const envelope = runtime.mod.getActiveEnvelope();

  const apiFixtures = [
    {
      api: "openai-completions",
      payload: {
        model: "gpt",
        messages: [{ role: "system", content: prompt }, { role: "user", content: "hello" }],
        temperature: 0.7,
      },
    },
    {
      api: "mistral-conversations",
      payload: {
        messages: [{ role: "system", content: prompt }, { role: "user", content: "hello" }],
      },
    },
    {
      api: "openai-responses",
      payload: {
        input: [{ role: "developer", content: prompt }, { role: "user", content: [{ type: "input_text", text: "hello" }] }],
      },
    },
    {
      api: "azure-openai-responses",
      payload: {
        input: [{ role: "developer", content: prompt }, { role: "user", content: [{ type: "input_text", text: "hello" }] }],
      },
    },
    {
      api: "openai-codex-responses",
      payload: {
        instructions: prompt,
        input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      },
    },
    {
      api: "anthropic-messages",
      payload: {
        system: [
          { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
          { type: "text", text: prompt, cache_control: { type: "ephemeral" } },
        ],
        messages: [{ role: "user", content: "hello" }],
      },
    },
    {
      api: "bedrock-converse-stream",
      payload: {
        system: [{ text: prompt }, { cachePoint: { type: "default" } }],
        messages: [],
      },
    },
    {
      api: "google-generative-ai",
      payload: {
        config: { systemInstruction: prompt, temperature: 0.2 },
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
      },
    },
    {
      api: "google-vertex",
      payload: {
        config: { systemInstruction: prompt, temperature: 0.2 },
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
      },
    },
    {
      api: "pi-messages",
      payload: {
        context: { systemPrompt: prompt, messages: [{ role: "user", content: "hello" }] },
        options: { maxTokens: 100 },
      },
    },
  ];

  for (const { api, payload } of apiFixtures) {
    const result = runtime.mod.projectLarvaIdentityIntoProviderPayload(payload, envelope, api);
    assert.equal(result.status, "unchanged", `API ${api} must return unchanged when given resolved prompt`);
  }
});

// ---------------------------------------------------------------------------
// Existing Section 8 core proofs
// ---------------------------------------------------------------------------
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

await run("free mode continuation projects and when cleared leaves prompt unchanged", async () => {
  const runtime = await boot("free-cont", { LARVA_PI_INITIAL_PERSONA_ID: "origin", LARVA_PI_AGENT_PERSONA_SWITCH: "free" });
  const eventName = runtime.mod.LARVA_RESOLVE_SYSTEM_PROMPT_EVENT;

  const switched = await runtime.mod.larva_persona_switch({
    persona_id: "target",
    reason: "free switch with continuation",
    continue_task: true,
  }, runtime.ctx, runtime.pi);
  assert.equal(switched.status, "success");
  assert.equal(switched.details.lease, null);

  await runtime.handlers.agent_end({ messages: [{ role: "assistant", stopReason: "stop" }] }, runtime.ctx);
  await new Promise((r) => setTimeout(r, 20));

  const running = emitResolve(runtime.events, eventName, "Pi base");
  assert.equal(running[0].status, "ok");
  assert.ok(running[0].systemPrompt.includes("Prompt for target"));
  assert.ok(running[0].systemPrompt.includes("<larva_persona_switch_continuation>"));

  // Settle turn
  await runtime.handlers.agent_end({ messages: [{ role: "assistant", stopReason: "stop" }] }, runtime.ctx);

  const afterTurn = emitResolve(runtime.events, eventName, running[0].systemPrompt);
  assert.equal(afterTurn[0].status, "ok");
  assert.ok(afterTurn[0].systemPrompt.includes("Prompt for target"));
  assert.equal(afterTurn[0].systemPrompt.includes("<larva_persona_switch_continuation>"), false);
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

await run("idempotent setup keeps a single listener", async () => {
  const runtime = await boot("idempotent-setup", { LARVA_PI_AGENT_PERSONA_SWITCH: "manual" });
  await runtime.mod.initializeExtension(runtime.ctx, runtime.pi);
  const replies = emitResolve(runtime.events, runtime.mod.LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, "Pi base");
  assert.equal(replies.length, 1);
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
