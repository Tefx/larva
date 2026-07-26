import { mkdir, mkdtemp, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

process.env.LARVA_PI_INITIAL_PERSONA_MODEL_FROM_CLI = "openai-codex/gpt-5.5";
const root = process.cwd();
const extensionUrl = pathToFileURL(join(root, "contrib/pi-extension/larva.ts"));

async function importFresh(name) {
  return await import(`${extensionUrl.href}?case=${encodeURIComponent(name)}-${Date.now()}-${Math.random()}`);
}

async function makeFakeCli(dir, personaModels) {
  const cli = join(dir, "fake-larva-cli.mjs");
  await writeFile(cli, `
const [, , command, personaId, jsonFlag] = process.argv;
if (command !== "resolve" || jsonFlag !== "--json") process.exit(3);
const models = JSON.parse(process.env.PERSONA_MODELS || "{}");
const model = models[personaId] || models.default || "provider/model";
process.stdout.write(JSON.stringify({ data: {
  id: personaId,
  description: "Persona " + personaId,
  prompt: "Prompt for " + personaId,
  model,
  capabilities: {},
  spec_version: "0.1.0",
  spec_digest: "sha256:" + personaId,
  can_spawn: true
}}));
`, "utf8");
  return cli;
}

async function runCommit({ name, personaId = name, modelMap, personaModels, registryMiss = false, startup = false, afterStartupSwitch = false }) {
  const dir = await mkdtemp(join(tmpdir(), `larva-pi-model-${name}-`));
  const cli = await makeFakeCli(dir, personaModels);
  let mapFile;
  if (modelMap !== undefined) {
    mapFile = join(dir, "model-map.json");
    await writeFile(mapFile, typeof modelMap === "string" ? modelMap : JSON.stringify(modelMap), "utf8");
  } else {
    mapFile = join(dir, "missing-model-map.json");
  }
  const mod = await importFresh(name);
  const registryCalls = [];
  const setModels = [];
  const statuses = [];
  const commands = {};
  const env = {
    LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, cli]),
    LARVA_PI_MODEL_MAP_FILE: mapFile,
    PERSONA_MODELS: JSON.stringify(personaModels),
    LARVA_PI_LAUNCHED: "0",
    ...(startup ? { LARVA_PI_INITIAL_PERSONA_ID: personaId, LARVA_PI_INITIAL_PERSONA_MODEL_FROM_CLI: "openai-codex/gpt-5.5" } : {}),
  };
  const ctx = {
    env,
    ...(startup ? { model: { provider: "openai-codex", id: "gpt-5.5" } } : {}),
    ui: { setStatus: async (...args) => statuses.push(args) },
    modelRegistry: {
      find: async (provider, modelId) => {
        registryCalls.push([provider, modelId]);
        return registryMiss ? null : { provider, modelId };
      },
    },
  };
  const pi = {
    getAllTools: async () => ["read", "bash"],
    setActiveTools: async () => true,
    setModel: async (model) => { setModels.push(model); return true; },
    registerCommand: (commandName, options) => { commands[commandName] = options; },
    registerTool: () => undefined,
    on: () => undefined,
  };
  if (startup) {
    await mod.initializeExtension(ctx, pi);
    if (afterStartupSwitch) {
      const switched = await commands["larva-persona"].handler("slash", ctx);
      return { result: switched, registryCalls, setModels, statuses };
    }
    return { result: mod.getActiveEnvelope() ? { ok: true, envelope: mod.getActiveEnvelope() } : { ok: false }, registryCalls, setModels, statuses };
  }
  const result = await mod.handlePersonaCommand(personaId, ctx, pi);
  return { result, registryCalls, setModels, statuses };
}

const exampleMap = {
  models: {
    "openai/gpt-5.5": { provider: "openai-codex", model_id: "gpt-5.5" },
    "ollama-cloud/glm-5.1": { provider: "openrouter", model_id: "z-ai/glm-5.1" },
  },
  prefix_rules: [
    { from_prefix: "openrouter/", to_provider: "openrouter", to_model_id_prefix: "" },
    { from_prefix: "ollama-cloud/", to_provider: "wrong", to_model_id_prefix: "wrong/" },
  ],
};

const exact = await runCommit({
  name: "exact-hit",
  modelMap: exampleMap,
  personaModels: { "exact-hit": "openai/gpt-5.5" },
});
assert.equal(exact.result.ok, true);
assert.deepEqual(exact.registryCalls.at(-1), ["openai-codex", "gpt-5.5"]);
console.log("exact hit: PASS", JSON.stringify(exact.registryCalls.at(-1)));

const prefix = await runCommit({
  name: "prefix-hit",
  modelMap: exampleMap,
  personaModels: { "prefix-hit": "openrouter/google/gemini-3.1-pro-preview" },
});
assert.equal(prefix.result.ok, true);
assert.deepEqual(prefix.registryCalls.at(-1), ["openrouter", "google/gemini-3.1-pro-preview"]);
console.log("prefix hit: PASS", JSON.stringify(prefix.registryCalls.at(-1)));

const prefixGeminiFlash = await runCommit({
  name: "prefix-hit-gemini-flash",
  modelMap: exampleMap,
  personaModels: { "prefix-hit-gemini-flash": "openrouter/google/gemini-3.5-flash" },
});
assert.equal(prefixGeminiFlash.result.ok, true);
assert.deepEqual(prefixGeminiFlash.registryCalls.at(-1), ["openrouter", "google/gemini-3.5-flash"]);
console.log("prefix hit gemini flash: PASS", JSON.stringify(prefixGeminiFlash.registryCalls.at(-1)));

const conflict = await runCommit({
  name: "same-length-prefix-conflict-invalid",
  modelMap: { models: {}, prefix_rules: [
    { from_prefix: "abc/", to_provider: "one", to_model_id_prefix: "" },
    { from_prefix: "abd/", to_provider: "two", to_model_id_prefix: "" },
  ] },
  personaModels: { "same-length-prefix-conflict-invalid": "abc/model" },
});
// Non-conflicting same-length non-matches are valid; exercise true conflict with identical-length matching prefixes.
const trueConflict = await runCommit({
  name: "true-conflict-invalid",
  modelMap: { models: {}, prefix_rules: [
    { from_prefix: "abc/", to_provider: "one", to_model_id_prefix: "" },
    { from_prefix: "abc/", to_provider: "two", to_model_id_prefix: "" },
  ] },
  personaModels: { "true-conflict-invalid": "abc/model" },
});
assert.equal(conflict.result.ok, true);
assert.equal(trueConflict.result.ok, false);
assert.equal(trueConflict.result.error.code, "LARVA_MODEL_MAP_INVALID");
console.log("same-length prefix conflict invalid: PASS", trueConflict.result.error.code);

const fallback = await runCommit({
  name: "missing-config-fallback",
  modelMap: undefined,
  personaModels: { "missing-config-fallback": "provider/model/with/slash" },
});
assert.equal(fallback.result.ok, true);
assert.deepEqual(fallback.registryCalls.at(-1), ["provider", "model/with/slash"]);
console.log("missing config fallback: PASS", JSON.stringify(fallback.registryCalls.at(-1)));

const invalid = await runCommit({
  name: "invalid-config",
  modelMap: "{not-json",
  personaModels: { "invalid-config": "provider/model" },
});
assert.equal(invalid.result.ok, false);
assert.equal(invalid.result.error.code, "LARVA_MODEL_MAP_INVALID");
console.log("invalid config: PASS", invalid.result.error.code);

const unavailable = await runCommit({
  name: "mapped-unavailable",
  modelMap: exampleMap,
  personaModels: { "mapped-unavailable": "openai/gpt-5.5" },
  registryMiss: true,
});
assert.equal(unavailable.result.ok, false);
assert.equal(unavailable.result.error.code, "LARVA_MODEL_UNAVAILABLE");
console.log("mapped unavailable: PASS", unavailable.result.error.code);

const startup = await runCommit({
  name: "startup-persona",
  personaId: "startup",
  startup: true,
  modelMap: exampleMap,
  personaModels: { startup: "openai/gpt-5.5" },
});
assert.equal(startup.result.ok, true);
assert.deepEqual(startup.registryCalls.at(-1), ["openai-codex", "gpt-5.5"]);
console.log("startup persona: PASS", JSON.stringify(startup.registryCalls.at(-1)));

const slash = await runCommit({
  name: "slash-switch",
  modelMap: exampleMap,
  personaModels: { "slash-switch": "openrouter/google/gemini-3.1-pro-preview" },
});
assert.equal(slash.result.ok, true);
assert.deepEqual(slash.registryCalls.at(-1), ["openrouter", "google/gemini-3.1-pro-preview"]);
console.log("slash switch: PASS", JSON.stringify(slash.registryCalls.at(-1)));

const afterStartup = await runCommit({
  name: "slash-switch-after-startup",
  personaId: "startup",
  startup: true,
  afterStartupSwitch: true,
  modelMap: exampleMap,
  personaModels: { startup: "openai/gpt-5.5", slash: "openrouter/google/gemini-3.1-pro-preview" },
});
assert.equal(afterStartup.result.ok, true);
assert.deepEqual(afterStartup.registryCalls, [["openai-codex", "gpt-5.5"], ["openrouter", "google/gemini-3.1-pro-preview"]]);
console.log("slash-switch-after-startup behavior: PASS", JSON.stringify(afterStartup.registryCalls));

async function profileFixture(name) {
  const home = await mkdtemp(join(tmpdir(), `larva-profile-${name}-`));
  const configDir = join(home, ".pi", "larva");
  await mkdir(configDir, { recursive: true });
  const cli = await makeFakeCli(home, {});
  const env = { HOME: home, LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, cli]), PERSONA_MODELS: JSON.stringify({ parent: "logical/parent" }), LARVA_PI_LAUNCHED: "0" };
  return { home, configDir, env };
}

const profileBadName = await profileFixture("bad-name");
const profileBadNameMod = await importFresh("profile-bad-name");
for (const badName of ["bad.name", "../escape", "/absolute", "", `x${"y".repeat(64)}`]) {
  const rejected = await profileBadNameMod.switchModelMapProfile(badName, { env: profileBadName.env }, {});
  assert.equal(rejected.status, "failed");
  assert.equal(rejected.parent.error.code, "LARVA_MODEL_MAP_PROFILE_BAD_NAME");
}
console.log("profile invalid/traversal names: PASS LARVA_MODEL_MAP_PROFILE_BAD_NAME");

const validExternalProfile = await profileFixture("external-regular");
const outsideMap = join(validExternalProfile.home, "outside.json");
const outsideMapBytes = JSON.stringify({ models: {}, prefix_rules: [] });
await writeFile(outsideMap, outsideMapBytes, "utf8");
const externalLexicalPath = join(validExternalProfile.configDir, "model-map.escape.json");
await symlink(outsideMap, externalLexicalPath);
const validExternalMod = await importFresh("profile-external-regular");
const escaped = await validExternalMod.switchModelMapProfile("escape", { env: validExternalProfile.env }, {});
assert.equal(escaped.status, "success");
assert.equal(escaped.parent.state, "not_applicable");
console.log("profile external regular-file symlink activation: PASS", JSON.stringify({ lexical: externalLexicalPath, target: outsideMap }));

async function assertExternalProfileFailure(name, target, expectedCode = "LARVA_MODEL_MAP_PROFILE_INVALID") {
  const fixture = await profileFixture(name);
  const lexical = join(fixture.configDir, `model-map.${name}.json`);
  await symlink(target, lexical);
  const mod = await importFresh(`profile-${name}`);
  const started = Date.now();
  const result = await mod.switchModelMapProfile(name, { env: fixture.env }, {});
  const elapsedMs = Date.now() - started;
  assert.equal(result.status, "failed");
  assert.equal(result.parent.error.code, expectedCode);
  assert.deepEqual(result.children, []);
  assert.ok(elapsedMs < 1_000, `${name} rejection exceeded bound: ${elapsedMs}ms`);
  return { elapsedMs, code: result.parent.error.code };
}

const danglingFixture = await profileFixture("dangling");
const danglingLexical = join(danglingFixture.configDir, "model-map.dangling.json");
await symlink(join(danglingFixture.home, "missing-target.json"), danglingLexical);
const danglingMod = await importFresh("profile-dangling");
const danglingStarted = Date.now();
const dangling = await danglingMod.switchModelMapProfile("dangling", { env: danglingFixture.env }, {});
assert.equal(dangling.status, "failed");
assert.equal(dangling.parent.error.code, "LARVA_MODEL_MAP_PROFILE_NOT_FOUND");
assert.ok(Date.now() - danglingStarted < 1_000);

const directoryTarget = await mkdtemp(join(tmpdir(), "larva-profile-directory-target-"));
const directoryFailure = await assertExternalProfileFailure("directory", directoryTarget);
const oversizedTarget = join((await profileFixture("oversized-target-root")).home, "oversized.json");
await writeFile(oversizedTarget, Buffer.alloc(1_048_577, 0x20));
const oversizedFailure = await assertExternalProfileFailure("oversized", oversizedTarget);
const malformedTarget = join((await profileFixture("malformed-target-root")).home, "malformed.json");
await writeFile(malformedTarget, "{not-json", "utf8");
const malformedFailure = await assertExternalProfileFailure("malformed", malformedTarget);
const unknownSchemaTarget = join((await profileFixture("unknown-target-root")).home, "unknown.json");
await writeFile(unknownSchemaTarget, JSON.stringify({ models: {}, prefix_rules: [], unknown: true }), "utf8");
const unknownSchemaFailure = await assertExternalProfileFailure("unknown", unknownSchemaTarget);
let deviceFailure = null;
if (process.platform !== "win32") deviceFailure = await assertExternalProfileFailure("device", "/dev/null");
console.log("profile bounded fail-closed objects: PASS", JSON.stringify({ dangling: dangling.parent.error.code, directoryFailure, oversizedFailure, malformedFailure, unknownSchemaFailure, deviceFailure }));

if (process.platform !== "win32") {
  const fifoFixture = await profileFixture("fifo");
  const fifoTarget = join(fifoFixture.home, "external.fifo");
  const mkfifo = spawnSync("mkfifo", [fifoTarget], { encoding: "utf8" });
  assert.equal(mkfifo.status, 0, mkfifo.stderr);
  await symlink(fifoTarget, join(fifoFixture.configDir, "model-map.fifo.json"));
  const probe = join(fifoFixture.home, "fifo-probe.mjs");
  await writeFile(probe, `
const mod = await import(${JSON.stringify(extensionUrl.href)} + "?fifo-probe=" + Date.now());
const result = await mod.switchModelMapProfile("fifo", { env: ${JSON.stringify(fifoFixture.env)} }, {});
process.stdout.write(JSON.stringify({ status: result.status, code: result.parent.error?.code }));
`, "utf8");
  const fifoOutcome = spawnSync(process.execPath, [probe], { cwd: root, encoding: "utf8", timeout: 1_500 });
  assert.equal(fifoOutcome.status, 0, JSON.stringify({ signal: fifoOutcome.signal, error: fifoOutcome.error?.message, stderr: fifoOutcome.stderr }));
  assert.deepEqual(JSON.parse(fifoOutcome.stdout), { status: "failed", code: "LARVA_MODEL_MAP_PROFILE_INVALID" });
  console.log("profile FIFO nonblocking rejection: PASS", fifoOutcome.stdout);
}

const closeFixture = await profileFixture("close");
const closeTarget = join(closeFixture.home, "external-malformed.json");
await writeFile(closeTarget, "{not-json", "utf8");
await symlink(closeTarget, join(closeFixture.configDir, "model-map.close.json"));
const closeMod = await importFresh("profile-close");
const descriptorRoot = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
await closeMod.switchModelMapProfile("close", { env: closeFixture.env }, {});
const descriptorCountBefore = (await readdir(descriptorRoot)).length;
for (let attempt = 0; attempt < 32; attempt += 1) {
  const result = await closeMod.switchModelMapProfile("close", { env: closeFixture.env }, {});
  assert.equal(result.parent.error.code, "LARVA_MODEL_MAP_PROFILE_INVALID");
}
const descriptorCountAfter = (await readdir(descriptorRoot)).length;
assert.equal(descriptorCountAfter, descriptorCountBefore);
console.log("profile descriptor closure: PASS", JSON.stringify({ descriptorCountBefore, descriptorCountAfter }));

const raceFixture = await profileFixture("race");
const raceLexical = join(raceFixture.configDir, "model-map.race.json");
const raceTargetA = join(raceFixture.home, "race-a.json");
const raceTargetB = join(raceFixture.home, "race-b.json");
const nearLimitMap = (modelId) => {
  const raw = JSON.stringify({ models: { "logical/parent": { provider: "neutral", model_id: modelId } }, prefix_rules: [] });
  return `${raw}${" ".repeat(1_040_000 - Buffer.byteLength(raw))}`;
};
const raceMapA = nearLimitMap("race-a");
const raceMapB = nearLimitMap("race-b");
await writeFile(raceTargetA, raceMapA, "utf8");
await writeFile(raceTargetB, raceMapB, "utf8");
await symlink(raceTargetA, raceLexical);
const raceMod = await importFresh("profile-race");
const raceSetModels = [];
const raceCtx = {
  env: { ...raceFixture.env, LARVA_PI_INITIAL_PERSONA_ID: "parent" },
  model: { provider: "logical", id: "parent" },
  modelRegistry: { find: async (provider, modelId) => ({ provider, modelId }) },
  ui: { setStatus: async () => undefined, notify: async () => undefined },
};
const racePi = {
  getAllTools: async () => [],
  setActiveTools: async () => true,
  setModel: async (model) => { raceSetModels.push(model); return true; },
  registerTool: () => undefined,
  registerCommand: () => undefined,
  on: () => undefined,
};
await raceMod.initializeExtension(raceCtx, racePi);
const stableRaceA = await raceMod.switchModelMapProfile("race", raceCtx, racePi);
assert.equal(stableRaceA.parent.model_id, "race-a");
await symlink(raceTargetB, `${raceLexical}.stable-b`);
await rename(`${raceLexical}.stable-b`, raceLexical);
const stableRaceB = await raceMod.switchModelMapProfile("race", raceCtx, racePi);
assert.equal(stableRaceB.parent.model_id, "race-b");

let retargeting = true;
let retargetCount = 0;
const retargetLoop = (async () => {
  while (retargeting) {
    const target = retargetCount % 2 === 0 ? raceTargetA : raceTargetB;
    const next = `${raceLexical}.next-${retargetCount}`;
    await symlink(target, next);
    await rename(next, raceLexical);
    retargetCount += 1;
  }
})();
while (retargetCount < 5) await new Promise((resolveTurn) => setImmediate(resolveTurn));
const retargetResults = [];
for (let attempt = 0; attempt < 60; attempt += 1) retargetResults.push(await raceMod.switchModelMapProfile("race", raceCtx, racePi));
retargeting = false;
await retargetLoop;
const retargetFailures = retargetResults.filter((result) => result.status === "failed");
assert.ok(retargetFailures.length > 0, "active atomic symlink retarget must be detected at least once");
for (const result of retargetResults) {
  if (result.status === "success") assert.ok(["race-a", "race-b"].includes(result.parent.model_id));
  else assert.equal(result.parent.error.code, "LARVA_MODEL_MAP_PROFILE_INVALID");
}

const mutationLexical = join(raceFixture.configDir, "model-map.mutate.json");
const mutationTarget = join(raceFixture.home, "race-mutate.json");
await writeFile(mutationTarget, raceMapA, "utf8");
await symlink(mutationTarget, mutationLexical);
const stableMutation = await raceMod.switchModelMapProfile("mutate", raceCtx, racePi);
assert.equal(stableMutation.parent.model_id, "race-a");
let mutating = true;
let mutationCount = 0;
const mutationLoop = (async () => {
  while (mutating) {
    await writeFile(mutationTarget, mutationCount % 2 === 0 ? raceMapB : raceMapA, "utf8");
    mutationCount += 1;
  }
})();
while (mutationCount < 5) await new Promise((resolveTurn) => setImmediate(resolveTurn));
const mutationResults = [];
for (let attempt = 0; attempt < 40; attempt += 1) mutationResults.push(await raceMod.switchModelMapProfile("mutate", raceCtx, racePi));
mutating = false;
await mutationLoop;
const mutationFailures = mutationResults.filter((result) => result.status === "failed");
assert.ok(mutationFailures.length > 0, "active target metadata mutation must be detected at least once");
for (const result of mutationResults) {
  if (result.status === "success") assert.ok(["race-a", "race-b"].includes(result.parent.model_id));
  else assert.equal(result.parent.error.code, "LARVA_MODEL_MAP_PROFILE_INVALID");
}
const stableMutationAfter = await raceMod.switchModelMapProfile("mutate", raceCtx, racePi);
assert.ok(["race-a", "race-b"].includes(stableMutationAfter.parent.model_id));
console.log("profile lexical-retarget/target-mutation stability detection: PASS", JSON.stringify({ retargets: retargetCount, retargetSuccesses: retargetResults.length - retargetFailures.length, retargetFailures: retargetFailures.length, mutations: mutationCount, mutationSuccesses: mutationResults.length - mutationFailures.length, mutationFailures: mutationFailures.length }));

const profileNoParent = await profileFixture("no-parent");
await writeFile(join(profileNoParent.configDir, "model-map.safe_1.json"), JSON.stringify({ models: { "logical/parent": { provider: "neutral", model_id: "parent-v2" } }, prefix_rules: [] }), "utf8");
const profileNoParentMod = await importFresh("profile-no-parent");
const selected = await profileNoParentMod.switchModelMapProfile("safe_1", { env: profileNoParent.env }, {});
assert.equal(selected.status, "success");
assert.equal(selected.parent.state, "not_applicable");
assert.equal(selected.generation, 1);
console.log("profile no-parent activation: PASS", JSON.stringify(selected));

console.log("model-map unit: PASS");
