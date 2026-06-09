#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const offline = process.argv.includes("--offline");
const live = process.argv.includes("--live");
if (!offline || live) {
  console.error("Usage: node scripts/pi-agent-persona-switch-policy-smoke.mjs --offline");
  console.error("--live is intentionally unsupported by this smoke harness; local proof is --offline plus targeted runtime pytest.");
  process.exit(2);
}

const root = process.cwd();
const extensionPath = join(root, "contrib/pi-extension/larva.ts");
const extension = await readFile(extensionPath, "utf8");
const checks = [];
const behavioralProofRegister = [];

const REQUIRED_REQUIREMENTS = [
  "default_confirm_registers_request_tools",
  "confirm_request_only_autonomous_surface",
  "manual_mode_autonomous_unavailable",
  "stale_or_forged_manual_request_fail_closed",
  "explicit_user_slash_persona_success_no_lease",
  "manual_switch_active_lease_precedence",
  "restore_terminal_success",
  "restore_terminal_failure",
  "restore_terminal_cancellation",
  "restore_terminal_timeout",
  "restore_failure_state_preservation_reporting_audit_user_choice_no_fallback",
  "restore_notices_outside_assistant_chat_body",
  "async_exact_handle_no_alias_constraints",
  "unsupported_live_not_required",
];

async function check(name, fn) {
  try {
    const evidence = await fn();
    checks.push({ name, status: "PASS", ...(evidence === undefined ? {} : { evidence }) });
  } catch (error) {
    checks.push({ name, status: "FAIL", message: error?.stack || error?.message || String(error) });
  }
}

function recordProof(requirement_ref, behavior_claim, runtime_proof_expected, evidence_ref, status = "PASS", closure_path = "offline real-extension runtime probe", gate_decision_basis = "assertions passed") {
  behavioralProofRegister.push({
    requirement_ref,
    behavior_claim,
    runtime_proof_expected,
    evidence_ref,
    status,
    closure_path,
    gate_decision_basis,
  });
}

function proofMarkdown(rows) {
  const header = "| requirement_ref | behavior_claim | runtime_proof_expected | evidence_ref | status | closure_path | gate_decision_basis |";
  const sep = "| --- | --- | --- | --- | --- | --- | --- |";
  const escape = (value) => String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
  return [header, sep, ...rows.map((row) => `| ${escape(row.requirement_ref)} | ${escape(row.behavior_claim)} | ${escape(row.runtime_proof_expected)} | ${escape(row.evidence_ref)} | ${escape(row.status)} | ${escape(row.closure_path)} | ${escape(row.gate_decision_basis)} |`)].join("\n");
}

function latestAudit(entries, predicate = () => true) {
  return entries.filter((entry) => entry.customType === "larva-agent-persona-switch-audit" && predicate(entry.data)).at(-1) ?? null;
}

function specs() {
  const make = (id, marker) => ({
    id,
    description: `Persona ${id}`,
    prompt: `Prompt for ${id}\n${marker}`,
    model: "provider/model",
    capabilities: {},
    spec_version: "0.1.0",
    spec_digest: `sha256:${id}`,
    can_spawn: true,
  });
  return {
    architect: make("architect", "ARCHITECT_RUNTIME_PROMPT_MARKER"),
    python: make("python", "PYTHON_RUNTIME_PROMPT_MARKER"),
    reviewer: make("reviewer", "REVIEWER_RUNTIME_PROMPT_MARKER"),
  };
}

async function createFakeLarvaCli(tmpRoot) {
  const statePath = join(tmpRoot, "fake-larva-state.json");
  const cliPath = join(tmpRoot, "fake-larva-cli.mjs");
  await writeFile(statePath, JSON.stringify({ failResolveIds: [] }), "utf8");
  await writeFile(cliPath, `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const statePath = ${JSON.stringify(statePath)};
const specMap = ${JSON.stringify(specs())};
const state = JSON.parse(readFileSync(statePath, "utf8"));
const [, , command, arg, jsonFlag] = process.argv;
if (command === "list" && arg === "--json") {
  process.stdout.write(JSON.stringify({ data: Object.values(specMap).map(({ id, description, spec_digest, model, capabilities }) => ({ id, description, spec_digest, model, capabilities })) }));
  process.exit(0);
}
if (command === "resolve" && jsonFlag === "--json") {
  if (state.failResolveIds.includes(arg)) process.exit(44);
  const spec = specMap[arg];
  if (!spec) process.exit(45);
  process.stdout.write(JSON.stringify({ data: spec }));
  process.exit(0);
}
process.exit(46);
`, { encoding: "utf8", mode: 0o755 });
  return { cliPath, statePath };
}

async function setFakeCliFailures(statePath, failResolveIds) {
  await writeFile(statePath, JSON.stringify({ failResolveIds }), "utf8");
}

let importCounter = 0;
async function importFreshExtension() {
  importCounter += 1;
  return import(pathToFileURL(extensionPath).href + `?policy-smoke=${Date.now()}-${process.pid}-${importCounter}`);
}

async function createRuntime({ mode, initialPersonaId = "", selectOutcome = "borrow_once", confirmResult = true } = {}) {
  const tmpRoot = await mkdtemp(join(tmpdir(), "larva-persona-policy-smoke-"));
  const { cliPath, statePath } = await createFakeLarvaCli(tmpRoot);
  const childRoot = join(tmpRoot, "child-sessions");
  const env = {
    HOME: tmpRoot,
    LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, cliPath]),
    LARVA_PI_AGENT_PERSONA_SWITCH: mode,
    LARVA_PI_INITIAL_PERSONA_ID: initialPersonaId,
    LARVA_PI_INTERACTIVE_TUI: "0",
    LARVA_PI_CHILD_SESSION_DIR: childRoot,
    LARVA_PI_PERSONA_CANDIDATES_CACHE_FILE: join(tmpRoot, "persona-candidates-cache.json"),
  };
  const mod = await importFreshExtension();
  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  const sessionEntries = [];
  const statuses = [];
  const notifications = [];
  const activeToolCalls = [];
  const chatMessages = [];
  const ctx = {
    env,
    ui: {
      setStatus: async (...args) => statuses.push(args),
      notify: async (...args) => notifications.push(args),
      select: async () => ({ id: selectOutcome }),
      confirm: async () => confirmResult,
    },
    modelRegistry: { find: async () => ({ provider: "provider", id: "model" }) },
    session: {
      entries: sessionEntries,
      getEntries: () => sessionEntries,
      appendEntry: (customType, data) => sessionEntries.push({ type: "custom", customType, data }),
    },
    sendUserMessage: (...args) => chatMessages.push(["ctx.sendUserMessage", args]),
    sendMessage: (...args) => chatMessages.push(["ctx.sendMessage", args]),
    sendCustomMessage: (...args) => chatMessages.push(["ctx.sendCustomMessage", args]),
  };
  const pi = {
    appendEntry: (customType, data) => sessionEntries.push({ type: "custom", customType, data }),
    getAllTools: async () => ["read", "grep", "larva_persona_switch", "larva_personas", "larva_subagent"],
    setActiveTools: async (activeTools) => { activeToolCalls.push(activeTools); return true; },
    setModel: async () => true,
    registerCommand: (name, options) => commands.set(name, options),
    registerTool: (tool) => tools.set(tool.name, tool),
    on: (event, handler) => handlers.set(event, handler),
    sendUserMessage: (...args) => chatMessages.push(["pi.sendUserMessage", args]),
    sendMessage: (...args) => chatMessages.push(["pi.sendMessage", args]),
  };
  await mod.initializeExtension(ctx, pi);
  return { tmpRoot, statePath, env, mod, ctx, pi, tools, commands, handlers, sessionEntries, statuses, notifications, activeToolCalls, chatMessages };
}

async function executeSwitch(rt, personaId, reason = "runtime smoke proof") {
  const tool = rt.tools.get("larva_persona_switch");
  assert.ok(tool, "larva_persona_switch must be registered for this scenario");
  return tool.execute("policy-smoke-switch", { persona_id: personaId, reason, handoff: "handoff" }, undefined, undefined, rt.ctx);
}

await check("extension mode enum has no legacy off or ask aliases", () => {
  assert.match(extension, /AgentPersonaSwitchMode = "manual" \| "confirm" \| "auto" \| "free"/);
  assert.doesNotMatch(extension, /AgentPersonaSwitchMode = "off" \| "ask" \| "auto"/);
  assert.doesNotMatch(extension, /value === "off"|value === "ask"/);
});

await check("runtime default confirm registers request-only autonomous tools", async () => {
  const rt = await createRuntime({ mode: undefined });
  const modeCompletions = await rt.commands.get("larva-mode").getArgumentCompletions("");
  assert.deepEqual(modeCompletions.map((item) => item.value), ["manual", "confirm", "auto", "free"]);
  assert.ok(rt.tools.has("larva_persona_switch"));
  assert.ok(rt.tools.has("larva_personas"));
  assert.equal(rt.mod.decideToolCall("larva_persona_switch").action, "allow");
  const switchTool = rt.tools.get("larva_persona_switch");
  assert.match(switchTool.description, /Request an autonomous Larva persona borrow\/switch/);
  for (const label of ["Borrow once", "Deny", "Auto-borrow for this session", "Switch persistently"]) {
    assert.match(switchTool.description, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  recordProof("default_confirm_registers_request_tools", "Default confirm mode registers larva_persona_switch and larva_personas from the bundled extension", "registerTool observes both tools and decideToolCall allows larva_persona_switch", "check:runtime default confirm registers request-only autonomous tools", "PASS", "runtime registration", "real initializeExtension import with inherited manual env neutralized by explicit undefined ctx.env");
  recordProof("confirm_request_only_autonomous_surface", "Confirm-mode surface is request-only and exposes all four user outcomes", "registered tool description names request semantics and Borrow once/Deny/Auto-borrow/Switch persistently outcomes", "check:runtime default confirm registers request-only autonomous tools", "PASS", "runtime registered tool metadata", "tool comes from real extension registerTool, not duplicate policy model");
  return { registeredToolNames: Array.from(rt.tools.keys()).filter((name) => name.startsWith("larva_persona")) };
});

await check("manual mode hides or rejects autonomous persona surfaces and stale forged calls fail closed", async () => {
  const rt = await createRuntime({ mode: "manual" });
  assert.equal(rt.tools.has("larva_persona_switch"), false);
  assert.equal(rt.tools.has("larva_personas"), false);
  const decision = rt.mod.decideToolCall("larva_persona_switch");
  assert.equal(decision.action, "deny");
  assert.equal(decision.error.code, "LARVA_AGENT_PERSONA_SWITCH_MANUAL");
  const forged = await rt.mod.larva_persona_switch({ persona_id: "python", reason: "stale forged call" }, rt.ctx, rt.pi);
  assert.equal(forged.status, "failed");
  assert.equal(forged.error.code, "LARVA_AGENT_PERSONA_SWITCH_MANUAL");
  const audit = latestAudit(rt.sessionEntries, (data) => data.forged_or_stale === true);
  assert.ok(audit, "manual forged/stale audit entry missing");
  recordProof("manual_mode_autonomous_unavailable", "Manual mode does not register autonomous persona tools and tool-call policy denies them", "registered tools omit larva_persona_switch/larva_personas and decideToolCall denies", "check:manual mode hides or rejects autonomous persona surfaces and stale forged calls fail closed", "PASS", "runtime registration and policy hook", "manual mode from real initializeExtension");
  recordProof("stale_or_forged_manual_request_fail_closed", "A stale/forged direct larva_persona_switch call in manual mode fails closed", "exported handler returns LARVA_AGENT_PERSONA_SWITCH_MANUAL and audit marks forged_or_stale", "check:manual mode hides or rejects autonomous persona surfaces and stale forged calls fail closed", "PASS", "runtime handler fail-closed", "no persona/model/tool commit occurs");
  return { decision, forgedStatus: forged.status, audit: audit.data };
});

await check("explicit user /larva-persona switch succeeds without creating a restore lease", async () => {
  const rt = await createRuntime({ mode: "manual", initialPersonaId: "architect" });
  const result = await rt.commands.get("larva-persona").handler("python", rt.ctx);
  assert.equal(result.ok, true);
  assert.equal(rt.mod.getActiveEnvelope()?.persona_id, "python");
  await rt.handlers.get("agent_end")?.({ terminal: "success" }, rt.ctx);
  assert.equal(rt.mod.getActiveEnvelope()?.persona_id, "python");
  const restoreAudits = rt.sessionEntries.filter((entry) => entry.customType === "larva-agent-persona-switch-audit" && entry.data.event === "restore");
  assert.equal(restoreAudits.length, 0);
  recordProof("explicit_user_slash_persona_success_no_lease", "Explicit user /larva-persona <id> commits the chosen persona and creates no automatic restore lease", "after /larva-persona python, agent_end does not restore architect and no restore audit appears", "check:explicit user /larva-persona switch succeeds without creating a restore lease", "PASS", "runtime slash-command handler", "manual user authority has precedence over autonomous lease model");
  return { activePersonaAfterAgentEnd: rt.mod.getActiveEnvelope()?.persona_id, restoreAuditCount: restoreAudits.length };
});

await check("manual switch clears an active autonomous lease before restore", async () => {
  const rt = await createRuntime({ mode: "auto", initialPersonaId: "architect" });
  const borrowed = await executeSwitch(rt, "python", "borrow before manual override");
  assert.equal(borrowed.status, "success");
  assert.equal(rt.mod.getActiveEnvelope()?.persona_id, "python");
  const manual = await rt.commands.get("larva-persona").handler("reviewer", rt.ctx);
  assert.equal(manual.ok, true);
  await rt.handlers.get("agent_end")?.({ terminal: "success" }, rt.ctx);
  assert.equal(rt.mod.getActiveEnvelope()?.persona_id, "reviewer");
  const clearAudit = latestAudit(rt.sessionEntries, (data) => data.event === "manual switch clears active lease");
  assert.ok(clearAudit, "manual switch did not audit active lease clearance");
  recordProof("manual_switch_active_lease_precedence", "A user manual switch during an active autonomous lease clears the lease and prevents old-origin restore", "borrow architect->python, /larva-persona reviewer, agent_end leaves reviewer active", "check:manual switch clears an active autonomous lease before restore", "PASS", "runtime lease precedence", "audit records manual switch clears active lease");
  return { activePersonaAfterAgentEnd: rt.mod.getActiveEnvelope()?.persona_id, clearAudit: clearAudit.data };
});

async function restoreTerminalProbe(terminal) {
  const rt = await createRuntime({ mode: "auto", initialPersonaId: "architect" });
  const borrowed = await executeSwitch(rt, "python", `restore terminal ${terminal}`);
  assert.equal(borrowed.status, "success");
  await rt.handlers.get("agent_end")?.({ terminal }, rt.ctx);
  assert.equal(rt.mod.getActiveEnvelope()?.persona_id, "architect");
  const audit = latestAudit(rt.sessionEntries, (data) => data.event === "restore" && data.terminal === terminal);
  assert.ok(audit, `missing restore audit for ${terminal}`);
  assert.equal(audit.data.restored, true);
  assert.equal(rt.chatMessages.length, 0);
  recordProof(`restore_terminal_${terminal}`, `Turn-scoped lease restores origin persona on assistant terminal ${terminal}`, `auto borrow python from architect then agent_end ${terminal} restores architect`, `check:restore terminal ${terminal}`, "PASS", "runtime agent_end restore hook", "status/event/audit only; no chat messages captured");
  return { terminal, activePersonaAfterRestore: rt.mod.getActiveEnvelope()?.persona_id, audit: audit.data, chatMessages: rt.chatMessages.length };
}

for (const terminal of ["success", "failure", "cancellation", "timeout"]) {
  await check(`restore terminal ${terminal}`, () => restoreTerminalProbe(terminal));
}

await check("restore failure preserves state, reports, audits, requires user choice, and avoids fallback", async () => {
  const rt = await createRuntime({ mode: "auto", initialPersonaId: "architect" });
  const borrowed = await executeSwitch(rt, "python", "restore failure proof");
  assert.equal(borrowed.status, "success");
  await setFakeCliFailures(rt.statePath, ["architect"]);
  await rt.handlers.get("agent_end")?.({ terminal: "success" }, rt.ctx);
  assert.equal(rt.mod.getActiveEnvelope()?.persona_id, "python");
  const failureAudit = latestAudit(rt.sessionEntries, (data) => data.event === "restore" && data.restored === false);
  assert.ok(failureAudit, "missing restore failure audit");
  assert.equal(failureAudit.data.error_code, "LARVA_PERSONA_RESTORE_FAILED");
  assert.equal(failureAudit.data.preserve_current_runtime_state, true);
  assert.equal(failureAudit.data.explicit_user_persona_choice_required, true);
  assert.equal(failureAudit.data.safe_default_fallback, false);
  assert.ok(rt.notifications.some(([message, kind]) => String(message).includes("LARVA_PERSONA_RESTORE_FAILED") && kind === "error"));
  const autonomousAfterFailure = await rt.mod.larva_persona_switch({ persona_id: "reviewer", reason: "blocked until user choice" }, rt.ctx, rt.pi);
  assert.equal(autonomousAfterFailure.status, "failed");
  assert.equal(autonomousAfterFailure.error.code, "LARVA_PERSONA_RESTORE_FAILED");
  const userChoice = await rt.commands.get("larva-persona").handler("reviewer", rt.ctx);
  assert.equal(userChoice.ok, true);
  assert.equal(rt.mod.getActiveEnvelope()?.persona_id, "reviewer");
  assert.equal(rt.chatMessages.length, 0);
  recordProof("restore_failure_state_preservation_reporting_audit_user_choice_no_fallback", "Restore failure preserves borrowed runtime state, reports through UI, audits required fields, blocks further autonomous changes until explicit user choice, and performs no safe-default fallback", "failed architect restore leaves python active, emits notification/audit, autonomous switch fails with LARVA_PERSONA_RESTORE_FAILED, /larva-persona reviewer succeeds", "check:restore failure preserves state, reports, audits, requires user choice, and avoids fallback", "PASS", "runtime restore failure path", "active persona remains borrowed until explicit user choice; audit safe_default_fallback=false");
  recordProof("restore_notices_outside_assistant_chat_body", "Restore success/failure notices use status/notify/audit surfaces and never assistant chat body", "restore probes capture status/audit/notify and zero sendUserMessage/sendMessage calls", "checks:restore terminal * + restore failure preserves state", "PASS", "runtime surface capture", "chatMessages length remains zero across restore paths");
  return { activeAfterFailedRestore: "python", activeAfterUserChoice: rt.mod.getActiveEnvelope()?.persona_id, failureAudit: failureAudit.data, notifications: rt.notifications, chatMessages: rt.chatMessages.length, autonomousAfterFailure: autonomousAfterFailure.error };
});

await check("async subagent exact-handle and no-alias constraints remain enforced", async () => {
  const rt = await createRuntime({ mode: undefined });
  for (const name of ["larva_subagent", "larva_subagent_status", "larva_subagent_events", "larva_subagent_wait", "larva_subagent_select", "larva_subagent_cancel"]) {
    assert.ok(rt.tools.has(name), `missing ${name}`);
  }
  assert.doesNotMatch(JSON.stringify(rt.tools.get("larva_subagent").inputSchema.properties.task_id), /null/);
  assert.match(rt.tools.get("larva_subagent").description, /larva_subagent_wait, larva_subagent_select, or larva_subagent_events/);
  const statusAlias = await rt.tools.get("larva_subagent_status").execute("status-alias", { task_id: "last" }, undefined, undefined, rt.ctx);
  const waitAlias = await rt.tools.get("larva_subagent_wait").execute("wait-alias", { task_ids: ["latest"], timeout_ms: 0 }, undefined, undefined, rt.ctx);
  const selectAlias = await rt.tools.get("larva_subagent_select").execute("select-alias", { task_ids: ["persona-id"], timeout_ms: 0 }, undefined, undefined, rt.ctx);
  const eventsAlias = await rt.tools.get("larva_subagent_events").execute("events-alias", { task_ids: ["fuzzy"] }, undefined, undefined, rt.ctx);
  for (const result of [statusAlias, waitAlias, selectAlias, eventsAlias]) {
    assert.equal(result.isError, true);
    assert.equal(result.details.error.code, "LARVA_BAD_INPUT");
    assert.match(result.details.error.message, /task_id/);
  }
  recordProof("async_exact_handle_no_alias_constraints", "Async subagent public tools require exact task_id handles and reject last/latest/persona/fuzzy aliases; larva_subagent fresh sessions omit task_id instead of accepting null", "registered schemas/descriptions and runtime execute calls reject alias handles with LARVA_BAD_INPUT", "check:async subagent exact-handle and no-alias constraints remain enforced", "PASS", "runtime registered tools", "real tool execute paths reject aliases; larva_subagent task_id schema has no null");
  return { aliasErrors: [statusAlias, waitAlias, selectAlias, eventsAlias].map((result) => result.details.error.message), larvaSubagentTaskIdSchema: rt.tools.get("larva_subagent").inputSchema.properties.task_id };
});

await check("unsupported live mode is not part of the local proof contract", () => {
  recordProof("unsupported_live_not_required", "Unsupported node ... --live is not required by the downstream local proof path", "offline output records liveModeDisposition.required=false and supported=false", "check:unsupported live mode is not part of the local proof contract", "PASS", "contract disposition", "script only accepts --offline; targeted pytest is the runtime companion proof");
  return { required: false, supported: false, proofPath: ["node scripts/pi-agent-persona-switch-policy-smoke.mjs --offline", "uv run pytest tests/shell/test_pi_extension_real_runtime.py -k \"agent_persona_switch or async_subagent\" -v"] };
});

await check("behavioral proof register is complete and fail-closed", () => {
  const passedRefs = new Set(behavioralProofRegister.filter((row) => row.status === "PASS").map((row) => row.requirement_ref));
  const missing = REQUIRED_REQUIREMENTS.filter((requirement) => !passedRefs.has(requirement));
  assert.deepEqual(missing, []);
  assert.equal(behavioralProofRegister.length >= REQUIRED_REQUIREMENTS.length, true);
  return { required: REQUIRED_REQUIREMENTS.length, observed: behavioralProofRegister.length };
});

const failed = checks.filter((item) => item.status === "FAIL");
const liveModeDisposition = {
  unsupported_live_requirement_removed_or_supported: "unsupported --live is not required; this smoke harness intentionally supports --offline only",
  required: false,
  supported: false,
};
const output = {
  offline,
  status: failed.length === 0 ? "PASS" : "FAIL",
  checks,
  behavioralProofRegister,
  behavioralProofRegisterMarkdown: proofMarkdown(behavioralProofRegister),
  liveModeDisposition,
};
console.log(JSON.stringify(output, null, 2));
if (failed.length > 0) process.exit(1);
