import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const root = process.cwd();
const extensionUrl = pathToFileURL(join(root, "contrib/pi-extension/larva.ts"));

async function importFresh(name) {
  return await import(`${extensionUrl.href}?personaspec=${encodeURIComponent(name)}-${Date.now()}-${Math.random()}`);
}

async function makeFakeCli(dir) {
  const cli = join(dir, "fake-larva-cli.mjs");
  await writeFile(cli, `
const [, , command, personaId, jsonFlag] = process.argv;
if (command !== "resolve" || jsonFlag !== "--json") process.exit(3);
const spec = {
  id: personaId,
  description: "Persona " + personaId,
  prompt: "Prompt for " + personaId,
  model: "provider/model",
  capabilities: {},
  spec_version: "0.1.0"
};
if (personaId === "missing-description") delete spec.description;
if (personaId === "bad-spec-version") spec.spec_version = "0.2.0";
if (personaId === "bad-posture") spec.capabilities = { filesystem: "admin" };
if (personaId === "legacy-tools") spec.tools = ["read"];
if (personaId === "legacy-side-effect-policy") spec.side_effect_policy = { filesystem: "read_only" };
if (personaId === "legacy-variables") spec.variables = { name: "value" };
if (personaId === "legacy-variant") spec.variant = "default";
if (personaId === "legacy-registry") spec._registry = { active: true };
if (personaId === "legacy-active") spec.active = true;
if (personaId === "extra-key") spec.unexpected = "reject";
process.stdout.write(JSON.stringify({ data: spec }));
`, "utf8");
  return cli;
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), "larva-pi-personaspec-fail-closed-"));
  const cli = await makeFakeCli(dir);
  const mod = await importFresh("canonical-personaspec");
  const calls = [];
  const statuses = [];
  const env = { LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, cli]) };
  const ctx = {
    env,
    ui: { setStatus: async (...args) => statuses.push(args) },
    modelRegistry: { find: async (...args) => { calls.push(["find", ...args]); return { provider: args[0], modelId: args[1] }; } },
  };
  const pi = {
    getAllTools: async () => { calls.push(["getAllTools"]); return ["read", "bash"]; },
    setModel: async (model) => { calls.push(["setModel", model]); return true; },
    setActiveTools: async (tools) => { calls.push(["setActiveTools", tools]); return true; },
  };

  const positive = await mod.commitPersona("ok", ctx, pi);
  assert.equal(positive.ok, true);
  assert.equal(mod.getActiveEnvelope()?.persona_id, "ok");
  const positiveCalls = calls.splice(0);
  assert.deepEqual(positiveCalls.map((call) => call[0]), ["find", "getAllTools", "setModel", "setActiveTools"]);
  statuses.length = 0;

  const negativeIds = [
    "missing-description",
    "bad-spec-version",
    "bad-posture",
    "legacy-tools",
    "legacy-side-effect-policy",
    "legacy-variables",
    "legacy-variant",
    "legacy-registry",
    "legacy-active",
    "extra-key",
  ];
  const negatives = [];
  for (const id of negativeIds) {
    calls.length = 0;
    statuses.length = 0;
    const before = mod.getActiveEnvelope()?.persona_id ?? null;
    const result = await mod.commitPersona(id, ctx, pi);
    const after = mod.getActiveEnvelope()?.persona_id ?? null;
    const record = {
      id,
      ok: result.ok,
      code: result.error?.code ?? null,
      before,
      after,
      sideEffects: calls.map((call) => call[0]),
      statuses,
    };
    assert.equal(record.ok, false, id);
    assert.equal(record.code, "LARVA_PERSONA_NOT_FOUND", id);
    assert.equal(record.before, "ok", id);
    assert.equal(record.after, "ok", id);
    assert.deepEqual(record.sideEffects, [], id);
    assert.deepEqual(record.statuses, [], id);
    negatives.push(record);
  }

  const evidence = {
    positive: {
      ok: positive.ok,
      persona_id: positive.envelope.persona_id,
      spec_digest: positive.envelope.spec_digest,
      model: positive.envelope.model,
      prompt: positive.envelope.prompt,
      calls: positiveCalls.map((call) => call[0]),
    },
    negatives,
    finalEnvelope: mod.getActiveEnvelope(),
  };
  console.log(JSON.stringify(evidence, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
