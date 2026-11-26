import assert from "node:assert/strict";
import { readFile, unlink } from "node:fs/promises";
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
  const { sessionFile } = await seeded.rpc("get_state");
  assert.equal((await seeded.close()).code, 0);

  const restored = f.pi(["--session", sessionFile]);
  assert.deepEqual(await restored.outcome(0, "startup"), identity("leaf", "free"));
  assert.deepEqual(await restored.route(), ["fixture", "leaf", "off"]);
  assert.equal((await restored.close()).code, 0);
  const override = f.pi(["--session", sessionFile, "--larva-persona", "worker", "--larva-mode", "confirm"]);
  assert.deepEqual(await override.outcome(0, "startup"), identity("worker", "confirm"));
  assert.equal((await override.close()).code, 0);

  await unlink(f.personaFile("parent"));
  const degraded = f.pi(["--thinking", "off"]);
  const { warning, ...actual } = await degraded.outcome(0, "startup");
  assert.deepEqual(actual, identity(null, "manual"));
  assert.equal(warning.code, "LARVA_PERSONA_NOT_FOUND");
  assert.deepEqual(await degraded.route(), ["fixture", "native", "off"]);
}));

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
  assert.deepEqual(await pi.route(), ["fixture", "worker", "off"]);
  assert.equal((await pi.command("/larva-model-map mapped")).status, "switched");
  assert.deepEqual(await pi.route(), ["fixture", "mapped-worker", "off"]);
  continuation.reply("Done borrowing");
  await pi.settled(from);
  assert.deepEqual(await pi.command("/larva-persona"), { persona_id: null });
  assert.deepEqual(await pi.route(), native);
  assert.deepEqual(await pi.command("/larva-model-map"), { status: "inspect", profile: "mapped", generation: 1 });
  await pi.command("/larva-persona worker");
  assert.deepEqual(await pi.route(), ["fixture", "mapped-worker", "off"]);
}));
