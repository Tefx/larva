import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
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
const badDot = await profileBadNameMod.switchModelMapProfile("bad.name", { env: profileBadName.env }, {});
assert.equal(badDot.status, "failed");
assert.equal(badDot.parent.error.code, "LARVA_MODEL_MAP_PROFILE_BAD_NAME");
console.log("profile bad-name no-dot rule: PASS", badDot.parent.error.code);

const profileSecurity = await profileFixture("security");
const outsideMap = join(profileSecurity.home, "outside.json");
await writeFile(outsideMap, JSON.stringify({ models: {}, prefix_rules: [] }), "utf8");
await symlink(outsideMap, join(profileSecurity.configDir, "model-map.escape.json"));
const profileSecurityMod = await importFresh("profile-security");
const escaped = await profileSecurityMod.switchModelMapProfile("escape", { env: profileSecurity.env }, {});
assert.equal(escaped.status, "failed");
assert.equal(escaped.parent.error.code, "LARVA_MODEL_MAP_PROFILE_INVALID");
console.log("profile symlink escape: PASS", escaped.parent.error.code);

const profileNoParent = await profileFixture("no-parent");
await writeFile(join(profileNoParent.configDir, "model-map.safe_1.json"), JSON.stringify({ models: { "logical/parent": { provider: "neutral", model_id: "parent-v2" } }, prefix_rules: [] }), "utf8");
const profileNoParentMod = await importFresh("profile-no-parent");
const selected = await profileNoParentMod.switchModelMapProfile("safe_1", { env: profileNoParent.env }, {});
assert.equal(selected.status, "success");
assert.equal(selected.parent.state, "not_applicable");
assert.equal(selected.generation, 1);
console.log("profile no-parent activation: PASS", JSON.stringify(selected));

console.log("model-map unit: PASS");
