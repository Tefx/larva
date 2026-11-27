import assert from "node:assert/strict";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fixture, tool } from "./fixture.ts";

const identity = (persona_id: string | null, switch_mode: string) => ({ persona_id, switch_mode });
const switchTool = (persona_id: string, continue_task = true) => tool("larva_persona_switch", {
  persona_id, reason: "Exercise the native persona transition", continue_task,
});

test("Pi RPC startup: explicit flags, restored branch, config, and fail-closed identity", { timeout: 30_000 }, () => fixture(async f => {
  await f.config({ default_persona: "parent", switch_mode: "manual" });
  for (const [args, code] of [
    [["--larva-persona", "missing"], "LARVA_PERSONA_NOT_FOUND"],
    [["--larva-persona", "NOT-VALID"], "LARVA_BAD_INPUT"],
    [["--larva-mode", "not-a-mode"], "LARVA_BAD_INPUT"],
  ] as const) {
    const before = f.requests.length;
    const pi = f.pi([...args]);
    pi.send({ type: "prompt", id: "must-not-run", message: "startup must reject" });
    const exit = await pi.exited();
    assert.equal(exit.code, 2, exit.stderr);
    assert.match(exit.stderr, new RegExp(code));
    assert.ok(!pi.frames.some(e => e.type === "agent_start"));
    assert.equal(f.requests.length, before);
  }

  const defaults = f.pi();
  assert.deepEqual(await defaults.outcome(0, "startup"), identity("parent", "manual"));
  assert.deepEqual(await defaults.route(), ["fixture", "parent", "low"]);
  assert.equal((await defaults.close()).code, 0);

  const seeded = f.pi(["--larva-persona", "worker", "--larva-mode", "auto"]);
  assert.deepEqual(await seeded.outcome(0, "startup"), identity("worker", "auto"));
  assert.deepEqual(await seeded.reload(), identity("worker", "auto"));
  assert.deepEqual(await seeded.command("/larva-mode free"), { mode: "free" });
  assert.deepEqual(await seeded.command("/larva-persona leaf"), { persona_id: "leaf" });
  const seed = await seeded.prompt("save the selected branch");
  (await f.provider(0, "save the selected branch")).reply("Branch saved");
  await seeded.settled(seed);
  // RPC uses the same native setters and writes the same entries as /model and thinking changes.
  await seeded.rpc("set_model", { provider: "fixture", modelId: "native" });
  await seeded.rpc("set_thinking_level", { level: "high" });
  assert.deepEqual(await seeded.route(), ["fixture", "native", "high"]);
  const { sessionFile } = await seeded.rpc("get_state");
  assert.equal((await seeded.close()).code, 0);
  const history = (await readFile(sessionFile, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line));
  const commit = history.findLastIndex(entry => entry.customType === "larva-active-persona-commit");
  assert.ok(commit > 0);
  assert.ok(history.slice(commit + 1).some(entry => entry.type === "model_change" && entry.modelId === "native"));
  assert.ok(history.slice(commit + 1).some(entry => entry.type === "thinking_level_change" && entry.thinkingLevel === "high"));

  const restored = f.pi(["--session", sessionFile]);
  assert.deepEqual(await restored.outcome(0, "startup"), identity("leaf", "free"));
  assert.deepEqual(await restored.route(), ["fixture", "native", "high"]);
  assert.equal((await restored.close()).code, 0);
  const override = f.pi(["--session", sessionFile, "--larva-persona", "worker", "--larva-mode", "confirm"]);
  assert.deepEqual(await override.outcome(0, "startup"), identity("worker", "confirm"));
  assert.deepEqual(await override.route(), ["fixture", "worker", "off"]);
  assert.equal((await override.close()).code, 0);

  await unlink(f.personaFile("parent"));
  const degraded = f.pi(["--thinking", "off"]);
  const { warning, ...actual } = await degraded.outcome(0, "startup");
  assert.deepEqual(actual, identity(null, "manual"));
  assert.equal(warning.code, "LARVA_PERSONA_NOT_FOUND");
  assert.deepEqual(await degraded.route(), ["fixture", "native", "off"]);
}));

test("Pi RPC tree restores larva:none route overrides and retains explicit launch mode across reload", { timeout: 30_000 }, () => fixture(async f => {
  await f.config({ default_persona: null, switch_mode: "free" });
  const catalog = JSON.parse(await readFile(f.modelCatalog, "utf8"));
  const models = catalog.providers.fixture.models;
  const worker = models.find((model: { id: string }) => model.id === "worker");
  worker.reasoning = false;
  const leafModel = models.find((model: { id: string }) => model.id === "leaf");
  models.push({ ...leafModel, id: "retired", name: "retired" });
  await writeFile(f.modelCatalog, JSON.stringify(catalog));
  const settingsPath = join(dirname(f.modelCatalog), "settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  await writeFile(settingsPath, JSON.stringify({ ...settings, modelThinkingLevels: { "fixture/leaf": "minimal" } }));
  const driver = join(f.host, "tree.mjs");
  await writeFile(driver, `export default pi => {
    const report = (ctx, data) => ctx.ui.setStatus('fixture-tree', JSON.stringify({
      leaf: ctx.sessionManager.getLeafId(), switchVisible: pi.getActiveTools().includes('larva_persona_switch'),
      branch: ctx.sessionManager.getBranch().map(({ id, type, customType, modelId, thinkingLevel }) => ({ id, type, customType, modelId, thinkingLevel })), ...data,
    }));
    pi.registerCommand('fixture-mark', { handler: (_, ctx) => { pi.appendEntry('fixture-marker'); report(ctx); } });
    pi.registerCommand('fixture-tools', { handler: (_, ctx) => report(ctx) });
    pi.registerCommand('reload', { handler: (_, ctx) => ctx.reload() });
    pi.registerCommand('fixture-none', { handler: () => pi.appendEntry('larva-active-persona-commit', {
      schema_version: 1, persona_id: null, spec_digest: null, source: 'user',
    }) });
    pi.registerCommand('fixture-nav', { handler: async (id, ctx) => report(ctx, await ctx.navigateTree(id)) });
  };`);
  let pi = f.pi(["-e", driver, "--larva-mode", "manual", "--thinking", "off"]);
  assert.deepEqual(await pi.outcome(0, "startup"), identity(null, "manual"));
  const project = async (text: string) => {
    const from = await pi.prompt(text, "handled");
    const frame = await pi.frame(from, "extension_ui_request", e => e.statusKey === "fixture-tree");
    return JSON.parse(frame.statusText);
  };
  const mark = async (): Promise<string> => {
    const { leaf } = await project("/fixture-mark");
    assert.equal(typeof leaf, "string");
    return leaf;
  };
  const navigate = async (id: string, visible = false) => {
    const { cancelled, switchVisible } = await project(`/fixture-nav ${id}`);
    assert.equal(cancelled, false);
    assert.equal(switchVisible, visible, "active tools immediately after navigation");
  };
  const root = await mark();
  await pi.prompt("/fixture-none", "handled");
  await pi.rpc("set_model", { provider: "fixture", modelId: "retired" });
  const { branch: retiredBranch } = await project("/fixture-mark");
  const retiredIndex = retiredBranch.findLastIndex((e: { modelId?: string }) => e.modelId === "retired");
  assert.equal(retiredBranch[retiredIndex - 1]?.customType, "larva-active-persona-commit");
  const retired = retiredBranch[retiredIndex].id;
  await navigate(root);
  // Add a stale persisted entry without changing the launch-mode authority of the test process.
  await pi.command("/larva-mode free");
  await pi.command("/larva-persona parent");
  const named = await mark();
  const saved = await pi.prompt("Persist the named branch and its mode entry");
  (await f.provider(0, "Persist the named branch")).reply("Named branch saved");
  await pi.settled(saved);
  const { sessionFile } = await pi.rpc("get_state");
  assert.equal((await pi.close()).code, 0);

  models.pop(); // The transcript still records a model that Pi can no longer select.
  await writeFile(f.modelCatalog, JSON.stringify(catalog));
  pi = f.pi(["-e", driver, "--session", sessionFile, "--larva-mode", "manual"]);
  assert.deepEqual(await pi.outcome(0, "startup"), identity("parent", "manual"));
  for (const committed of [true, false]) {
    for (const variation of ["model", "thinking", "both"]) {
      await navigate(root);
      if (committed) await pi.prompt("/fixture-none", "handled");
      if (variation !== "thinking") {
        await pi.rpc("set_model", { provider: "fixture", modelId: "leaf" });
        assert.deepEqual(await pi.route(), ["fixture", "leaf", "minimal"], "native model selection uses the saved per-model default");
      }
      const recordedThinking = variation === "both" ? "low" : "high";
      if (variation !== "model") await pi.rpc("set_thinking_level", { level: recordedThinking });
      const { leaf, branch } = await project("/fixture-mark");
      // Native set_model can append a thinking change too; target the model
      // entry itself to exercise the branch with just the model override.
      const target = variation === "model" ? branch.findLast((e: { type: string }) => e.type === "model_change")?.id : leaf;
      assert.equal(typeof target, "string");
      const selected = branch.slice(0, branch.findIndex((e: { id: string }) => e.id === target) + 1);
      const commit = selected.findLastIndex((e: { customType?: string }) => e.customType === "larva-active-persona-commit");
      assert.equal(commit !== -1, committed);
      if (committed) {
        const routeChanges = selected.slice(commit + 1).filter((e: { type: string }) => e.type !== "custom")
          .map((e: { type: string; thinkingLevel?: string }) => e.type === "thinking_level_change" ? e.thinkingLevel : e.type);
        assert.deepEqual(routeChanges, variation === "model" ? ["model_change"]
          : variation === "thinking" ? [recordedThinking] : ["model_change", "minimal", recordedThinking]);
      }
      await navigate(named);
      await pi.rpc("set_thinking_level", { level: "high" });
      assert.deepEqual(await pi.route(), ["fixture", "parent", "high"]);
      const from = pi.frames.length;
      await navigate(target);
      assert.deepEqual(await pi.outcome(from, "startup"), identity(null, "manual"), "navigation reports no warning");
      // Without a persona commit, Pi's initial native route entries also belong to this branch.
      assert.deepEqual(await pi.route(), ["fixture", variation === "thinking" ? (committed ? "parent" : "native") : "leaf",
        variation === "model" ? (committed ? "high" : "off") : recordedThinking], `${committed ? "null commit" : "no commit"}, ${variation}`);
      assert.deepEqual(await pi.command("/larva-mode"), { mode: "manual" });
    }
  }
  await navigate(root);
  await pi.prompt("/fixture-none", "handled");
  await pi.rpc("set_model", { provider: "fixture", modelId: "worker" });
  const { branch } = await project("/fixture-mark");
  const modelIndex = branch.findLastIndex((e: { modelId?: string }) => e.modelId === "worker");
  assert.equal(branch[modelIndex - 1]?.customType, "larva-active-persona-commit", "model is the sole native override after the null commit");
  for (const target of [branch[modelIndex].id, retired]) {
    await navigate(named);
    await pi.rpc("set_thinking_level", { level: "high" });
    const before = ["fixture", "parent", "high"];
    assert.deepEqual(await pi.route(), before);
    const from = pi.frames.length;
    await navigate(target);
    const { warning, ...actual } = await pi.outcome(from, "startup");
    assert.deepEqual(actual, identity(null, "manual"));
    if (target === retired) assert.equal(warning?.code, "LARVA_MODEL_UNAVAILABLE");
    else assert.equal(warning, undefined);
    assert.deepEqual(await pi.route(), target === retired ? before : ["fixture", "worker", "off"]);
  }

  await navigate(named);
  assert.deepEqual(await pi.reload(), identity("parent", "manual"));
  assert.equal((await project("/fixture-tools")).switchVisible, false);
  assert.deepEqual(await pi.command("/larva-mode auto"), { mode: "auto" });
  await navigate(root, true);
  await navigate(named, true);
  assert.deepEqual(await pi.reload(), identity("parent", "auto"));
  assert.equal((await project("/fixture-tools")).switchVisible, true);

  await navigate(root, true);
  await pi.prompt("/fixture-none", "handled");
  await pi.rpc("set_model", { provider: "fixture", modelId: "leaf" });
  await pi.rpc("set_thinking_level", { level: "high" });
  const native = await pi.prompt("Persist the larva:none branch");
  (await f.provider(1, "Persist the larva:none branch")).reply("Native branch saved");
  await pi.settled(native);
  assert.deepEqual(await pi.route(), ["fixture", "leaf", "high"]);
  assert.equal((await pi.close()).code, 0);
  const cli = f.pi(["--session", sessionFile, "--model", "fixture/leaf", "--thinking", "minimal"]);
  assert.deepEqual(await cli.outcome(0, "startup"), identity(null, "free"));
  assert.deepEqual(await cli.route(), ["fixture", "leaf", "minimal"], "native startup keeps both CLI overrides");
}, { modelsOnly: true }));

test("Pi RPC PersonaLease: headless confirm, mixed batch rejection, named rebase, failure latch and free commit", { timeout: 30_000 }, () => fixture(async f => {
  const pi = f.pi(["--larva-persona", "parent", "--larva-mode", "confirm"]);
  const offer = async (label: string, ...calls: ReturnType<typeof tool>[]) => {
    const requests = f.requests.length;
    const from = await pi.prompt(label);
    (await f.provider(requests, label)).reply(calls);
    return { from, requests };
  };
  const observeRejection = async (label: string, code: string, ...calls: ReturnType<typeof tool>[]) => {
    const { from, requests } = await offer(label, ...calls);
    assert.equal((await pi.toolResult(from, "larva_persona_switch")).error.code, code);
    const follow = await f.provider(requests + 1, "");
    assert.ok(JSON.stringify(follow.payload.messages).includes(code));
    follow.reply("Rejected without switching");
    await pi.settled(from);
    return follow.payload.model;
  };
  assert.equal(await observeRejection("borrow requires UI", "LARVA_CONFIRMATION_UNAVAILABLE", switchTool("worker")), "parent");
  assert.equal(await observeRejection("mixed in confirm", "LARVA_BAD_INPUT", switchTool("worker"), tool("larva_personas", {})), "parent");
  assert.deepEqual(await pi.route(), ["fixture", "parent", "low"]);
  await pi.command("/larva-mode auto");

  const rebased = await offer("borrow and rebase named origin", switchTool("worker"));
  assert.equal((await pi.toolResult(rebased.from, "larva_persona_switch")).persistent, false);
  const continuation = await f.provider(rebased.requests + 1, "worker");
  assert.equal(continuation.payload.model, "worker");
  assert.match(JSON.stringify(continuation.payload.messages[0]), /E2E identity worker/);
  assert.equal((await pi.command("/larva-model-map mapped")).status, "switched");
  assert.deepEqual(await pi.route(), ["fixture", "mapped-worker", "off"]);
  continuation.reply("Finish the borrowed turn");
  await pi.settled(rebased.from);
  assert.deepEqual(await pi.command("/larva-persona"), { persona_id: "parent" });
  assert.deepEqual(await pi.route(), ["fixture", "mapped-parent", "low"]);

  const fails = await offer("borrow while origin disappears", switchTool("worker"));
  const held = await f.provider(fails.requests + 1, "worker");
  await unlink(f.personaFile("parent"));
  held.reply("Finish with missing origin");
  await pi.settled(fails.from);
  assert.equal((await pi.outcome(fails.from, "restore_failed")).code, "LARVA_RESTORE_FAILED");
  assert.deepEqual(await pi.command("/larva-persona"), { persona_id: "worker" });
  assert.equal(await observeRejection("blocked by failure latch", "LARVA_RESTORE_FAILED", switchTool("leaf")), "mapped-worker");

  await pi.command("/larva-persona worker");
  await pi.command("/larva-mode free");
  const free = await offer("persistent switch", switchTool("leaf"));
  assert.equal((await pi.toolResult(free.from, "larva_persona_switch")).persistent, true);
  const final = await f.provider(free.requests + 1, "leaf");
  assert.equal(final.payload.model, "leaf");
  final.reply("Persistent continuation");
  await pi.settled(free.from);
  assert.deepEqual(await pi.command("/larva-persona"), { persona_id: "leaf" });
  const { sessionFile } = await pi.rpc("get_state");
  const commits = (await readFile(sessionFile, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line))
    .filter(entry => entry.customType === "larva-active-persona-commit").map(entry => entry.data.persona_id);
  assert.deepEqual(commits, ["parent", "worker", "leaf"], "only startup, manual recovery and free switch persist");
}));

test("Pi RPC PersonaLease restores the exact native route for a null origin despite a profile switch", { timeout: 20_000 }, () => fixture(async f => {
  const pi = f.pi(["--larva-mode", "auto", "--thinking", "high"]);
  assert.deepEqual(await pi.outcome(0, "startup"), identity(null, "auto"));
  const native = ["fixture", "native", "high"];
  assert.deepEqual(await pi.route(), native);
  const from = await pi.prompt("borrow from native route");
  (await f.provider(0, "borrow from native route")).reply([switchTool("worker")]);
  const continuation = await f.provider(1, "worker");
  assert.match(JSON.stringify(continuation.payload.messages[0]), /Switched from larva:none to worker.*hard boundary/);
  assert.deepEqual(await pi.route(), ["fixture", "worker", "off"]);
  assert.equal((await pi.command("/larva-model-map mapped")).status, "switched");
  assert.deepEqual(await pi.route(), ["fixture", "mapped-worker", "off"]);
  continuation.reply([tool("larva_personas", {})]);
  const next = await f.provider(2, "");
  assert.equal(next.payload.model, "mapped-worker");
  assert.match(JSON.stringify(next.payload.messages[0]), /E2E identity worker/);
  assert.doesNotMatch(JSON.stringify(next.payload.messages[0]), /larva:persona-switch-continuation/);
  next.reply("Done borrowing");
  await pi.settled(from);
  assert.deepEqual(await pi.command("/larva-persona"), { persona_id: null });
  assert.deepEqual(await pi.route(), native);
  assert.deepEqual(await pi.command("/larva-model-map"), { status: "inspect", profile: "mapped", generation: 1 });
  await pi.command("/larva-persona worker");
  assert.deepEqual(await pi.route(), ["fixture", "mapped-worker", "off"]);
}));
