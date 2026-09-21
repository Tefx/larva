#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { proveSessionReplacement } from "./resolver-session-replacement-proof.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const extensionPath = join(root, "contrib/pi-extension/larva.ts");
const CALLBACK_WAKE = "SUBAGENT_CALLBACK_WAKE";
const PERSONA_ID = "vectl-orchestrator";
const PERSONA_DIGEST = "sha256:orchestrator-identity-proof";
const PERSONA_PROMPT = "You are the Vectl Orchestrator for this identity proof.";
const SPEC_MARKER = `<!-- larva-spec: ${PERSONA_ID}@${PERSONA_DIGEST} -->`;
const IDENTITY_BEGIN = "<!-- larva:identity-policy:begin -->";
const QUARANTINE_KEYS = [
  "HOME", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
  "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR",
  "PI_MODEL", "PI_PROVIDER", "PI_REASONING_LEVEL", "PI_SESSION_FILE", "PI_SESSION_ID",
  "LARVA_CONFIG_DIR", "LARVA_HOME", "LARVA_SESSION_DIR",
  "LARVA_PI_AGENT_PERSONA_SWITCH", "LARVA_PI_INITIAL_PERSONA_ID", "LARVA_PI_INITIAL_PERSONA_MODEL_FROM_CLI",
  "LARVA_PI_MODEL_MAP_FILE", "LARVA_PI_TOOL_POLICY_FILE",
  "LARVA_PI_CHILD_SESSION_DIR", "LARVA_PI_SUBAGENT_CONFIG_FILE", "LARVA_CLI_ARGV_JSON",
  "LARVA_PI_CAPSULE_ROOT", "LARVA_PI_BASE_AGENT_DIR", "LARVA_PI_PARENT_PERSONA_ID",
  "LARVA_PI_LAUNCHED", "LARVA_PI_INTERACTIVE_TUI", "LARVA_PI_CHILD_RPC_FRAME_BOUND",
  "LARVA_PI_CHILD_REQUESTED_THINKING", "LARVA_PI_EXTENSION_ENTRY", "LARVA_PI_EXTENSION_FLAG",
  "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY", "MISTRAL_API_KEY", "GROQ_API_KEY", "XAI_API_KEY",
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AZURE_OPENAI_API_KEY",
];

function resolvePi085Index() {
  const envPath = process.env.LARVA_TEST_PI_CODING_AGENT;
  let pkg = null;
  if (typeof envPath === "string" && envPath.length > 0) {
    pkg = envPath;
    if (pkg.endsWith("/dist/index.js")) pkg = dirname(dirname(pkg));
    else if (pkg.endsWith("/dist")) pkg = dirname(pkg);
  } else {
    pkg = join(root, "contrib/pi-extension/node_modules/@earendil-works/pi-coding-agent");
  }
  const pkgJsonPath = join(pkg, "package.json");
  const index = join(pkg, "dist/index.js");
  if (!existsSync(pkgJsonPath) || !existsSync(index)) {
    throw new Error(`Required Pi 0.85.1 package not found at ${pkg}`);
  }
  const version = JSON.parse(readFileSync(pkgJsonPath, "utf8")).version;
  if (version !== "0.85.1") {
    throw new Error(`Expected Pi version 0.85.1, found ${version} at ${pkg}`);
  }
  return { index, version, pkg };
}

function systemTextFromPayload(payload) {
  if (typeof payload?.instructions === "string") return payload.instructions;
  const messages = Array.isArray(payload?.messages) ? payload.messages : Array.isArray(payload?.input) ? payload.input : [];
  const leading = messages.find((message) => message?.role === "system" || message?.role === "developer");
  if (typeof leading?.content === "string") return leading.content;
  if (Array.isArray(leading?.content)) {
    return leading.content.map((part) => typeof part?.text === "string" ? part.text : "").join("\n");
  }
  if (typeof payload?.system === "string") return payload.system;
  if (Array.isArray(payload?.system)) {
    return payload.system.map((block) => typeof block?.text === "string" ? block.text : "").join("\n");
  }
  if (typeof payload?.context?.systemPrompt === "string") return payload.context.systemPrompt;
  return "";
}

function payloadContainsWake(payload) {
  return JSON.stringify(payload ?? {}).includes(CALLBACK_WAKE);
}

function payloadToolResultCount(payload) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  return messages.filter((message) => message?.role === "tool" || message?.role === "toolResult").length;
}

function nonLarvaBase(system) {
  return String(system ?? "")
    .replace(/<!-- larva:identity-policy:begin -->[\s\S]*?<!-- larva:identity-policy:end -->/g, "")
    .replace(/<!-- larva:active-persona:begin -->[\s\S]*?<!-- larva:active-persona:end -->/g, "")
    .trim();
}

function sseChunk(modelId, delta, finishReason = null) {
  return `data: ${JSON.stringify({
    id: `idle-id-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function writeSse(response, chunks) {
  response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
  for (const chunk of chunks) response.write(chunk);
  response.end("data: [DONE]\n\n");
}

function assertCurrentIdentity(system, label) {
  assert.ok(system.includes(SPEC_MARKER), `${label} must contain current larva-spec`);
  assert.ok(system.includes(IDENTITY_BEGIN), `${label} must contain identity-policy`);
  assert.ok(system.includes(PERSONA_PROMPT), `${label} must contain current envelope prompt`);
  assert.equal(system.split("larva-spec:").length - 1, 1, `${label} must contain one larva-spec`);
  assert.equal(system.split(IDENTITY_BEGIN).length - 1, 1, `${label} must contain one identity-policy`);
}

function restoreEnv(originalEnv) {
  for (const key of Object.keys(process.env)) {
    if (!Object.prototype.hasOwnProperty.call(originalEnv, key)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

async function main() {
  const piResolved = resolvePi085Index();
  const originalEnv = { ...process.env };
  const tempRoot = await mkdtemp(join(tmpdir(), "larva-idle-identity-"));
  const home = join(tempRoot, "home");
  const cwd = join(tempRoot, "project");
  const agentDir = join(home, ".pi", "agent");
  const captured = [];
  const sockets = new Set();
  let server = null;
  try {
    for (const key of QUARANTINE_KEYS) delete process.env[key];
    process.env.HOME = home;
    process.env.TMPDIR = join(tempRoot, "tmp");
    process.env.XDG_CACHE_HOME = join(tempRoot, "xdg-cache");
    process.env.XDG_CONFIG_HOME = join(tempRoot, "xdg-config");
    process.env.XDG_DATA_HOME = join(tempRoot, "xdg-data");
    process.env.PI_OFFLINE = "1";
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.LARVA_PI_INITIAL_PERSONA_ID = PERSONA_ID;
    process.env.LARVA_PI_AGENT_PERSONA_SWITCH = "manual";
    await mkdir(cwd, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await mkdir(process.env.TMPDIR, { recursive: true });
    const readTargetA = join(cwd, "idle-read-a.txt");
    const readTargetB = join(cwd, "idle-read-b.txt");
    await writeFile(readTargetA, "idle-read-a-ok\n", "utf8");
    await writeFile(readTargetB, "idle-read-b-ok\n", "utf8");
    const fakeCli = join(tempRoot, "fake-larva-cli.mjs");
    await writeFile(fakeCli, `#!/usr/bin/env node
const [, , command, arg, jsonFlag] = process.argv;
if (command === "resolve" && jsonFlag === "--json") {
  process.stdout.write(JSON.stringify({ data: {
    id: arg,
    description: "Orchestrator identity proof",
    prompt: ${JSON.stringify(PERSONA_PROMPT)},
    model: "loopback/idle-id",
    capabilities: {},
    spec_version: "0.1.0",
    spec_digest: ${JSON.stringify(PERSONA_DIGEST)},
    can_spawn: true
  }}));
  process.exit(0);
}
if (command === "list" && arg === "--json") {
  process.stdout.write(JSON.stringify({ data: [{ id: ${JSON.stringify(PERSONA_ID)}, description: "Orchestrator", model: "loopback/idle-id", spec_digest: ${JSON.stringify(PERSONA_DIGEST)}, capabilities: {} }] }));
  process.exit(0);
}
process.exit(3);
`, "utf8");
    process.env.LARVA_CLI_ARGV_JSON = JSON.stringify([process.execPath, fakeCli]);

    const modelId = "idle-id";
    server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk.toString("utf8");
      let payload = {};
      try { payload = body.length > 0 ? JSON.parse(body) : {}; } catch { payload = { raw: body }; }
      const remoteAddress = request.socket.remoteAddress ?? "";
      const loopback = /^(?:127\.|::1$|::ffff:127\.)/.test(remoteAddress);
      const toolResults = payloadToolResultCount(payload);
      captured.push({
        path: request.url ?? "",
        loopback,
        system: systemTextFromPayload(payload),
        wake: payloadContainsWake(payload),
        toolResults,
      });
      if (!loopback) {
        response.writeHead(403, { connection: "close" });
        response.end();
        return;
      }
      if (payloadContainsWake(payload) && toolResults === 0) {
        writeSse(response, [
          sseChunk(modelId, { role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_read_idle_a", type: "function", function: { name: "read", arguments: "" } }] }),
          sseChunk(modelId, { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: readTargetA }) } }] }),
          sseChunk(modelId, {}, "tool_calls"),
        ]);
        return;
      }
      if (payloadContainsWake(payload) && toolResults === 1) {
        writeSse(response, [
          sseChunk(modelId, { role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_read_idle_b", type: "function", function: { name: "read", arguments: "" } }] }),
          sseChunk(modelId, { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: readTargetB }) } }] }),
          sseChunk(modelId, {}, "tool_calls"),
        ]);
        return;
      }
      const text = payloadContainsWake(payload) ? "idle-after-reads" : "user-turn-done";
      writeSse(response, [
        sseChunk(modelId, { role: "assistant", content: text }),
        sseChunk(modelId, {}, "stop"),
      ]);
    });
    server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
    await new Promise((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("loopback provider failed to bind");
    const providerUrl = `http://127.0.0.1:${address.port}/v1`;

    await writeFile(join(agentDir, "auth.json"), JSON.stringify({
      loopback: { type: "api_key", key: "loopback-only" },
    }), "utf8");
    const pi = await import(pathToFileURL(piResolved.index).href);
    const modelRuntime = await pi.ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    modelRuntime.registerProvider("loopback", {
      name: "Idle identity loopback",
      baseUrl: providerUrl,
      apiKey: "loopback-only",
      api: "openai-completions",
      models: [{ id: modelId, name: modelId, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 256 }],
    });
    await modelRuntime.setRuntimeApiKey("loopback", "loopback-only");
    const resolvedForSerialization = [];
    const providerObservations = [];
    const loader = new pi.DefaultResourceLoader({
      cwd,
      agentDir,
      additionalExtensionPaths: [extensionPath],
      extensionFactories: [api => {
        api.on("before_agent_start", event => {
          const replies = [];
          api.events.emit("larva:resolve-system-prompt:v1", { scope: "main", systemPrompt: event.systemPrompt, reply: result => replies.push(result) });
          assert.equal(replies.length, 1);
          assert.equal(replies[0].status, "ok");
          resolvedForSerialization.push(replies[0].systemPrompt);
          return { systemPrompt: replies[0].systemPrompt };
        });
        api.on("before_provider_request", event => { providerObservations.push(structuredClone(event.payload)); });
      }],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    });
    await loader.reload();
    const model = {
      id: modelId,
      name: modelId,
      api: "openai-completions",
      provider: "loopback",
      baseUrl: providerUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 256,
    };
    const { session } = await pi.createAgentSession({
      cwd,
      agentDir,
      model,
      thinkingLevel: "off",
      tools: ["read"],
      modelRuntime,
      resourceLoader: loader,
      sessionManager: pi.SessionManager.inMemory(cwd),
    });
    await session.bindExtensions({
      onError: () => {},
    });
    try {
      await session.prompt("Do not use tools. Reply with user-turn-done only.");
      const userTurn = captured.filter((entry) => !entry.wake);
      assert.ok(userTurn.length >= 1, "user prompt must hit the loopback provider");
      assertCurrentIdentity(userTurn[0].system, "user-turn provider request");
      assert.equal(resolvedForSerialization.length, 1);
      assert.equal(systemTextFromPayload(providerObservations[0]), resolvedForSerialization[0], "returned resolver text must pass through real Pi serializer and projection unchanged");
      assert.equal(userTurn[0].system, resolvedForSerialization[0], "loopback receives the returned resolver text");

      session.setActiveToolsByName(session.getActiveToolNames());
      const beforeIdle = captured.length;
      await session.sendCustomMessage({
        customType: "larva-subagent-result",
        content: CALLBACK_WAKE,
        display: true,
        details: { task_id: join(tempRoot, "child.jsonl"), status: "success", result_text: "child done" },
      }, { triggerTurn: true, deliverAs: "steer" });

      const idleRequests = captured.slice(beforeIdle).filter((entry) => entry.wake);
      assert.equal(idleRequests.length, 3, `idle custom turn must issue three provider requests via real read hops, got ${idleRequests.length}: ${JSON.stringify(idleRequests.map((entry) => ({ wake: entry.wake, toolResults: entry.toolResults, marker: entry.system.includes(SPEC_MARKER) })))}`);
      assert.equal(idleRequests[0].toolResults, 0, "first idle request is before the real read tool");
      assert.equal(idleRequests[1].toolResults, 1, "second idle request is the first tool continuation");
      assert.equal(idleRequests[2].toolResults, 2, "third idle request is the second tool continuation");
      const userBase = nonLarvaBase(userTurn[0].system);
      assert.ok(userBase.length > 0, "user-turn must preserve a non-Larva Pi base prompt");
      idleRequests.forEach((entry, index) => {
        assertCurrentIdentity(entry.system, `idle provider request ${index + 1}`);
        assert.ok(nonLarvaBase(entry.system).includes(userBase) || entry.system.includes(userBase), `idle provider request ${index + 1} must keep Pi base text`);
        assert.equal(entry.loopback, true);
      });

      // Synchronous request resolver on real EventBus and comparison with real provider serialization
      const eventBus = loader.eventBus;
      assert.ok(eventBus, "loader must provide real Pi EventBus");
      const resolverReplies = [];
      eventBus.emit("larva:resolve-system-prompt:v1", {
        scope: "main",
        systemPrompt: userBase,
        reply: (result) => resolverReplies.push(result),
      });
      assert.equal(resolverReplies.length, 1, "resolver on real EventBus must reply once synchronously before emit returns");
      assert.equal(resolverReplies[0].status, "ok");
      assertCurrentIdentity(resolverReplies[0].systemPrompt, "resolved system prompt");
      assert.equal(resolverReplies[0].systemPrompt, userTurn[0].system, "resolved prompt must match real provider payload system text under identical state");

      // Verify that feeding resolved prompt back to resolver is fixed-point
      const fixedPointReplies = [];
      eventBus.emit("larva:resolve-system-prompt:v1", {
        scope: "main",
        systemPrompt: resolverReplies[0].systemPrompt,
        reply: (result) => fixedPointReplies.push(result),
      });
      assert.equal(fixedPointReplies.length, 1);
      assert.equal(fixedPointReplies[0].systemPrompt, resolverReplies[0].systemPrompt);

      // Verify real Pi reload lifecycle:
      // 1. Subscribe a sidecar listener to verify other subscribers survive reload
      let sidecarCalls = 0;
      const unsubscribeSidecar = eventBus.on("test:sidecar", () => { sidecarCalls += 1; });
      eventBus.emit("test:sidecar", {});
      assert.equal(sidecarCalls, 1, "sidecar listener must receive event before reload");

      // 2. Perform real session reload
      await session.reload();

      // 3. Sidecar still receives events
      eventBus.emit("test:sidecar", {});
      assert.equal(sidecarCalls, 2, "other EventBus subscribers must survive session reload");
      unsubscribeSidecar();

      // Give new session_start async initialization turn to commit
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));

      // 4. Resolver on reloaded session: exactly one reply from new instance
      const postReloadReplies = [];
      eventBus.emit("larva:resolve-system-prompt:v1", {
        scope: "main",
        systemPrompt: userBase,
        reply: (result) => postReloadReplies.push(result),
      });
      assert.equal(postReloadReplies.length, 1, "post-reload resolver must reply exactly once without duplicate from old instance");
      assert.equal(postReloadReplies[0].status, "ok");
      assert.equal(postReloadReplies[0].systemPrompt, resolverReplies[0].systemPrompt);

      // 5. Verify no late duplicate reply from microtasks
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      assert.equal(postReloadReplies.length, 1, "no asynchronous duplicate reply after emit returns");
    } finally {
      session.dispose();
    }

    const { session: missingSlotSession } = await pi.createAgentSession({
      cwd,
      agentDir,
      model,
      thinkingLevel: "off",
      tools: [],
      modelRuntime,
      resourceLoader: loader,
      sessionManager: pi.SessionManager.inMemory(cwd),
    });
    try {
      missingSlotSession.state.systemPrompt = "";
      const beforeRepair = captured.length;
      await missingSlotSession.sendCustomMessage({
        customType: "larva-subagent-result",
        content: "MISSING_SLOT_WAKE",
        display: true,
        details: { task_id: join(tempRoot, "missing-slot.jsonl"), status: "success" },
      }, { triggerTurn: true, deliverAs: "steer" });
      const repaired = captured.slice(beforeRepair);
      assert.ok(repaired.length >= 1, "known-API empty systemPrompt must admit an instruction slot and send");
      repaired.forEach((entry, index) => {
        assertCurrentIdentity(entry.system, `repaired empty-system request ${index + 1}`);
        assert.equal(entry.loopback, true);
      });
    } finally {
      missingSlotSession.dispose();
    }
    await proveSessionReplacement(pi, { cwd, agentDir, modelRuntime, model, extensionPath, tempRoot });
  } finally {
    for (const socket of sockets) socket.destroy();
    if (server?.listening) await new Promise((resolveClose) => server.close(resolveClose));
    restoreEnv(originalEnv);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().then(() => {
  process.stdout.write("PASS idle custom callback identity on three real-read hops and admitted empty-system repair\n");
}).catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(1);
});
