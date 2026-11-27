import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
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

async function fixture(t: TestContext, options: Pick<ConstructorParameters<typeof SessionContext>[0], "flags" | "env"> = {}) {
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
      route = { model: next, thinking };
      return true;
    },
    setThinking: thinking => {
      writes.push(thinking);
      if (faults.rejectThinking.has(thinking)) throw new Error("Pi rejected thinking");
      if (!faults.ignoreThinking.has(thinking)) route = { ...route, thinking: route.model?.model_id === "worker" ? "off" : thinking };
    },
    appendEntry: (type, data) => {
      if (faults.rejectEntries.has(type)) throw new Error("Append rejected");
      entries.push(entry(type, data));
    },
    report: event => { events.push(event); },
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
  return { session, personas, adapter, entries, events, writes, loaded, userRoute, faults };
}

test("native startup chooses flags, then current branch, then config; reload preserves current authority", async t => {
  const config = parseLarvaConfig({ default_persona: "gamma", switch_mode: "manual" });
  const branch = [commit("gamma"), commit("beta"), entry(MODE, { mode: "auto" })];
  const explicit = await fixture(t, { flags: { persona: "alpha", mode: "free" } });
  assert.deepEqual(await explicit.session.initialize(config, branch), { applyModel: true });
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
      assert.deepEqual(await session.initialize(config, [...prefix, ...overrides], "tree"), { applyModel: true });
      assert.equal(session.activePersona, null);
      assert.deepEqual(adapter.readRoute(), expected);
      assert.deepEqual(events.at(-1)?.data, { persona_id: null, switch_mode: "confirm", warning: undefined });
    }
  }
  const workerChange = { ...modelChange, modelId: "worker" };
  const nullBranch = [commit(null), workerChange];
  const reasoning = pair("beta", "high");
  userRoute(reasoning);
  assert.deepEqual(await session.initialize(config, nullBranch, "tree"), { applyModel: true });
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
    assert.deepEqual(await session.initialize(config, branch, "tree"), { applyModel: false });
    assert.deepEqual(adapter.readRoute(), reasoning);
    assert.equal(session.activePersona, null);
    assert.equal(session.routeUncertain, false);
    assert.match(JSON.stringify(events.at(-1)?.data), /LARVA_MODEL_UNAVAILABLE/);
  }

  // Rejection of the unrecorded level must not undo a successful model restore.
  faults.rejectThinking.add("high");
  userRoute(reasoning);
  assert.deepEqual(await session.initialize(config, [commit(null), modelChange], "tree"), { applyModel: true });
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
    assert.deepEqual(await session.initialize(config, [...branch, { type: "thinking_level_change", thinkingLevel: "high" },
      { type: "model_change", provider: "test", modelId: "manual" }], "tree"), { applyModel: false });
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
    assert.deepEqual(await session.initialize(config, branch, source), { applyModel: false });
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
        assert.deepEqual(entries, []);
      } else {
        const persistent = choice === "switch_persistently";
        assert.deepEqual(result, { ok: true, persona_id: "beta", persistent, terminate: true });
        assert.equal(session.activePersona?.id, "beta");
        assert.deepEqual(adapter.readRoute(), pair("beta", "high"));
        assert.deepEqual(entries.map(x => x.customType), [...(persistent ? [COMMIT] : choice === "auto_borrow" ? [MODE] : []), AUDIT]);
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
  assert.deepEqual(entries, []);
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
      assert.deepEqual(entries.map(x => x.customType), end === "preempt" ? [COMMIT] : []);
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
  assert.deepEqual(entries, []);
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
        assert.ok(entries.every(x => x.customType === AUDIT));
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
});
