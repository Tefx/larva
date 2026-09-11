#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const rootUrl = pathToFileURL(join(process.cwd(), "contrib/pi-extension/larva.ts"));
const results = [];

async function importFresh(name) {
  return await import(`${rootUrl.href}?idle-identity=${encodeURIComponent(name)}-${Date.now()}-${Math.random()}`);
}

const envelope = {
  persona_id: "vectl-orchestrator",
  spec_digest: "sha256:orchestrator-identity-proof",
  model: "loopback/idle-id",
  prompt: "You are the Vectl Orchestrator for this identity proof.",
  tool_policy: {},
};
const marker = `<!-- larva-spec: ${envelope.persona_id}@${envelope.spec_digest} -->`;
const identityBegin = "<!-- larva:identity-policy:begin -->";
const personaBegin = "<!-- larva:active-persona:begin -->";
const stale = {
  ...envelope,
  persona_id: "old-persona",
  spec_digest: "sha256:old",
  prompt: "stale prompt",
};

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function projectedPayload(result) {
  assert.equal(result.status, "projected", JSON.stringify(result));
  return result.payload;
}

async function run(name, fn) {
  try {
    await fn();
    results.push({ name, status: "PASS" });
  } catch (error) {
    results.push({ name, status: "FAIL", message: error?.stack || String(error) });
  }
}

await run("openai-completions wraps the leading system string once and leaves user content untouched", async () => {
  const mod = await importFresh("openai");
  const payload = {
    model: "idle-id",
    messages: [
      { role: "system", content: "You are a coding assistant.\nAGENTS.md" },
      { role: "user", content: "hello" },
    ],
    temperature: 0,
  };
  const next = projectedPayload(mod.projectLarvaIdentityIntoProviderPayload(payload, envelope, "openai-completions"));
  assert.equal(next.temperature, 0);
  assert.equal(next.messages[1].content, "hello");
  assert.equal(count(next.messages[0].content, "larva-spec:"), 1);
  assert.equal(count(next.messages[0].content, identityBegin), 1);
  assert.ok(next.messages[0].content.includes(marker));
  assert.ok(next.messages[0].content.includes("AGENTS.md"));
  assert.ok(next.messages[0].content.includes("You are a coding assistant."));
  assert.ok(next.messages[0].content.includes(envelope.prompt));
});

await run("second leading system message is not wrapped", async () => {
  const mod = await importFresh("two-system");
  const next = projectedPayload(mod.projectLarvaIdentityIntoProviderPayload({
    messages: [
      { role: "system", content: "first" },
      { role: "system", content: "second" },
      { role: "user", content: "hi" },
    ],
  }, envelope, "openai-completions"));
  assert.ok(next.messages[0].content.includes(marker));
  assert.equal(next.messages[1].content, "second");
  assert.equal(next.messages[2].content, "hi");
  assert.equal(count(`${next.messages[0].content}\n${next.messages[1].content}`, identityBegin), 1);
});

await run("already-current identity is idempotent", async () => {
  const mod = await importFresh("idempotent");
  const wrapped = mod.replaceLarvaWatermark("You are a coding assistant.\nAGENTS.md", envelope);
  const result = mod.projectLarvaIdentityIntoProviderPayload({
    messages: [{ role: "system", content: wrapped }, { role: "user", content: "x" }],
  }, envelope, "openai-completions");
  assert.equal(result.status, "unchanged");
  const again = mod.replaceLarvaWatermark(wrapped, envelope);
  assert.equal(again, wrapped);
  assert.ok(again.includes("AGENTS.md"));
});

await run("stale larva-spec and tampered prompt are replaced", async () => {
  const mod = await importFresh("stale");
  const stalePrompt = mod.replaceLarvaWatermark("base", stale);
  const next = projectedPayload(mod.projectLarvaIdentityIntoProviderPayload({
    messages: [{ role: "system", content: stalePrompt }],
  }, envelope, "openai-completions"));
  assert.ok(next.messages[0].content.includes(marker));
  assert.equal(next.messages[0].content.includes("<!-- larva-spec: old-persona@sha256:old -->"), false);
  assert.equal(next.messages[0].content.includes("stale prompt"), false);
  assert.ok(next.messages[0].content.includes(envelope.prompt));
  assert.equal(count(next.messages[0].content, identityBegin), 1);

  const current = mod.replaceLarvaWatermark("base", envelope);
  const tampered = current.replace(envelope.prompt, "TAMPERED PROMPT");
  const repaired = projectedPayload(mod.projectLarvaIdentityIntoProviderPayload({
    messages: [{ role: "system", content: tampered }],
  }, envelope, "openai-completions"));
  assert.ok(repaired.messages[0].content.includes(envelope.prompt));
  assert.equal(repaired.messages[0].content.includes("TAMPERED PROMPT"), false);
});

await run("truncated active-persona block fails explicitly without rewriting payload", async () => {
  const mod = await importFresh("truncated");
  const truncated = `${identityBegin}\nActive Larva persona is the primary identity. Pi's generic coding-assistant wording describes the runtime harness and tools only.\n<!-- larva:identity-policy:end -->\n\nKeep this Pi text\n\n${personaBegin}\n${marker}\nincomplete`;
  const payload = { messages: [{ role: "system", content: truncated }], temperature: 0 };
  const result = mod.projectLarvaIdentityIntoProviderPayload(payload, envelope, "openai-completions");
  assert.equal(result.status, "compose_failed");
  assert.equal(payload.messages[0].content, truncated);
  assert.ok(truncated.includes("Keep this Pi text"));
  const composed = mod.composeLarvaSystemPrompt(truncated, { envelope, switchGuidance: null, continuationMessage: null });
  assert.equal(composed.status, "unavailable");
  assert.equal(typeof composed.reason, "string");
  assert.ok(composed.reason.length > 0);
  assert.equal(composed.reason.includes(truncated), false);
  assert.equal(composed.reason.includes(envelope.prompt), false);
});

await run("unpaired larva-spec comment is unique after repair and surrounding base is kept", async () => {
  const mod = await importFresh("spec-comment");
  const truncated = `Keep this Pi text\n\n${personaBegin}\n<!-- larva-spec: old-persona@sha256:old -->\nincomplete leftover`;
  const damaged = mod.projectLarvaIdentityIntoProviderPayload({
    messages: [{ role: "system", content: truncated }, { role: "user", content: "hi" }],
  }, envelope, "openai-completions");
  assert.equal(damaged.status, "compose_failed");

  const sameLine = projectedPayload(mod.projectLarvaIdentityIntoProviderPayload({
    messages: [{ role: "system", content: "<!-- larva-spec: old@x -->KEEP<!-- unrelated -->" }],
  }, envelope, "openai-completions"));
  assert.equal(count(sameLine.messages[0].content, "larva-spec:"), 1);
  assert.ok(sameLine.messages[0].content.includes(marker));
  assert.equal(sameLine.messages[0].content.includes("<!-- larva-spec: old@x -->"), false);
  assert.ok(sameLine.messages[0].content.includes("KEEP"));
  assert.ok(sameLine.messages[0].content.includes("<!-- unrelated -->"));
});

await run("dangling end marker and duplicate managed blocks collapse to one current envelope", async () => {
  const mod = await importFresh("dangling");
  const dangling = projectedPayload(mod.projectLarvaIdentityIntoProviderPayload({
    messages: [{ role: "system", content: "Keep Pi text\n<!-- larva:active-persona:end -->" }],
  }, envelope, "openai-completions"));
  assert.ok(dangling.messages[0].content.includes("Keep Pi text"));
  assert.equal(dangling.messages[0].content.includes("<!-- larva:active-persona:end -->\n<!-- larva:active-persona:end -->"), false);
  assert.equal(count(dangling.messages[0].content, identityBegin), 1);
  assert.ok(dangling.messages[0].content.includes(marker));

  const one = mod.replaceLarvaWatermark("Pi base", envelope);
  const doubled = `${one}\n${one}`;
  const collapsed = projectedPayload(mod.projectLarvaIdentityIntoProviderPayload({
    messages: [{ role: "system", content: doubled }],
  }, envelope, "openai-completions"));
  assert.equal(count(collapsed.messages[0].content, identityBegin), 1);
  assert.equal(count(collapsed.messages[0].content, "larva-spec:"), 1);
  assert.ok(collapsed.messages[0].content.includes("Pi base"));
  assert.equal(mod.projectLarvaIdentityIntoProviderPayload({
    messages: [{ role: "system", content: collapsed.messages[0].content }],
  }, envelope, "openai-completions").status, "unchanged");
});

await run("continuation block is kept once and not duplicated", async () => {
  const mod = await importFresh("continuation");
  const begin = "<larva_persona_switch_continuation>";
  const wrapped = `${mod.replaceLarvaWatermark("Pi base", envelope)}\n${begin}\nkeep going\n</larva_persona_switch_continuation>`;
  const next = projectedPayload(mod.projectLarvaIdentityIntoProviderPayload({
    messages: [{ role: "system", content: wrapped }, { role: "user", content: "hi" }],
  }, envelope, "openai-completions"));
  assert.equal(count(next.messages[0].content, begin), 0);
  assert.equal(next.messages[0].content.includes("keep going"), false);
  assert.ok(next.messages[0].content.includes("Pi base"));
  assert.equal(next.messages[1].content, "hi");
  const again = mod.projectLarvaIdentityIntoProviderPayload({
    messages: [{ role: "system", content: next.messages[0].content }, { role: "user", content: "hi" }],
  }, envelope, "openai-completions");
  assert.equal(again.status, "unchanged");
  assert.equal(next.messages[0].content, mod.replaceLarvaWatermark("Pi base", envelope));

  const withCont = mod.composeLarvaSystemPrompt("Pi base", { envelope, switchGuidance: null, continuationMessage: "keep going" });
  assert.equal(count(withCont.systemPrompt, begin), 1);
  const withContAgain = mod.composeLarvaSystemPrompt(withCont.systemPrompt, { envelope, switchGuidance: null, continuationMessage: "keep going" });
  assert.equal(count(withContAgain.systemPrompt, begin), 1);
  assert.equal(withContAgain.systemPrompt, withCont.systemPrompt);
});

await run("anthropic keeps Claude Code identity and cache_control and wraps one Pi block", async () => {
  const mod = await importFresh("anthropic");
  const payload = {
    model: "claude",
    system: [
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: "ephemeral" } },
      { type: "text", text: "Pi base part 1" },
      { type: "text", text: "Pi base part 2", cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: "hi" }],
  };
  const next = projectedPayload(mod.projectLarvaIdentityIntoProviderPayload(payload, envelope, "anthropic-messages"));
  assert.equal(next.system[0].text, "You are Claude Code, Anthropic's official CLI for Claude.");
  assert.deepEqual(next.system[0].cache_control, { type: "ephemeral" });
  assert.equal(next.system[1].text, "Pi base part 1");
  assert.ok(next.system[2].text.includes(marker));
  assert.ok(next.system[2].text.includes("Pi base part 2"));
  assert.deepEqual(next.system[2].cache_control, { type: "ephemeral" });
  assert.equal(count(JSON.stringify(next.system), identityBegin), 1);
  assert.equal(next.messages[0].content, "hi");
});

await run("google, bedrock, codex, responses, and pi-messages project the known slot", async () => {
  const mod = await importFresh("slots");
  const google = projectedPayload(mod.projectLarvaIdentityIntoProviderPayload({
    model: "gemini",
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
    config: { temperature: 0.2, systemInstruction: "Google base" },
  }, envelope, "google-generative-ai"));
  assert.equal(google.config.temperature, 0.2);
  assert.ok(google.config.systemInstruction.includes(marker));
  assert.ok(google.config.systemInstruction.includes("Google base"));

  const bedrock = projectedPayload(mod.projectLarvaIdentityIntoProviderPayload({
    modelId: "claude",
    system: [{ text: "Bedrock base" }, { cachePoint: { type: "default" } }],
    messages: [],
  }, envelope, "bedrock-converse-stream"));
  assert.ok(bedrock.system[0].text.includes(marker));
  assert.deepEqual(bedrock.system[1], { cachePoint: { type: "default" } });

  const codex = projectedPayload(mod.projectLarvaIdentityIntoProviderPayload({
    model: "gpt",
    instructions: "Codex base",
    input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
  }, envelope, "openai-codex-responses"));
  assert.ok(codex.instructions.includes(marker));
  assert.equal(codex.input[0].content[0].text, "hi");

  const responses = projectedPayload(mod.projectLarvaIdentityIntoProviderPayload({
    model: "gpt",
    input: [{ role: "developer", content: "Responses base" }, { role: "user", content: [{ type: "input_text", text: "hi" }] }],
  }, envelope, "openai-responses"));
  assert.ok(responses.input[0].content.includes(marker));
  assert.equal(responses.input[1].content[0].text, "hi");

  const piMessages = projectedPayload(mod.projectLarvaIdentityIntoProviderPayload({
    model: "radius-model",
    context: { systemPrompt: "Pi-messages base", messages: [{ role: "user", content: "hi" }], tools: [] },
    options: { maxTokens: 16 },
  }, envelope, "pi-messages"));
  assert.ok(piMessages.context.systemPrompt.includes(marker));
  assert.equal(piMessages.context.messages[0].content, "hi");
  assert.equal(piMessages.options.maxTokens, 16);
});

await run("known APIs insert an instruction slot when the container admits one", async () => {
  const mod = await importFresh("repair-slot");
  const openai = projectedPayload(mod.projectLarvaIdentityIntoProviderPayload({
    temperature: 0,
    messages: [{ role: "user", content: "hi" }],
  }, envelope, "openai-completions"));
  assert.equal(openai.temperature, 0);
  assert.equal(openai.messages[1].content, "hi");
  assert.ok(openai.messages[0].content.includes(marker));
  assert.equal(openai.messages[0].role, "system");

  const google = projectedPayload(mod.projectLarvaIdentityIntoProviderPayload({
    config: { temperature: 0.2 },
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
  }, envelope, "google-generative-ai"));
  assert.equal(google.config.temperature, 0.2);
  assert.ok(google.config.systemInstruction.includes(marker));
  assert.equal(google.contents[0].parts[0].text, "hi");

  const anthropic = projectedPayload(mod.projectLarvaIdentityIntoProviderPayload({
    system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: "hi" }],
  }, envelope, "anthropic-messages"));
  assert.equal(anthropic.system[0].text, "You are Claude Code, Anthropic's official CLI for Claude.");
  assert.deepEqual(anthropic.system[0].cache_control, { type: "ephemeral" });
  assert.ok(anthropic.system[1].text.includes(marker));
  assert.equal(anthropic.messages[0].content, "hi");
});

await run("unsupported api, unadmitted slot, and missing envelope do not rewrite payload", async () => {
  const mod = await importFresh("unknown");
  assert.equal(mod.projectLarvaIdentityIntoProviderPayload({ temperature: 0, foo: "bar" }, envelope, "openai-completions").status, "missing_slot");
  assert.equal(mod.projectLarvaIdentityIntoProviderPayload({ messages: [{ role: "system", content: { broken: true } }] }, envelope, "openai-completions").status, "missing_slot");
  assert.equal(mod.projectLarvaIdentityIntoProviderPayload({ messages: [{ role: "system", content: "base" }] }, envelope, null).status, "missing_slot");
  assert.equal(mod.projectLarvaIdentityIntoProviderPayload({ messages: [{ role: "system", content: "base" }] }, envelope, "not-a-pi-api").status, "unsupported_api");
  assert.equal(mod.projectLarvaIdentityIntoProviderPayload({ messages: [{ role: "system", content: "base" }] }, null, "openai-completions").status, "unchanged");
  const cleanedNone = projectedPayload(mod.projectLarvaIdentityIntoProviderPayload({
    messages: [{ role: "system", content: `${identityBegin}\nstale\n<!-- larva:identity-policy:end -->\n\nKeep base` }],
  }, null, "openai-completions"));
  assert.equal(cleanedNone.messages[0].content.includes(identityBegin), false);
  assert.ok(cleanedNone.messages[0].content.includes("Keep base"));
});

await run("before_provider_request uses ctx.model.api and current envelope", async () => {
  const mod = await importFresh("hook");
  const fakeCli = await mkdtemp(join(tmpdir(), "larva-idle-identity-cli-"));
  const cli = join(fakeCli, "cli.mjs");
  await writeFile(cli, `
const [, , command, arg, jsonFlag] = process.argv;
if (command === "resolve" && jsonFlag === "--json") {
  process.stdout.write(JSON.stringify({ data: { id: arg, description: arg, prompt: "Prompt for " + arg, model: "loopback/model", capabilities: {}, spec_version: "0.1.0", spec_digest: "sha256:" + arg, can_spawn: true } }));
  process.exit(0);
}
if (command === "list" && arg === "--json") {
  process.stdout.write(JSON.stringify({ data: [{ id: "origin", description: "Origin", model: "loopback/model", spec_digest: "sha256:origin", capabilities: {} }] }));
  process.exit(0);
}
process.exit(3);
`, "utf8");
  const handlers = {};
  const notices = [];
  const order = [];
  const ctx = {
    env: { LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, cli]), LARVA_PI_INITIAL_PERSONA_ID: "origin", LARVA_PI_AGENT_PERSONA_SWITCH: "manual" },
    ui: { setStatus: async () => {}, notify: async (message, notifyType) => { notices.push({ message, notifyType }); } },
    modelRegistry: { find: async () => ({ id: "model" }) },
  };
  const pi = {
    getAllTools: async () => ["read"],
    setActiveTools: async () => true,
    registerCommand: () => {},
    registerTool: () => {},
    on: (event, handler) => { handlers[event] = handler; },
  };
  await mod.initializeExtension(ctx, pi);
  assert.equal(typeof handlers.before_provider_request, "function");
  const eventCtx = {
    model: { api: "openai-completions" },
    ui: ctx.ui,
    abort: () => { order.push("abort"); },
  };
  const projected = await handlers.before_provider_request({
    type: "before_provider_request",
    payload: { messages: [{ role: "system", content: "base" }, { role: "user", content: "hi" }] },
  }, eventCtx);
  assert.ok(projected.messages[0].content.includes("<!-- larva-spec: origin@sha256:origin -->"));
  assert.equal(projected.messages[1].content, "hi");
  assert.deepEqual(order, []);
  assert.equal(await handlers.before_provider_request(undefined, eventCtx), undefined);
  assert.deepEqual(order, []);

  const missingOrder = [];
  const missingNotices = [];
  const missingCtx = {
    model: { api: "openai-completions" },
    abort: () => { missingOrder.push("abort"); },
    ui: {
      notify: async (message, notifyType) => {
        missingOrder.push("notify");
        missingNotices.push({ message, notifyType });
        throw new Error("notify failed");
      },
    },
  };
  await assert.rejects(
    () => handlers.before_provider_request({ payload: { nope: true } }, missingCtx),
    /notify failed/,
  );
  assert.deepEqual(missingOrder, ["abort", "notify"]);
  assert.equal(missingNotices[0]?.notifyType, "warning");
  assert.ok(missingNotices[0]?.message.includes("missing_slot"));
  assert.ok(missingNotices[0]?.message.includes("cancellation of this model call was requested"));
  assert.equal(missingNotices[0]?.message.includes("will not receive"), false);

  const unsupportedOrder = [];
  const unsupportedNotices = [];
  const unsupportedCtx = {
    model: { api: "not-a-pi-api" },
    abort: () => { unsupportedOrder.push("abort"); },
    ui: {
      notify: async (message, notifyType) => {
        unsupportedOrder.push("notify");
        unsupportedNotices.push({ message, notifyType });
      },
    },
  };
  assert.equal(await handlers.before_provider_request({
    payload: { messages: [{ role: "system", content: "base" }] },
  }, unsupportedCtx), undefined);
  assert.deepEqual(unsupportedOrder, ["abort", "notify"]);
  assert.ok(unsupportedNotices[0]?.message.includes("unsupported_api"));
  assert.ok(unsupportedNotices[0]?.message.includes("cancellation of this model call was requested"));
});

await run("idle callback delivery stays custom triggerTurn steer and is not Continue.", async () => {
  const mod = await importFresh("callback");
  const callback = mod.larvaSubagentResultCallbackDelivery("child done", { task_id: "/tmp/child.jsonl", status: "success" });
  assert.equal(callback.message.customType, "larva-subagent-result");
  assert.equal(callback.message.content, "child done");
  assert.equal(callback.message.display, true);
  assert.equal(callback.options.triggerTurn, true);
  assert.equal(callback.options.deliverAs, "steer");
  assert.equal(JSON.stringify(callback).includes("Continue."), false);
});

await run("continuation_running projects once through switch hooks without a test mutator", async () => {
  const mod = await importFresh("continuation-hooks");
  const fakeCli = await mkdtemp(join(tmpdir(), "larva-idle-identity-continue-"));
  const cli = join(fakeCli, "cli.mjs");
  await writeFile(cli, `
const [, , command, arg, jsonFlag] = process.argv;
if (command === "resolve" && jsonFlag === "--json") {
  process.stdout.write(JSON.stringify({ data: { id: arg, description: "Persona " + arg, prompt: "Prompt for " + arg, model: "loopback/model", capabilities: {}, spec_version: "0.1.0", spec_digest: "sha256:" + arg, can_spawn: true } }));
  process.exit(0);
}
if (command === "list" && arg === "--json") {
  process.stdout.write(JSON.stringify({ data: [
    { id: "origin", description: "Origin", model: "loopback/model", spec_digest: "sha256:origin", capabilities: {} },
    { id: "target", description: "Target", model: "loopback/model", spec_digest: "sha256:target", capabilities: {} }
  ] }));
  process.exit(0);
}
process.exit(3);
`, "utf8");
  const handlers = {};
  const chatMessages = [];
  const ctx = {
    env: { LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, cli]), LARVA_PI_INITIAL_PERSONA_ID: "origin", LARVA_PI_AGENT_PERSONA_SWITCH: "auto" },
    ui: { setStatus: async () => {}, notify: async () => {} },
    modelRegistry: { find: async () => ({ id: "model" }) },
    session: { appendEntry: () => {} },
    sendMessage: async () => {},
    sendUserMessage: async (message, options) => { chatMessages.push({ message, options }); },
  };
  const pi = {
    getAllTools: async () => ["read", "larva_persona_switch", "larva_personas"],
    setActiveTools: async () => true,
    setModel: async () => true,
    registerCommand: () => {},
    registerTool: () => {},
    on: (event, handler) => { handlers[event] = handler; },
  };
  await mod.initializeExtension(ctx, pi);
  const switched = await mod.larva_persona_switch({
    persona_id: "target",
    reason: "specialized response after inspecting target description",
    handoff: "finish the task",
    continue_task: true,
  }, ctx, pi);
  assert.equal(switched.status, "success");
  await handlers.agent_end({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(chatMessages[0]?.message, "Continue.");
  const eventCtx = { model: { api: "openai-completions" }, ui: ctx.ui };
  const projected = await handlers.before_provider_request({
    type: "before_provider_request",
    payload: { messages: [{ role: "system", content: "Pi base" }, { role: "user", content: "hi" }] },
  }, eventCtx);
  const system = projected.messages[0].content;
  assert.equal(projected.messages[1].content, "hi");
  assert.ok(system.includes("<!-- larva-spec: target@sha256:target -->"));
  assert.equal(system.includes("<!-- larva-spec: origin@sha256:origin -->"), false);
  assert.ok(system.includes("Pi base"));
  assert.ok(system.includes("<larva_persona_switch_continuation>"));
  assert.ok(system.includes("[Larva-generated continuation after persona switch]"));
  assert.equal(count(system, "<larva_persona_switch_continuation>"), 1);
  const personaBegin = system.indexOf("<!-- larva:active-persona:begin -->");
  const continuationBegin = system.indexOf("<larva_persona_switch_continuation>");
  assert.ok(personaBegin >= 0 && continuationBegin > personaBegin, "continuation must follow active persona without paragraph movement");
  const agentStart = await handlers.before_agent_start({ prompt: "Continue.", systemPrompt: "Pi base" }, ctx);
  assert.equal(agentStart.systemPrompt, system);
  const again = await handlers.before_provider_request({
    type: "before_provider_request",
    payload: { messages: [{ role: "system", content: system }, { role: "user", content: "hi" }] },
  }, eventCtx);
  assert.equal(again, undefined);
});

await run("whole-string fixed point preserves unicode whitespace and repetitions", async () => {
  const mod = await importFresh("fixed-point");
  const base = "Keep  this\n\nKeep  this\n日本語\u{1F9E9}\t  trailing  ";
  const snapshot = { envelope, switchGuidance: null, continuationMessage: null };
  const first = mod.composeLarvaSystemPrompt(base, snapshot);
  assert.equal(first.status, "ok");
  assert.ok(first.systemPrompt.includes(base));
  assert.equal(count(first.systemPrompt, "Keep  this"), 2);
  const second = mod.composeLarvaSystemPrompt(first.systemPrompt, snapshot);
  assert.equal(second.status, "ok");
  assert.equal(second.systemPrompt, first.systemPrompt);
  const withCont = mod.composeLarvaSystemPrompt(base, { ...snapshot, continuationMessage: "continue-body" });
  assert.equal(withCont.status, "ok");
  const withContAgain = mod.composeLarvaSystemPrompt(withCont.systemPrompt, { ...snapshot, continuationMessage: "continue-body" });
  assert.equal(withContAgain.systemPrompt, withCont.systemPrompt);
  assert.equal(count(withCont.systemPrompt, "<larva_persona_switch_continuation>"), 1);
});

await run("actual Pi EventBus replies once synchronously for larva:resolve-system-prompt:v1", async () => {
  const mod = await importFresh("resolver-bus");
  const piRoot = process.env.LARVA_TEST_PI_CODING_AGENT ?? join(process.cwd(), "contrib/pi-extension/node_modules/@earendil-works/pi-coding-agent");
  assert.equal(typeof piRoot, "string");
  assert.ok(piRoot.length > 0);
  const { createEventBus } = await import(pathToFileURL(join(piRoot, "dist/core/event-bus.js")).href);
  const events = createEventBus();
  const fakeCli = await mkdtemp(join(tmpdir(), "larva-resolver-bus-"));
  const cli = join(fakeCli, "cli.mjs");
  await writeFile(cli, `process.exit(3);\n`, "utf8");
  const ctx = {
    env: { LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, cli]), LARVA_PI_AGENT_PERSONA_SWITCH: "manual" },
    ui: { setStatus: async () => {}, notify: async () => {} },
    modelRegistry: { find: async () => ({ id: "model" }) },
  };
  const pi = {
    events,
    getAllTools: async () => ["read"],
    setActiveTools: async () => true,
    registerCommand: () => {},
    registerTool: () => {},
    on: () => {},
  };
  await mod.initializeExtension(ctx, pi);
  const replies = [];
  events.emit(mod.LARVA_RESOLVE_SYSTEM_PROMPT_EVENT, {
    scope: "main",
    systemPrompt: "Pi base",
    reply: (result) => replies.push(result),
  });
  assert.equal(replies.length, 1);
  assert.equal(replies[0].status, "ok");
  assert.equal(replies[0].systemPrompt, mod.composeLarvaSystemPrompt("Pi base", { envelope: null, switchGuidance: null, continuationMessage: null }).systemPrompt);
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.equal(replies.length, 1);
});

const failed = results.filter((result) => result.status === "FAIL");
for (const result of results) {
  process.stdout.write(`${result.status} ${result.name}${result.message ? `\n${result.message}` : ""}\n`);
}
if (failed.length > 0) process.exit(1);
