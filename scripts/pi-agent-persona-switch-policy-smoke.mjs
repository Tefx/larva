#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const offline = process.argv.includes("--offline");
if (!offline) {
  console.error("Usage: node scripts/pi-agent-persona-switch-policy-smoke.mjs --offline");
  process.exit(2);
}

const root = process.cwd();
const extensionPath = join(root, "contrib/pi-extension/larva.ts");
const policyPath = join(root, "docs/reference/PI_AGENT_PERSONA_SWITCH_POLICY.md");
const extension = await readFile(extensionPath, "utf8");
const policy = await readFile(policyPath, "utf8");
const mod = await import(pathToFileURL(extensionPath).href + `?policy-smoke=${Date.now()}-${Math.random()}`);

const checks = [];
async function check(name, fn) {
  try {
    await fn();
    checks.push({ name, status: "PASS" });
  } catch (error) {
    checks.push({ name, status: "FAIL", message: error?.message || String(error) });
  }
}

await check("policy authority documents exact modes and default", () => {
  assert.match(policy, /manual < confirm < auto < free/);
  assert.match(policy, /The default mode is `confirm`\./);
  assert.match(policy, /does not define compatibility aliases\s+such as `off` or `ask`/);
});

await check("extension mode enum has no legacy off or ask aliases", () => {
  assert.match(extension, /AgentPersonaSwitchMode = "manual" \| "confirm" \| "auto" \| "free"/);
  assert.doesNotMatch(extension, /AgentPersonaSwitchMode = "off" \| "ask" \| "auto"/);
  assert.doesNotMatch(extension, /value === "off"|value === "ask"/);
});

await check("runtime default behaves as confirm and exposes request-only autonomous surface", async () => {
  const registeredTools = [];
  const registeredCommands = {};
  await mod.initializeExtension(
    { env: {}, ui: { setStatus: async () => undefined, notify: async () => undefined } },
    { registerCommand: (name, options) => { registeredCommands[name] = options; }, registerTool: (tool) => registeredTools.push(tool), on: () => undefined },
  );
  assert.deepEqual((await registeredCommands["larva-mode"].getArgumentCompletions("")).map((item) => item.value), ["manual", "confirm", "auto", "free"]);
  assert.ok(registeredTools.some((tool) => tool.name === "larva_persona_switch"));
  assert.equal(mod.decideToolCall("larva_persona_switch").action, "allow");
});

await check("source includes temporary lease model and restore boundary", () => {
  for (const token of ["PersonaLease", "originPersonaId", "borrowedPersonaId", "agent_session", "assistant turn", "LARVA_PERSONA_RESTORE_FAILED"]) {
    assert.ok(extension.includes(token), `missing ${token}`);
  }
  for (const terminal of ["success", "failure", "cancellation", "timeout"]) {
    assert.ok(extension.toLowerCase().includes(terminal), `missing restore terminal path ${terminal}`);
  }
});

await check("confirm UI exposes all four required outcomes", () => {
  for (const label of ["Borrow once", "Deny", "Auto-borrow for this session", "Switch persistently"]) {
    assert.ok(extension.includes(label), `missing ${label}`);
  }
});

await check("restore notices are never sent as assistant chat body", () => {
  const restoreIndex = extension.toLowerCase().indexOf("restore");
  assert.notEqual(restoreIndex, -1, "missing restore implementation");
  const restoreWindow = extension.slice(restoreIndex, restoreIndex + 2500);
  assert.ok(/setStatus|appendSessionCustomEntry|audit/.test(restoreWindow), "restore notice must use status/event/audit");
  assert.doesNotMatch(restoreWindow, /sendUserMessage|followUp|chat body/i);
});

await check("async subagent constraints remain exact-id and no-log", () => {
  assert.doesNotMatch(extension, /"larva-log"|\/larva-log/);
  for (const token of ["larva_subagent_wait", "larva_subagent_select", "larva_subagent_events", "exact task_id", "last alias", "fuzzy"]) {
    assert.ok(extension.includes(token), `missing async subagent constraint ${token}`);
  }
});

const failed = checks.filter((item) => item.status === "FAIL");
console.log(JSON.stringify({ offline, status: failed.length === 0 ? "PASS" : "FAIL", checks }, null, 2));
if (failed.length > 0) process.exit(1);
