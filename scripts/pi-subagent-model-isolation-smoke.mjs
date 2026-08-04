#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = join(root, "contrib", "pi-extension", "larva.ts");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function piBinary() {
  if (process.env.LARVA_TEST_PI_BIN) return process.env.LARVA_TEST_PI_BIN;
  return execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
}

function assistantText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const last = messages.at(-1)?.content;
  if (typeof last === "string") return last;
  return JSON.stringify(last ?? "");
}

async function main() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "larva-pi-model-isolation-"));
  const agentDir = join(temporaryRoot, "pi-agent");
  const childSessionDir = join(temporaryRoot, "child-sessions");
  const settingsPath = join(agentDir, "settings.json");
  const fakeLarvaCli = join(temporaryRoot, "fake-larva-cli.mjs");
  const requests = [];
  let settingsWatcher = null;
  let settingsSampler = null;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const text = assistantText(body);
    requests.push({ model: body.model ?? null, text });
    if (text.includes("cancel-model-a")) await sleep(1500);
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const id = `chatcmpl-${requests.length}`;
    const base = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model };
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: `reply:${body.model}` }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });

  try {
    await mkdir(agentDir, { recursive: true });
    await mkdir(childSessionDir, { recursive: true });
    await new Promise((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    const address = server.address();
    requireCondition(address && typeof address === "object", "local provider did not bind a TCP port");

    await writeFile(join(agentDir, "models.json"), JSON.stringify({
      providers: {
        isolation: {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          api: "openai-completions",
          apiKey: "test-only-key",
          models: [
            { id: "model-a", reasoning: false },
            { id: "model-b", reasoning: false },
          ],
        },
      },
    }, null, 2));
    await writeFile(settingsPath, JSON.stringify({ defaultProvider: "isolation", defaultModel: "model-a" }, null, 2));
    await writeFile(fakeLarvaCli, `
const [, , command, personaId, jsonFlag] = process.argv;
if (command !== "resolve" || jsonFlag !== "--json") process.exit(3);
const models = JSON.parse(process.env.LARVA_TEST_PERSONA_MODELS || "{}");
const model = models[personaId];
if (typeof model !== "string") process.exit(4);
process.stdout.write(JSON.stringify({ data: {
  id: personaId,
  description: "Isolation smoke persona " + personaId,
  prompt: "Return a short test response.",
  model,
  capabilities: {},
  spec_version: "0.1.0",
  spec_digest: "sha256:" + "a".repeat(64),
  can_spawn: true
} }));
`, "utf8");

    const baselineBytes = await readFile(settingsPath);
    const baselineHash = sha256(baselineBytes);
    const observedHashes = new Set([baselineHash]);
    const settingsEvents = [];
    settingsWatcher = watch(settingsPath, (eventType) => settingsEvents.push(eventType));
    settingsSampler = setInterval(async () => {
      try {
        observedHashes.add(sha256(await readFile(settingsPath)));
      } catch {
        observedHashes.add("<unreadable>");
      }
    }, 1);

    const personaModels = {
      parent: "isolation/model-a",
      solo: "isolation/model-a",
      alpha: "isolation/model-a",
      beta: "isolation/model-b",
      cancel: "isolation/model-a",
      broken: "missing-provider/model-missing",
    };
    const env = {
      ...process.env,
      HOME: temporaryRoot,
      PI_CODING_AGENT_DIR: agentDir,
      LARVA_PI_BASE_AGENT_DIR: agentDir,
      LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, fakeLarvaCli]),
      LARVA_PI_REAL_BIN: piBinary(),
      LARVA_PI_EXTENSION_FLAG: "-e",
      LARVA_PI_EXTENSION_ENTRY: extensionPath,
      LARVA_PI_CHILD_SESSION_DIR: childSessionDir,
      LARVA_PI_INITIAL_PERSONA_ID: "",
      LARVA_PI_INTERACTIVE_TUI: "0",
      LARVA_PI_LAUNCHED: "1",
      LARVA_TEST_PERSONA_MODELS: JSON.stringify(personaModels),
    };

    const mod = await import(`${pathToFileURL(extensionPath).href}?isolation=${Date.now()}`);
    const parentModelCalls = [];
    const parentCtx = {
      env,
      ui: { setStatus: () => undefined, notify: () => undefined },
      modelRegistry: { find: async (provider, id) => ({ provider, id }) },
    };
    const parentPi = {
      getAllTools: async () => ["larva_subagent"],
      setActiveTools: async () => true,
      setModel: async (model) => { parentModelCalls.push(model); return true; },
      registerTool: () => undefined,
      registerCommand: () => undefined,
      on: () => undefined,
    };
    const parentCommit = await mod.commitPersona("parent", parentCtx, parentPi);
    requireCondition(parentCommit.ok === true, `parent persona commit failed: ${JSON.stringify(parentCommit)}`);
    const parentEnvelopeBefore = JSON.stringify(mod.getActiveEnvelope());
    const parentModelCallCountBefore = parentModelCalls.length;

    const solo = await mod.larva_subagent({ persona_id: "solo", task: "single-model-alpha" }, parentCtx);
    requireCondition(solo.status === "accepted", `single child was not accepted: ${JSON.stringify(solo)}`);
    await mod.larva_subagent_wait({ task_ids: [solo.task_id], return_when: "all", timeout_ms: 20000 }, parentCtx);

    const [alpha, beta] = await Promise.all([
      mod.larva_subagent({ persona_id: "alpha", task: "concurrent-model-alpha" }, parentCtx),
      mod.larva_subagent({ persona_id: "beta", task: "concurrent-model-beta" }, parentCtx),
    ]);
    requireCondition(alpha.status === "accepted" && beta.status === "accepted", `concurrent children were not accepted: ${JSON.stringify({ alpha, beta })}`);
    await mod.larva_subagent_wait({ task_ids: [alpha.task_id, beta.task_id], return_when: "all", timeout_ms: 20000 }, parentCtx);

    const resumed = await mod.larva_subagent({ persona_id: "alpha", task: "resume-model-alpha", task_id: alpha.task_id }, parentCtx);
    requireCondition(resumed.status === "accepted", `resumed child was not accepted: ${JSON.stringify(resumed)}`);
    await mod.larva_subagent_wait({ task_ids: [resumed.task_id], return_when: "all", timeout_ms: 20000 }, parentCtx);

    const cancelReceipt = await mod.larva_subagent({ persona_id: "cancel", task: "cancel-model-a" }, parentCtx);
    requireCondition(cancelReceipt.status === "accepted", `cancellable child was not accepted: ${JSON.stringify(cancelReceipt)}`);
    const cancelRequest = await mod.larva_subagent_cancel({ task_id: cancelReceipt.task_id, reason: "model isolation cancellation proof" }, parentCtx);
    requireCondition(["cancelling", "cancelled"].includes(cancelRequest.details?.status), `child cancellation failed: ${JSON.stringify(cancelRequest)}`);
    await mod.larva_subagent_wait({ task_ids: [cancelReceipt.task_id], return_when: "all", timeout_ms: 20000 }, parentCtx);
    const cancelStatus = await mod.larva_subagent_status({ task_id: cancelReceipt.task_id }, parentCtx);
    const cancelTerminalStatus = cancelStatus.details?.runs?.[0]?.status ?? null;
    requireCondition(cancelTerminalStatus === "cancelled", `child did not reach cancelled terminal state: ${JSON.stringify(cancelStatus)}`);

    const broken = await mod.larva_subagent({ persona_id: "broken", task: "startup-failure-must-not-write-settings" }, parentCtx);
    requireCondition(broken.status === "failed", `invalid child model unexpectedly started: ${JSON.stringify(broken)}`);

    await sleep(100);
    clearInterval(settingsSampler);
    settingsSampler = null;
    settingsWatcher.close();
    settingsWatcher = null;
    const finalHash = sha256(await readFile(settingsPath));
    observedHashes.add(finalHash);
    const parentEnvelopeAfter = JSON.stringify(mod.getActiveEnvelope());
    const singleUsedModelA = requests.some((entry) => entry.model === "model-a" && entry.text.includes("single-model-alpha"));
    const alphaUsedModelA = requests.some((entry) => entry.model === "model-a" && entry.text.includes("concurrent-model-alpha"));
    const betaUsedModelB = requests.some((entry) => entry.model === "model-b" && entry.text.includes("concurrent-model-beta"));
    const resumeUsedModelA = requests.some((entry) => entry.model === "model-a" && entry.text.includes("resume-model-alpha"));
    const evidence = {
      piVersion: execFileSync(env.LARVA_PI_REAL_BIN, ["--version"], { encoding: "utf8" }).trim(),
      baselineHash,
      finalHash,
      observedHashes: [...observedHashes],
      settingsEvents,
      singleUsedModelA,
      concurrentAssignedModels: { alphaUsedModelA, betaUsedModelB },
      resumeUsedModelA,
      cancelStatus: cancelTerminalStatus,
      startupFailure: { status: broken.status, code: broken.error?.code ?? null },
      parentUnchanged: parentEnvelopeBefore === parentEnvelopeAfter && parentModelCalls.length === parentModelCallCountBefore,
      requestModels: requests.map((entry) => entry.model),
    };
    requireCondition(observedHashes.size === 1 && finalHash === baselineHash, `shared settings hash changed: ${JSON.stringify(evidence)}`);
    requireCondition(settingsEvents.length === 0, `shared settings file emitted change events: ${JSON.stringify(evidence)}`);
    requireCondition(singleUsedModelA, `single child did not use assigned model: ${JSON.stringify(evidence)}`);
    requireCondition(alphaUsedModelA && betaUsedModelB, `concurrent children did not use assigned models: ${JSON.stringify(evidence)}`);
    requireCondition(resumeUsedModelA, `resumed child did not use assigned model: ${JSON.stringify(evidence)}`);
    requireCondition(evidence.parentUnchanged, `parent persona/model changed: ${JSON.stringify(evidence)}`);
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    if (settingsSampler !== null) clearInterval(settingsSampler);
    settingsWatcher?.close();
    server.closeAllConnections?.();
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((caught) => {
  console.error(caught instanceof Error ? caught.stack : String(caught));
  process.exitCode = 1;
});
