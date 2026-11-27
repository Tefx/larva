import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import larvaExtension from "../../src/pi-extension.ts";
import { parseLarvaConfig } from "../../src/core/config.ts";
import { LarvaError } from "../../src/core/errors.ts";
import { parseModelMapDoc } from "../../src/core/model-map.ts";
import type { ModelMapEntry, SwitchConfirmationChoice, ThinkingLevel } from "../../src/core/types.ts";
import type { PersonaSwitchContext, PersonaSwitchOutcome } from "../../src/runtime/persona-lease.ts";
import { SessionContext, type NativeRoute, type SessionAdapter } from "../../src/runtime/session-context.ts";
import { composeSystemPrompt } from "../../src/runtime/system-prompt.ts";
import { PersonaStore } from "../../src/store/persona-store.ts";

const COMMIT = "larva-active-persona-commit";
const MODE = "larva-agent-persona-switch-mode";
const AUDIT = "larva-agent-persona-switch-audit";
const request = { persona_id: "beta", reason: "Beta owns this task." };
const model = (name: string): ModelMapEntry => ({ provider: "test", model_id: name });
const pair = (name: string, thinking: ThinkingLevel): NativeRoute => ({ model: model(name), thinking });
const entry = (customType: string, data: Record<string, unknown>) => ({ type: "custom", customType, data });
const commit = (id: string | null) => entry(COMMIT, { schema_version: 1, persona_id: id });
const solo = (): ReturnType<NonNullable<PersonaSwitchContext["toolBatch"]>> => ({
  assistantCallIds: ["switch"], activeCallIds: ["switch"], observedCallIds: ["switch"],
});
const ctx: PersonaSwitchContext = { mode: "rpc", toolCallId: "switch", toolBatch: solo };

function failure(result: PersonaSwitchOutcome, code: string): void {
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, code);
}

async function fixture(t: TestContext, { recordRoute, ...options }: Pick<ConstructorParameters<typeof SessionContext>[0], "flags" | "env"> & { recordRoute?: boolean } = {}) {
  const home = await mkdtemp(join(tmpdir(), "larva-session-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const personas = new PersonaStore(home);
  for (const [id, thinking] of [["alpha", "low"], ["beta", "high"], ["gamma", "minimal"]]) {
    await personas.put("-", { stdinText: JSON.stringify({
      id, description: `The ${id} persona`, model: `test/${id}`, prompt: `PRIVATE PROMPT FOR ${id}`, thinking,
    }) });
  }
  let route = pair("native", "off");
  const entries: ReturnType<typeof entry>[] = [];
  const history: unknown[] = [];
  const native = (data: Record<string, unknown>) => { if (recordRoute) history.push({ ...data, id: `entry-${history.length}` }); };
  const events: Parameters<SessionAdapter["report"]>[0][] = [];
  const writes: (string | null)[] = [];
  const loaded: string[] = [];
  const faults = {
    rejectModels: new Set<string>(), rejectThinking: new Set<ThinkingLevel>(),
    ignoreThinking: new Set<ThinkingLevel>(), rejectEntries: new Set<string>(),
  };
  const userRoute = (next: NativeRoute) => { route = next; };
  const adapter: SessionAdapter = {
    readRoute: () => route,
    setModel: next => {
      writes.push(next?.model_id ?? null);
      if (next && faults.rejectModels.has(next.model_id)) return false;
      // Native model changes can select a per-model default or clamp to off.
      const thinking = !next || next.model_id === "worker" ? "off"
        : next.model_id === "manual-model" ? "minimal" : route.thinking;
      if (next) native({ type: "model_change", provider: next.provider, modelId: next.model_id });
      if (thinking !== route.thinking) native({ type: "thinking_level_change", thinkingLevel: thinking });
      route = { model: next, thinking };
      return true;
    },
    setThinking: thinking => {
      writes.push(thinking);
      if (faults.rejectThinking.has(thinking)) throw new Error("Pi rejected thinking");
      if (!faults.ignoreThinking.has(thinking)) {
        const effective = route.model?.model_id === "worker" ? "off" : thinking;
        if (effective !== route.thinking) native({ type: "thinking_level_change", thinkingLevel: effective });
        route = { ...route, thinking: effective };
      }
    },
    appendEntry: (type, data) => {
      if (faults.rejectEntries.has(type)) throw new Error("Append rejected");
      const item = entry(type, data);
      entries.push(item);
      history.push(item);
    },
    report: event => { events.push(event); },
    ...(recordRoute && { readBranch: () => history.slice(), readHistory: () => history.slice() }),
  };
  const session = new SessionContext({
    personas, adapter, ...options,
    loadProfile: async name => {
      loaded.push(name);
      if (name === "alternate") return parseModelMapDoc({ models: {
        "test/alpha": model("alt-alpha"), "test/beta": model("alt-beta"),
      } });
      return undefined;
    },
  });
  return { home, session, personas, adapter, entries, history, events, writes, loaded, userRoute, faults };
}

test("native startup chooses flags, then current branch, then config; reload preserves current authority", async t => {
  const config = parseLarvaConfig({ default_persona: "gamma", switch_mode: "manual" });
  const branch = [commit("gamma"), commit("beta"), entry(MODE, { mode: "auto" })];
  const explicit = await fixture(t, { flags: { persona: "alpha", mode: "free" } });
  await explicit.session.initialize(config, branch);
  assert.deepEqual(explicit.adapter.readRoute(), pair("alpha", "low"));
  assert.equal(explicit.session.activePersona?.id, "alpha");
  assert.equal(explicit.session.switchMode, "free");
  await explicit.session.reload(parseLarvaConfig({ switch_mode: "confirm" }));
  assert.equal(explicit.session.switchMode, "free");
  await explicit.session.setMode("confirm");
  await explicit.session.selectPersona("beta");
  await explicit.session.reload(config);
  assert.equal(explicit.session.switchMode, "confirm");
  assert.equal(explicit.session.activePersona?.id, "beta");

  const restored = await fixture(t);
  await restored.session.initialize(config, branch);
  assert.equal(restored.session.activePersona?.id, "beta");
  assert.equal(restored.session.switchMode, "auto");
  await restored.session.initialize(config, [...branch, commit(null)]);
  assert.deepEqual([restored.session.activePersona], [null]);
  await restored.session.initialize(config);
  assert.equal(restored.session.activePersona?.id, "gamma");
  assert.equal(restored.entries.at(-1)?.customType, COMMIT);
  assert.equal(restored.entries.at(-1)?.data.persona_id, "gamma");
  assert.equal(restored.session.switchMode, "manual");
  await restored.session.initialize(parseLarvaConfig({}));
  assert.equal(restored.session.activePersona, null);
  assert.equal(restored.session.switchMode, "confirm");
});

test("startup and tree restoration preserve independent native overrides only after the selected persona commit", async t => {
  const config = parseLarvaConfig({ default_persona: "gamma" });
  const { session, adapter, writes, userRoute } = await fixture(t);
  const manualModel = { type: "model_change", provider: "test", modelId: "manual-model" };
  const manualThinking = { type: "thinking_level_change", thinkingLevel: "medium" };
  const both = [commit("alpha"), manualModel, manualThinking];
  userRoute(pair("manual-model", "medium"));
  await session.initialize(config, both);
  assert.deepEqual(adapter.readRoute(), pair("manual-model", "medium"));
  assert.deepEqual(writes, [], "do not touch an already restored native pair");
  await session.initialize(config, [...both, commit("beta"), manualModel], "tree");
  assert.deepEqual(adapter.readRoute(), pair("manual-model", "high"));
  await session.initialize(config, [...both, commit("beta"), manualThinking], "tree");
  assert.deepEqual(adapter.readRoute(), pair("beta", "medium"));
  await session.initialize(config, both, "tree");
  assert.deepEqual(adapter.readRoute(), pair("manual-model", "medium"));
  assert.equal(session.activePersona?.id, "alpha");

  const explicit = await fixture(t, { flags: { persona: "gamma" } });
  explicit.userRoute(pair("manual-model", "medium"));
  await explicit.session.initialize(config, both);
  assert.deepEqual(explicit.adapter.readRoute(), pair("gamma", "minimal"));
  await explicit.session.initialize(config, both, "tree");
  assert.equal(explicit.session.activePersona?.id, "alpha");
  assert.deepEqual(explicit.adapter.readRoute(), pair("manual-model", "medium"));
});

test("route attribution survives reopen and tree even at a leaf preceding its attribution entry", async t => {
  const f = await fixture(t, { recordRoute: true });
  const config = parseLarvaConfig({ default_persona: "alpha", switch_mode: "auto" });
  await f.session.initialize(config);
  await f.adapter.setModel(model("chosen"));
  await f.adapter.setThinking("xhigh");
  assert.equal((await f.session.larva_persona_switch(request, ctx)).ok, true);
  const borrowLeaf = f.history.findLastIndex(value => (value as { thinkingLevel?: string }).thinkingLevel === "high");
  assert.ok(borrowLeaf > 0);
  const midBorrow = f.history.slice(0, borrowLeaf + 1);
  await f.session.settleTurn();
  assert.deepEqual(f.adapter.readRoute(), pair("chosen", "xhigh"));
  await f.session.modelMap("alternate");
  assert.deepEqual(f.adapter.readRoute(), pair("alt-alpha", "low"));
  const reopened = new SessionContext({ adapter: f.adapter, personas: f.personas, loadProfile: async () => undefined });
  const completeBranch = f.history.slice();
  await reopened.initialize(config, completeBranch);
  assert.deepEqual(f.adapter.readRoute(), pair("chosen", "xhigh"));
  f.userRoute(pair("beta", "high"));
  await reopened.initialize(config, midBorrow, "tree");
  assert.deepEqual(f.adapter.readRoute(), pair("chosen", "xhigh"));

  await f.session.initialize(config, [commit("beta")], "tree");
  assert.deepEqual(f.adapter.readRoute(), pair("alt-beta", "high"));
  assert.deepEqual(await f.session.modelMap(), { status: "inspect", profile: "alternate", generation: 1 });
});

test("reopening an interrupted borrow from larva:none unwinds its route without overriding Pi CLI selection", async t => {
  const f = await fixture(t, { recordRoute: true });
  const config = parseLarvaConfig({ switch_mode: "auto" });
  await f.session.initialize(config);
  assert.equal((await f.session.larva_persona_switch(request, ctx)).ok, true);
  const transcript = f.history.slice();
  const reopen = () => new SessionContext({ adapter: f.adapter, personas: f.personas, loadProfile: async () => undefined });
  const restored = reopen();
  await restored.initialize(config, transcript);
  assert.equal(restored.activePersona, null);
  assert.deepEqual(f.adapter.readRoute(), pair("native", "off"));
  f.userRoute(pair("explicit-cli-model", "max"));
  await reopen().initialize(config, transcript);
  assert.deepEqual(f.adapter.readRoute(), pair("explicit-cli-model", "max"));
});

test("legacy 0.8 borrow/restore audits do not outrank valid native overrides or modes", async t => {
  const { session, adapter, userRoute } = await fixture(t);
  const config = parseLarvaConfig({ switch_mode: "confirm" });
  const change = (modelId: string) => ({ type: "model_change", provider: "test", modelId });
  const thinking = (thinkingLevel: string) => ({ type: "thinking_level_change", thinkingLevel });
  const lease = { scope: "turn", borrowedPersonaId: "beta", originPersonaId: "alpha", originPiModelCaptured: true };
  const branch = [commit("alpha"), entry(MODE, { mode: "free" }), change("chosen"), thinking("xhigh"),
    { type: "message", message: { role: "assistant" } },
    change("beta"), thinking("high"), entry("larva-tool-declarations", { selected: ["read"], applied: [], known: ["read"] }),
    entry(AUDIT, { source: "tool", committed: true, lease }),
    thinking("low"), entry("larva-tool-declarations", { selected: ["read"], applied: ["read"], known: ["read"] }),
    change("alpha"), thinking("medium"), entry(AUDIT, { source: "runtime", event: "restore", restored: true, lease }),
    { ...change("malformed"), provider: " " }, thinking("ultra"), entry(MODE, { mode: "invalid" })];
  await session.initialize(config, branch);
  assert.equal(session.switchMode, "free");
  assert.deepEqual(adapter.readRoute(), pair("chosen", "xhigh"));
  userRoute(pair("alpha", "low"));
  await session.initialize(config, [...branch, change("new-user-route")], "tree");
  assert.deepEqual(adapter.readRoute(), pair("new-user-route", "xhigh"));
});

test("larva:none tree restoration applies only recorded route components, with or without a null commit", async t => {
  const config = parseLarvaConfig({ default_persona: null });
  const { session, adapter, userRoute, writes, events, faults } = await fixture(t);
  const modelChange = { type: "model_change", provider: "test", modelId: "manual-model" };
  const thinkingChange = { type: "thinking_level_change", thinkingLevel: "medium" };
  const beforeCommit = [{ ...modelChange, modelId: "stale" }, { ...thinkingChange, thinkingLevel: "off" }];
  for (const prefix of [[], [...beforeCommit, commit(null)]]) {
    for (const [overrides, expected] of [
      [[modelChange], pair("manual-model", "high")],
      [[thinkingChange], pair("beta", "medium")],
      [[modelChange, thinkingChange], pair("manual-model", "medium")],
    ] as const) {
      await session.initialize(config, [commit("beta")], "tree");
      assert.deepEqual(adapter.readRoute(), pair("beta", "high"));
      await session.initialize(config, [...prefix, ...overrides], "tree");
      assert.equal(session.activePersona, null);
      assert.deepEqual(adapter.readRoute(), expected);
      assert.deepEqual(events.at(-1)?.data, { persona_id: null, switch_mode: "confirm", warning: undefined });
    }
  }
  const workerChange = { ...modelChange, modelId: "worker" };
  const nullBranch = [commit(null), workerChange];
  const reasoning = pair("beta", "high");
  userRoute(reasoning);
  await session.initialize(config, nullBranch, "tree");
  assert.equal(session.activePersona, null);
  assert.deepEqual(adapter.readRoute(), pair("worker", "off"));
  assert.deepEqual(events.at(-1)?.data, { persona_id: null, switch_mode: "confirm", warning: undefined });

  // An explicitly recorded incompatible level must fail after applying the model;
  // an unavailable model must fail even when no thinking level was recorded.
  faults.rejectModels.add("unavailable");
  for (const branch of [
    [...nullBranch, { ...thinkingChange, thinkingLevel: "high" }],
    [commit(null), { ...workerChange, modelId: "unavailable" }],
  ]) {
    userRoute(reasoning);
    await session.initialize(config, branch, "tree");
    assert.deepEqual(adapter.readRoute(), reasoning);
    assert.equal(session.activePersona, null);
    assert.equal(session.routeUncertain, false);
    assert.match(JSON.stringify(events.at(-1)?.data), /LARVA_MODEL_UNAVAILABLE/);
  }

  // Rejection of the unrecorded level must not undo a successful model restore.
  faults.rejectThinking.add("high");
  userRoute(reasoning);
  await session.initialize(config, [commit(null), modelChange], "tree");
  assert.deepEqual(adapter.readRoute(), pair("manual-model", "minimal"));
  assert.deepEqual(events.at(-1)?.data, { persona_id: null, switch_mode: "confirm", warning: undefined });

  userRoute(pair("cli-model", "max"));
  writes.length = 0;
  await session.initialize(config, [commit(null), modelChange, thinkingChange]);
  assert.deepEqual(adapter.readRoute(), pair("cli-model", "max"), "startup leaves native CLI precedence to Pi");
  assert.deepEqual(writes, []);
});

test("launch mode defeats stale tree entries until explicitly changed, including auto-borrow", async t => {
  const config = parseLarvaConfig({ switch_mode: "free" });
  const stale = [commit("beta"), entry(MODE, { mode: "free" })];
  const { session } = await fixture(t, { flags: { persona: "alpha", mode: "manual" } });
  await session.initialize(config, stale);
  for (const branch of [[], stale]) {
    await session.initialize(config, branch, "tree");
    assert.equal(session.switchMode, "manual");
    assert.equal(session.activePersona?.id ?? null, branch.length ? "beta" : null);
    await session.reload(config);
    assert.equal(session.switchMode, "manual");
  }
  await session.setMode("confirm");
  await session.initialize(config, stale, "tree");
  assert.equal(session.switchMode, "confirm");
  const result = await session.larva_persona_switch({ ...request, persona_id: "alpha" }, { mode: "tui", confirm: d => d.respond("auto_borrow") });
  assert.equal(result.ok, true);
  await session.settleTurn();
  await session.initialize(config, [], "tree");
  await session.reload(config);
  assert.equal(session.switchMode, "auto");
});

test("explicit native persona failures exit 2; branch/config failures warn and degrade without following lower precedence", async t => {
  const config = parseLarvaConfig({ default_persona: "alpha" });
  for (const [id, code] of [["absent", "LARVA_PERSONA_NOT_FOUND"], ["", "LARVA_BAD_INPUT"], ["beta", "LARVA_MODEL_UNAVAILABLE"]]) {
    const { session, faults, userRoute } = await fixture(t, { flags: { persona: id } });
    if (id === "beta") userRoute(pair("beta", "high")); // Native preselection does not prove availability.
    faults.rejectModels.add("beta");
    await assert.rejects(session.initialize(config), error => error instanceof LarvaError && error.code === code && error.exitCode === 2);
  }
  const { session, faults, events, adapter } = await fixture(t);
  faults.rejectModels.add("manual");
  for (const branch of [[commit("absent")], [commit("beta")], [{ ...commit("alpha"), data: null }]]) {
    await session.initialize(config, [...branch, { type: "thinking_level_change", thinkingLevel: "high" },
      { type: "model_change", provider: "test", modelId: "manual" }], "tree");
    assert.equal(session.activePersona, null);
    assert.match(JSON.stringify(events.at(-1)), /using larva:none/);
    assert.deepEqual(adapter.readRoute(), pair("native", "off"));
  }
  await session.initialize(parseLarvaConfig({ default_persona: "absent" }));
  assert.match(JSON.stringify(events.at(-1)), /using larva:none/);
});

test("child fresh/resume uses launch persona/manual mode without touching Pi route", async t => {
  const { session, adapter, writes, entries, faults } = await fixture(t, {
    env: { LARVA_PI_LAUNCHED: "1", LARVA_PI_INITIAL_PERSONA_ID: "alpha" }, flags: { persona: "alpha", mode: "free" },
  });
  faults.rejectModels.add("alpha");
  const config = parseLarvaConfig({ default_persona: "beta", switch_mode: "auto" });
  for (const source of ["startup", "tree"] as const) {
    const branch = [commit(null), entry(MODE, { mode: "confirm" }), { type: "thinking_level_change", thinkingLevel: "high" }];
    await session.initialize(config, branch, source);
    assert.equal(session.activePersona?.id, "alpha");
    assert.equal(session.switchMode, "manual");
  }
  assert.deepEqual(entries.map(({ customType, data }) => [customType, data.persona_id]), [[COMMIT, "alpha"], [COMMIT, "alpha"]]);
  assert.deepEqual(writes, []);
  assert.deepEqual(adapter.readRoute(), pair("native", "off"));
  failure(await session.larva_persona_switch(request, ctx), "LARVA_TOOL_DENIED");
});

test("confirm offers exactly four choices; only approved commits change persona or mode", async t => {
  for (const choice of ["borrow_once", "deny", "auto_borrow", "switch_persistently"] as const) {
    await t.test(choice, async sub => {
      const { session, adapter, entries } = await fixture(sub);
      await session.initialize(parseLarvaConfig({ default_persona: "alpha" }));
      const result = await session.larva_persona_switch({ ...request, continue_task: true }, {
        ...ctx, mode: "tui", confirm: ({ choices, respond }) => {
          assert.deepEqual(choices, [
            { id: "borrow_once", label: "Borrow once" }, { id: "deny", label: "Deny" },
            { id: "auto_borrow", label: "Auto-borrow for this session" }, { id: "switch_persistently", label: "Switch persistently" },
          ]);
          respond(choice);
        },
      });
      if (choice === "deny") {
        failure(result, "LARVA_BAD_INPUT");
        assert.equal(session.activePersona?.id, "alpha");
        assert.deepEqual(adapter.readRoute(), pair("alpha", "low"));
        assert.deepEqual(entries.map(x => x.customType), [COMMIT, AUDIT]);
        assert.equal(entries.at(-1)?.data.status, "deny");
        assert.equal(entries.at(-1)?.data.reason, request.reason);
      } else {
        const persistent = choice === "switch_persistently";
        assert.deepEqual(result, { ok: true, persona_id: "beta", persistent, terminate: true });
        assert.equal(session.activePersona?.id, "beta");
        assert.deepEqual(adapter.readRoute(), pair("beta", "high"));
        assert.deepEqual(entries.map(x => x.customType), [COMMIT, ...(persistent ? [COMMIT] : choice === "auto_borrow" ? [MODE] : []), AUDIT]);
        assert.deepEqual(await session.settleTurn(), { status: "continue", continuation: request });
        assert.equal(session.activePersona?.id, "beta");
        assert.deepEqual(await session.settleTurn(), { status: "settled" });
        assert.equal(session.activePersona?.id, persistent ? "beta" : "alpha");
      }
      assert.equal(session.switchMode, choice === "auto_borrow" ? "auto" : "confirm");
    });
  }
});

test("failed auto-borrow, including rejected mode persistence, never promotes the mode", async t => {
  const { session, faults, adapter, entries } = await fixture(t);
  await session.initialize(parseLarvaConfig({ default_persona: "alpha" }));
  const confirm: PersonaSwitchContext = { mode: "tui", confirm: ({ respond }) => respond("auto_borrow") };
  failure(await session.larva_persona_switch({ ...request, persona_id: "absent" }, confirm), "LARVA_PERSONA_NOT_FOUND");
  faults.rejectThinking.add("high");
  failure(await session.larva_persona_switch(request, confirm), "LARVA_MODEL_UNAVAILABLE");
  faults.rejectThinking.clear();
  faults.rejectEntries.add(MODE);
  failure(await session.larva_persona_switch(request, confirm), "LARVA_INTERNAL_ERROR");
  assert.equal(session.switchMode, "confirm");
  assert.equal(session.activePersona?.id, "alpha");
  assert.deepEqual(adapter.readRoute(), pair("alpha", "low"));
  assert.deepEqual(entries.map(x => x.customType), [COMMIT, AUDIT, AUDIT, AUDIT]);
});

test("timeout, Escape, Ctrl+C and explicit preemption suppress late confirmation callbacks", async t => {
  for (const end of ["timeout", "escape", "interrupt", "preempt"] as const) {
    await t.test(end, async sub => {
      const { session, adapter, entries, writes } = await fixture(sub);
      await session.initialize(parseLarvaConfig({ confirm_timeout_ms: end === "timeout" ? 1000 : 0 }));
      const timer = end === "timeout" ? sub.mock.timers : undefined;
      timer?.enable({ apis: ["setTimeout"] });
      const interruption = new AbortController();
      let respond: ((choice: SwitchConfirmationChoice | null) => void) | undefined;
      let closed: AbortSignal | undefined;
      const pending = session.larva_persona_switch(request, {
        mode: "tui", signal: interruption.signal, confirm: dialog => { respond = dialog.respond; closed = dialog.signal; },
      });
      assert.ok(respond && closed);
      if (end === "timeout") timer?.tick(1000);
      if (end === "escape") respond(null);
      if (end === "interrupt") interruption.abort();
      if (end === "preempt") await session.selectPersona("alpha");
      failure(await pending, "LARVA_BAD_INPUT");
      assert.equal(closed.aborted, true);
      respond("auto_borrow");
      assert.equal(session.switchMode, "confirm");
      assert.equal(session.activePersona?.id ?? null, end === "preempt" ? "alpha" : null);
      assert.deepEqual(adapter.readRoute(), end === "preempt" ? pair("alpha", "low") : pair("native", "off"));
      assert.deepEqual(writes, end === "preempt" ? ["alpha", "low"] : []);
      assert.deepEqual(entries.map(x => x.customType), end === "preempt" ? [COMMIT, AUDIT] : [AUDIT]);
      assert.equal(entries.at(-1)?.data.status, end === "escape" ? "dismissed" : end === "timeout" ? "timeout" : "cancelled");
    });
  }
});

test("confirm is headless-safe; invalid fields and every mixed-batch witness fail before UI or mutation", async t => {
  const { session, writes, entries } = await fixture(t);
  await session.initialize(parseLarvaConfig({}));
  failure(await session.larva_persona_switch(request, ctx), "LARVA_CONFIRMATION_UNAVAILABLE");
  failure(await session.larva_persona_switch(request, { mode: "tui", confirm: async () => { throw new Error("UI detached"); } }), "LARVA_CONFIRMATION_UNAVAILABLE");
  let asked = 0;
  const confirmation: PersonaSwitchContext = { ...ctx, mode: "tui", confirm: () => { asked++; } };
  for (const input of [{ handoff: "retired" }, { max_switches_per_chain: 8 }, { continue_task: null }, { extra: false }]) {
    failure(await session.larva_persona_switch({ ...request, ...input }, confirmation), "LARVA_BAD_INPUT");
  }
  for (const property of ["assistantCallIds", "activeCallIds", "observedCallIds"] as const) {
    const toolBatch = () => ({ ...solo(), [property]: ["switch", "other"] });
    failure(await session.larva_persona_switch({ ...request, continue_task: true }, { ...confirmation, toolBatch }), "LARVA_BAD_INPUT");
  }
  failure(await session.larva_persona_switch({ ...request, continue_task: true }, { ...confirmation, toolBatch: undefined }), "LARVA_BAD_INPUT");
  assert.equal(asked, 0);
  assert.deepEqual(writes, []);
  assert.deepEqual(entries.map(x => x.data.error_code), ["LARVA_CONFIRMATION_UNAVAILABLE", "LARVA_CONFIRMATION_UNAVAILABLE"]);
});

test("confirm rechecks batch evidence after an observed call arrives during the dialog", async t => {
  const { session, writes } = await fixture(t);
  await session.initialize(parseLarvaConfig({}));
  let batch = solo();
  const result = await session.larva_persona_switch({ ...request, continue_task: true }, {
    ...ctx, mode: "tui", toolBatch: () => batch,
    confirm: ({ respond }) => { batch = { ...batch, observedCallIds: ["switch", "another"] }; respond("borrow_once"); },
  });
  failure(result, "LARVA_BAD_INPUT");
  assert.deepEqual(writes, []);
});

test("lease restoration uses the first pre-image and rebases only named origins after a committed profile switch", async t => {
  for (const origin of [null, "alpha"] as const) {
    for (const rebase of [false, true]) {
      await t.test(`${origin ?? "none"}, profile commit: ${rebase}`, async sub => {
        const { session, adapter, userRoute, entries } = await fixture(sub);
        await session.initialize(parseLarvaConfig({ default_persona: origin, switch_mode: "auto" }));
        const native = origin ? pair("ad-hoc", "max") : { model: null, thinking: "off" } as const;
        userRoute(native);
        assert.equal((await session.larva_persona_switch(request, ctx)).ok, true);
        assert.equal((await session.larva_persona_switch({ ...request, persona_id: "gamma" }, ctx)).ok, true);
        userRoute(pair("unrelated", "medium"));
        if (rebase) {
          assert.deepEqual(await session.modelMap("alternate"), { status: "switched", profile: "alternate", generation: 1 });
        }
        assert.deepEqual(await session.settleTurn(), { status: "settled" });
        assert.deepEqual(adapter.readRoute(), origin && rebase ? pair("alt-alpha", "low") : native);
        assert.equal(session.activePersona?.id ?? null, origin);
        assert.deepEqual(entries.filter(x => x.customType !== AUDIT).map(x => x.data.persona_id), origin ? [origin] : []);
        assert.equal(entries.at(-1)?.data.event, "restore");
        assert.equal(entries.at(-1)?.data.status, "restored");
        if (!origin && rebase) {
          await session.selectPersona("beta");
          assert.deepEqual(adapter.readRoute(), pair("alt-beta", "high"));
          await session.modelMap("default");
          assert.deepEqual(adapter.readRoute(), pair("beta", "high"));
        }
      });
    }
  }
});

test("model-map inspection is non-mutating; a rejected pair rolls back without a profile commit", async t => {
  const { session, adapter, faults, loaded, writes, events, userRoute } = await fixture(t);
  await session.initialize(parseLarvaConfig({ default_persona: "alpha" }));
  const initialWrites = [...writes];
  assert.deepEqual(await session.modelMap(), { status: "inspect", profile: "default", generation: 0 });
  assert.deepEqual(loaded, ["default"]);
  assert.deepEqual(writes, initialWrites);
  userRoute(pair("ad-hoc", "max"));
  faults.ignoreThinking.add("low"); // Setter returns normally but Pi did not adopt the target.
  const result = await session.modelMap("alternate");
  assert.equal(result.status, "failed");
  assert.equal(result.generation, 0);
  assert.deepEqual(adapter.readRoute(), pair("ad-hoc", "max"));
  faults.ignoreThinking.clear();
  const after = await session.modelMap("alternate");
  assert.deepEqual(after, { status: "switched", profile: "alternate", generation: 1 });
  assert.deepEqual(events.at(-1), { action: "larva-model-map", data: after });
  assert.deepEqual(adapter.readRoute(), pair("alt-alpha", "low"));
});

test("route_uncertain retains generation, and explicit /model reconciliation does not preempt a lease", async t => {
  const { session, adapter, faults, userRoute } = await fixture(t);
  await session.initialize(parseLarvaConfig({ default_persona: "alpha", switch_mode: "auto" }));
  await session.larva_persona_switch(request, ctx);
  userRoute(pair("beta", "medium"));
  faults.rejectThinking.add("high");
  faults.rejectModels.add("beta");
  const result = await session.modelMap("alternate");
  assert.equal(result.status, "route_uncertain");
  assert.equal(result.generation, 0);
  assert.equal(session.routeUncertain, true);
  await session.initialize(parseLarvaConfig({ switch_mode: "auto" }), [commit("gamma")], "tree");
  assert.equal(session.badge, "🎭 ⚠️ beta (LARVA_ROUTE_UNCERTAIN)");
  failure(await session.larva_persona_switch(request, ctx), "LARVA_ROUTE_UNCERTAIN");
  userRoute(pair("manual-model", "xhigh"));
  await session.reconcileManualModel();
  assert.equal(session.routeUncertain, false);
  assert.deepEqual(await session.settleTurn(), { status: "settled" });
  assert.equal(session.activePersona?.id, "alpha");
  assert.deepEqual(adapter.readRoute(), pair("alpha", "low"));

  userRoute(pair("alpha", "medium"));
  faults.rejectModels.clear();
  faults.rejectModels.add("alpha");
  faults.rejectThinking.add("low");
  assert.equal((await session.modelMap("alternate")).status, "route_uncertain");
  await session.selectPersona("gamma");
  assert.equal(session.routeUncertain, false);
  assert.deepEqual(adapter.readRoute(), pair("gamma", "minimal"));
  assert.deepEqual(await session.modelMap(), { status: "inspect", profile: "default", generation: 0 });
});

test("failed restoration latches on deleted origin or refused route and does not clear on rejected manual selection", async t => {
  for (const cause of ["deleted", "rejected"] as const) {
    await t.test(cause, async sub => {
      const { session, adapter, personas, faults, entries, events } = await fixture(sub);
      await session.initialize(parseLarvaConfig({ default_persona: "alpha", switch_mode: "auto" }));
      await session.larva_persona_switch(request, ctx);
      if (cause === "deleted") await personas.rm(["alpha"]);
      else faults.rejectModels.add("alpha");
      const result = await session.settleTurn();
      assert.equal(result.status, "restore_failed");
      if (result.status === "restore_failed") assert.equal(result.error.code, "LARVA_RESTORE_FAILED");
      assert.equal(entries.at(-1)?.data.error_code, "LARVA_RESTORE_FAILED");
      assert.equal(events.at(-1)?.action, "restore_failed");
      assert.equal(session.activePersona?.id, "beta");
      assert.deepEqual(adapter.readRoute(), pair("beta", "high"));
      failure(await session.larva_persona_switch(request, ctx), "LARVA_RESTORE_FAILED");
      await assert.rejects(session.selectPersona("absent"), { code: "LARVA_PERSONA_NOT_FOUND" });
      assert.equal(session.restoreFailed, true);
      await session.initialize(parseLarvaConfig({ switch_mode: "auto" }), [commit("gamma")], "tree");
      assert.equal(session.badge, "🎭 ⚠️ beta (LARVA_RESTORE_FAILED)");
      await session.selectPersona("gamma");
      assert.equal(session.restoreFailed, false);
      assert.deepEqual(await session.settleTurn(), { status: "settled" });
      assert.equal(session.activePersona?.id, "gamma");
    });
  }
});

test("manual and confirm-persistent selection preempt an existing lease; denied selection does not", async t => {
  const { session, adapter } = await fixture(t);
  await session.initialize(parseLarvaConfig({ default_persona: "alpha", switch_mode: "auto" }));
  await session.larva_persona_switch(request, ctx);
  await session.setMode("confirm");
  const target = { persona_id: "gamma", reason: "Manual or persistent selection" };
  failure(await session.larva_persona_switch(target, { mode: "tui", confirm: d => d.respond("deny") }), "LARVA_BAD_INPUT");
  await session.settleTurn();
  assert.equal(session.activePersona?.id, "alpha");
  for (const source of ["confirm", "manual"]) {
    await session.selectPersona("alpha");
    await session.setMode("auto");
    await session.larva_persona_switch(request, ctx);
    if (source === "manual") await session.selectPersona("gamma");
    else {
      await session.setMode("confirm");
      assert.equal((await session.larva_persona_switch(target, { mode: "tui", confirm: d => d.respond("switch_persistently") })).ok, true);
    }
    await session.settleTurn();
    assert.equal(session.activePersona?.id, "gamma");
    assert.deepEqual(adapter.readRoute(), pair("gamma", "minimal"));
  }
});

function isolateHome(t: TestContext, home: string): void {
  for (const name of ["LARVA_HOME", ...Object.keys(process.env).filter(name => name.startsWith("LARVA_PI_"))]) {
    const prior = process.env[name];
    t.after(() => { if (prior === undefined) delete process.env[name]; else process.env[name] = prior; });
    delete process.env[name];
  }
  process.env.LARVA_HOME = home;
}

test("Pi hooks preserve reload state, replace it on /new, and compose at request time", async t => {
  const { home, personas } = await fixture(t);
  isolateHome(t, home);
  const { spec_digest: _old, ...alpha } = await personas.get("alpha");
  await personas.put("-", { stdinText: JSON.stringify({ ...alpha, tools: { deny: ["write"] } }) });
  await writeFile(join(home, "config.json"), JSON.stringify({ default_persona: "alpha", switch_mode: "auto" }));
  await writeFile(join(home, "model-map.alt.json"), JSON.stringify({ models: { "test/alpha": model("mapped-alpha") } }));
  const statuses = new Map<string, string | undefined>();
  const branch: unknown[] = [];
  let identifier = "original";
  let idle = true;
  let native = { provider: "test", id: "native" };
  let thinking: ThinkingLevel = "off";
  let breakRoute = false;
  const hostContext = {
    mode: "rpc", hasUI: false, isIdle: () => idle, cwd: home, abort: () => assert.fail("Unexpected abort"),
    get model() { return native; }, modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
    ui: { setStatus: (key: string, value?: string) => statuses.set(key, value) },
    sessionManager: { getSessionId: () => identifier, getSessionFile: () => undefined, getBranch: () => branch.slice() },
  } as unknown as ExtensionContext;
  const load = () => {
    const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
    const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
    const tools: ToolDefinition[] = [];
    const events = new EventEmitter();
    let active = ["read", "write"];
    const api = {
      on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
        handlers.set(name, [...handlers.get(name) ?? [], handler]);
      },
      events, registerFlag() {}, getFlag() {}, registerShortcut() {}, registerMessageRenderer() {},
      registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => commands.set(name, command.handler),
      registerTool: (tool: ToolDefinition) => { tools.push(tool); active.push(tool.name); },
      getAllTools: () => [...tools, { name: "read" }, { name: "write" }], getActiveTools: () => active.slice(),
      setActiveTools: (names: string[]) => { active = names.slice(); },
      getThinkingLevel: () => thinking, setThinkingLevel: (value: ThinkingLevel) => { if (!breakRoute) thinking = value; },
      setModel: async (value: typeof native) => {
        if (breakRoute && value.id === native.id.replace(/^mapped-/, "")) return false;
        native = value;
        return true;
      },
      appendEntry: (type: string, data: Record<string, unknown>) => branch.push(entry(type, data)),
    } as unknown as ExtensionAPI;
    larvaExtension(api);
    return {
      async emit(name: string, value: unknown = {}) {
        let result: unknown;
        for (const handler of handlers.get(name) ?? []) result = await handler(value, hostContext) ?? result;
        return result;
      },
      command: (name: string, args: string) => commands.get(name)!(args, hostContext),
      tools: () => api.getActiveTools(), setTools: (names: string[]) => api.setActiveTools(names),
      invokeSwitch: () => tools.find(tool => tool.name === "larva_persona_switch")!.execute("switch", request, undefined, undefined,
        hostContext as Parameters<ToolDefinition["execute"]>[4]),
      resolvePrompt(systemPrompt: string) {
        let result: unknown;
        events.emit("larva:resolve-system-prompt:v1", { scope: "main", systemPrompt, reply: (value: unknown) => { result = value; } });
        return result;
      },
    };
  };
  let pi = load();
  t.after(async () => { await pi.emit("session_shutdown", { reason: "quit" }); });
  assert.deepEqual(pi.resolvePrompt("base"), { status: "unavailable" });
  await pi.emit("session_start", { reason: "startup" });
  assert.equal(statuses.get("larva"), "🎭 alpha");
  assert.equal(statuses.get("larva-subagents"), undefined);
  assert.ok(!pi.tools().includes("write"));
  await pi.invokeSwitch();
  assert.equal(statuses.get("larva"), "🎭 beta ↩ alpha");
  await pi.emit("message_start", { message: { role: "user" } });
  assert.equal(statuses.get("larva"), "🎭 alpha");
  assert.equal(await pi.emit("before_agent_start", { messageType: "user", systemPrompt: "base" }), undefined);
  const head = { role: "system", content: "base", timestamp: 0 };
  const delta = { role: "system", content: "native delta", timestamp: 1 };
  const composed = await pi.emit("context_with_system", { messages: [head, delta] }) as { messages: (typeof head)[] };
  assert.match(composed.messages[0].content, /PRIVATE PROMPT FOR alpha/);
  assert.equal(composed.messages[1], delta);
  assert.deepEqual(pi.resolvePrompt(composed.messages[0].content), { status: "ok", systemPrompt: composed.messages[0].content });
  assert.deepEqual(await pi.emit("before_provider_request", { payload: { context: { messages: [head, delta] } } }), { context: composed });
  assert.deepEqual(await pi.emit("before_provider_request", { payload: { toolConfig: { tools: [{ toolSpec: { name: "larva_subagent" } }] } } }), {});
  assert.deepEqual(await pi.emit("before_provider_request", { payload: { tools: [{ name: "__pi_deferred_placeholder__", defer_loading: true }] } }), {});

  idle = false;
  await pi.command("larva-persona", "beta");
  assert.equal(statuses.get("larva"), "🎭 alpha");
  assert.match(statuses.get("larva-outcome")!, /LARVA_SESSION_BUSY/);
  idle = true;
  thinking = "medium";
  breakRoute = true;
  await pi.command("larva-model-map", "alt");
  assert.equal(statuses.get("larva"), "🎭 ⚠️ alpha (LARVA_ROUTE_UNCERTAIN)");
  const blocked = await pi.emit("tool_call", { toolName: "read" });
  assert.match(JSON.stringify(blocked), /LARVA_ROUTE_UNCERTAIN/);
  branch.push({ id: "native-same-model", type: "model_change", provider: native.provider, modelId: native.id });
  assert.equal(await pi.emit("tool_call", { toolName: "read" }), undefined);
  assert.equal(statuses.get("larva"), "🎭 alpha");
  breakRoute = false;
  await pi.command("larva-model-map", "alt");
  assert.equal(native.id, "mapped-alpha");
  await pi.emit("session_shutdown", { reason: "reload" });
  pi = load();
  await pi.emit("session_start", { reason: "reload" });
  await pi.command("larva-model-map", "");
  assert.match(statuses.get("larva-outcome")!, /"profile":"alt"/);
  assert.equal(native.id, "mapped-alpha");
  await pi.emit("session_shutdown", { reason: "new" });
  branch.length = 0;
  identifier = "replacement";
  pi = load();
  await pi.emit("session_start", { reason: "new" });
  await pi.command("larva-model-map", "");
  assert.match(statuses.get("larva-outcome")!, /"profile":"default","generation":0/);
  assert.equal(native.id, "alpha");
  assert.equal(statuses.get("larva"), "🎭 alpha");

  const branchA = branch.slice(); // 'write' was removed by Larva on this branch.
  branch.splice(0, branch.length, commit("beta"), { type: "message", message: head });
  pi.setTools(["read"]); // Pi's own loadout on B does not include 'write'.
  await pi.emit("session_tree");
  const branchB = branch.slice();
  assert.deepEqual(pi.tools(), ["read"]);
  branch.splice(0, branch.length, ...branchA);
  await pi.emit("session_tree");
  await pi.command("larva-persona", "beta");
  assert.ok(pi.tools().includes("write"));
  branch.splice(0, branch.length, ...branchB);
  pi.setTools(["read"]);
  await pi.emit("session_tree");
  assert.deepEqual(pi.tools(), ["read"]);

  await pi.emit("session_shutdown", { reason: "new" });
  branch.length = 0;
  await writeFile(join(home, "model-map.json"), "{invalid");
  pi = load();
  await pi.emit("session_start", { reason: "new" });
  assert.equal(statuses.get("larva"), "🎭 ⚠️ none (LARVA_MODEL_MAP_INVALID)");
  await pi.command("larva-model-map", "alt");
  await pi.command("larva-persona", "alpha");
  assert.equal(native.id, "mapped-alpha");
  assert.equal(statuses.get("larva"), "🎭 alpha");
});

test("installed Pi executeTool admits callable-only tools but gates them by Persona policy", async t => {
  const { home, personas } = await fixture(t);
  isolateHome(t, home);
  await personas.put("-", { stdinText: JSON.stringify({ id: "alpha", description: "Policy fixture", prompt: "Persona prompt",
    model: "session-fixture/local", thinking: "off", tools: { deny: ["nested-denied"] } }) });
  await writeFile(join(home, "config.json"), JSON.stringify({ default_persona: "alpha" }));
  const agentDir = join(home, "agent");
  await mkdir(agentDir);
  const executed: string[] = [];
  const results: { isError?: boolean; result: { content: unknown } }[] = [];
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({ cwd: home, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [larvaExtension, pi => {
      let turn = 0;
      pi.registerProvider("session-fixture", {
        baseUrl: "http://localhost.invalid", apiKey: "local-fixture-key", api: "session-fixture-stream",
        models: [{ id: "local", name: "Local fixture", reasoning: false, input: ["text"],
          contextWindow: 20_000, maxTokens: 2_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
        streamSimple(model) {
          const first = turn++ === 0;
          const stream = createAssistantMessageEventStream();
          const message: AssistantMessage = { role: "assistant", api: model.api, model: model.id, provider: model.provider,
            content: first ? [{ type: "toolCall", id: "outer-call", name: "outer", arguments: {} }] : [{ type: "text", text: "Done." }],
            stopReason: first ? "toolUse" : "stop", timestamp: Date.now(),
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });
          stream.end();
          return stream;
        },
      });
      for (const [name, exposure] of [["nested-allowed", "codemode"], ["nested-denied", "deferred"]] as const) {
        pi.registerTool({ name, label: name, description: name, exposure, parameters: { type: "object", properties: {} },
          async execute() { executed.push(name); return { content: [{ type: "text", text: name }], details: {} }; } });
      }
      pi.registerTool({ name: "outer", label: "Outer", description: "Run callable-only tools", parameters: { type: "object", properties: {} },
        async execute(_id, _params, _signal, _update, ctx) {
          results.push(await ctx.executeTool("nested-allowed", {}), await ctx.executeTool("nested-denied", {}));
          return { content: [{ type: "text", text: "Nested execution finished." }], details: {} };
        } });
    }],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: home, agentDir, settingsManager, resourceLoader,
    sessionManager: SessionManager.inMemory(home), noTools: "builtin" });
  try {
    await session.bindExtensions({ mode: "rpc" });
    assert.ok(!session.getActiveToolNames().includes("nested-allowed"));
    assert.ok(session.getCallableToolNames().includes("nested-denied"));
    await session.prompt("Call outer.");
    assert.deepEqual(executed, ["nested-allowed"]);
    assert.equal(results.length, 2);
    assert.notEqual(results[0].isError, true);
    assert.equal(results[1].isError, true);
    assert.match(JSON.stringify(results[1].result.content), /LARVA_TOOL_DENIED/);
  } finally { session.dispose(); }
});

test("same-persona switch performs no route, audit, confirmation, or continuation work", async t => {
  const { session, entries, writes } = await fixture(t);
  await session.initialize(parseLarvaConfig({ default_persona: "alpha" }));
  const initial = { entries: entries.slice(), writes: writes.slice() };
  assert.deepEqual(await session.larva_persona_switch({ ...request, persona_id: "alpha", continue_task: true }, ctx),
    { ok: true, persona_id: "alpha", persistent: true });
  assert.deepEqual({ entries, writes }, initial);
  assert.deepEqual(await session.settleTurn(), { status: "settled" });
});

test("free persists and the autonomous chain is capped at eight across continuation turns", async t => {
  const { session, entries } = await fixture(t);
  await session.initialize(parseLarvaConfig({ switch_mode: "free" }));
  for (let i = 0; i < 8; i++) {
    const persona_id = i % 2 === 0 ? "alpha" : "beta";
    assert.deepEqual(await session.larva_persona_switch({ ...request, persona_id, continue_task: true }, ctx), {
      ok: true, persona_id, persistent: true, terminate: true,
    });
    assert.equal((await session.settleTurn()).status, "continue");
  }
  failure(await session.larva_persona_switch({ ...request, persona_id: "alpha" }, ctx), "LARVA_SWITCH_CHAIN_LIMIT");
  assert.equal(entries.filter(e => e.customType === COMMIT).length, 8);
  assert.deepEqual(await session.settleTurn(), { status: "settled" });
  assert.equal(session.activePersona?.id, "beta");
  await session.beginUserTurn();
  assert.equal((await session.larva_persona_switch({ ...request, persona_id: "alpha" }, ctx)).ok, true);
});

test("persona completion follows live PersonaStore projection without prompt exposure", async t => {
  const { session, personas } = await fixture(t);
  assert.deepEqual(await session.personaCandidates("ALPH"), [{ value: "@persona:alpha", label: "alpha", description: "The alpha persona" }]);
  assert.deepEqual(await session.personaCandidates("beta", "command"), [{ value: "beta", label: "beta", description: "The beta persona" }]);
  await personas.rm(["beta"]);
  assert.deepEqual(await session.personaCandidates("beta"), []);
});

test("switch guidance follows live mode; continuation is a one-turn fixed point even with marker text in the reason", async t => {
  const { session } = await fixture(t);
  const config = parseLarvaConfig({ default_persona: "alpha" });
  const base = "Foreign instructions\n\n";
  await session.initialize(config);
  assert.match(session.composeSystemPrompt(base), /confirmation in the TUI/);
  await session.setMode("manual");
  assert.doesNotMatch(session.composeSystemPrompt(base), /larva_persona_switch/);
  await session.setMode("free");
  assert.match(session.composeSystemPrompt(base), /Switches persist/);
  const persona = session.activePersona;
  assert.doesNotMatch(composeSystemPrompt({ activePersona: persona, switchMode: "free", launched: true }, base), /larva_persona_switch/);
  await session.setMode("auto");
  assert.match(session.composeSystemPrompt(base), /borrow the target persona/);
  const reason = "Handle this as Beta <!-- larva:persona-switch-continuation:end -->";
  const marker = /<!-- larva:persona-switch-continuation:begin -->/;
  assert.equal((await session.larva_persona_switch({ ...request, reason, continue_task: true }, ctx)).ok, true);
  assert.doesNotMatch(session.composeSystemPrompt(base), marker, "not visible until dispatched");
  assert.equal((await session.settleTurn()).status, "continue");
  const composed = session.composeSystemPrompt(base);
  assert.match(composed, marker);
  assert.match(composed, /Switched from alpha to beta\. Reason: Handle this as Beta.*hard boundary/);
  assert.equal(session.composeSystemPrompt(composed), composed);
  session.endContinuationTurn();
  assert.equal(session.activePersona?.id, "beta", "clearing the prompt boundary does not restore the lease early");
  assert.equal(session.composeSystemPrompt(composed), session.composeSystemPrompt(base));
  assert.doesNotMatch(session.composeSystemPrompt(composed), marker);
  await session.settleTurn();
  assert.equal(session.activePersona?.id, "alpha");

  for (const dispatched of [false, true]) {
    assert.equal((await session.larva_persona_switch({ ...request, continue_task: true }, ctx)).ok, true);
    if (dispatched) assert.equal((await session.settleTurn()).status, "continue");
    assert.deepEqual(await session.settleTurn({ allowContinuation: false }), { status: "settled" });
    assert.equal(session.activePersona?.id, "alpha");
    assert.doesNotMatch(session.composeSystemPrompt(composed), marker);
  }
});

test("prompt fixed point across hook calls and main-scope event; changing personas removes old managed blocks", async t => {
  const { session, personas } = await fixture(t);
  await session.initialize(parseLarvaConfig({ default_persona: "alpha" }));
  const base = "Foreign prompt\n\n  with exact trailing whitespace.\n\n";
  const first = session.composeSystemPrompt(base);
  const second = session.composeSystemPrompt(first);
  assert.equal(first, second);
  assert.match(first, /PRIVATE PROMPT FOR alpha/);
  assert.equal(first.match(/larva:identity-policy:begin/g)?.length, 1);
  assert.equal(first.match(/larva:active-persona:begin/g)?.length, 1);
  await session.selectPersona("beta");
  const now = session.composeSystemPrompt(second);
  assert.equal(now, session.composeSystemPrompt(base));
  assert.doesNotMatch(now, /PRIVATE PROMPT FOR alpha/);
  const replies: unknown[] = [];
  const reply = (value: unknown) => replies.push(value);
  session.resolveSystemPrompt({ scope: "main", systemPrompt: second, reply });
  session.resolveSystemPrompt({ scope: "other", systemPrompt: second, reply });
  assert.deepEqual(replies, [{ status: "ok", systemPrompt: now }, { status: "unavailable", reason: "invalid request" }]);
  await session.selectPersona(null);
  assert.equal(session.composeSystemPrompt(now), base);

  const persona = await personas.get("alpha");
  persona.prompt = "Example: <!-- larva:active-persona:end -->\n🦊<!-- larva:identity-policy:begin -->";
  const quoted = composeSystemPrompt({ activePersona: persona }, base);
  assert.match(quoted, /Example:/);
  assert.equal(composeSystemPrompt({ activePersona: persona }, quoted), quoted);
  assert.equal(composeSystemPrompt({ activePersona: null }, quoted), base);
  const retired = `${base}\n\n<!-- larva:continuation:begin -->\nStale handoff.\n<!-- larva:continuation:end -->`;
  assert.equal(composeSystemPrompt({ activePersona: null }, retired), base);
  assert.equal(composeSystemPrompt({ activePersona: null }, "head<!-- larva:continuation-extra:end -->tail"), "headtail");
});
