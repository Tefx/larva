import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const root = process.cwd();
const extensionUrl = pathToFileURL(join(root, "contrib/pi-extension/larva.ts"));

function selectedCase() {
  const index = process.argv.indexOf("--case");
  return index === -1 ? "all" : process.argv[index + 1];
}

async function importFresh(name) {
  return await import(`${extensionUrl.href}?runtime=${encodeURIComponent(name)}-${Date.now()}-${Math.random()}`);
}

async function makeFakeCli(dir) {
  const cli = join(dir, "fake-larva-cli.mjs");
  await writeFile(cli, `
const [, , command, personaId, jsonFlag] = process.argv;
if (command !== "resolve" || jsonFlag !== "--json") process.exit(3);
const models = JSON.parse(process.env.PERSONA_MODELS || "{}");
const model = models[personaId] || models.default || "provider/model";
process.stdout.write(JSON.stringify({ data: {
  id: personaId,
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
  const dir = await mkdtemp(join(tmpdir(), `larva-pi-model-runtime-${name}-`));
  const cli = await makeFakeCli(dir);
  let mapFile;
  if (modelMap !== undefined) {
    mapFile = join(dir, "model-map.json");
    await writeFile(mapFile, typeof modelMap === "string" ? modelMap : JSON.stringify(modelMap), "utf8");
  } else {
    mapFile = join(dir, "definitely-missing-model-map.json");
  }

  const mod = await importFresh(name);
  const registryCalls = [];
  const setModels = [];
  const statuses = [];
  const notifications = [];
  const commands = {};
  const env = {
    LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, cli]),
    LARVA_PI_MODEL_MAP_FILE: mapFile,
    PERSONA_MODELS: JSON.stringify(personaModels),
    ...(startup ? { LARVA_PI_INITIAL_PERSONA_ID: personaId } : {}),
  };
  const ctx = {
    env,
    ui: {
      setStatus: async (...args) => statuses.push(args),
      notify: async (message, notifyType) => notifications.push({ message, notifyType }),
    },
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
      return { result: switched, registryCalls, setModels, statuses, notifications, mapFile };
    }
    return {
      result: mod.getActiveEnvelope() ? { ok: true, envelope: mod.getActiveEnvelope() } : { ok: false },
      registryCalls,
      setModels,
      statuses,
      notifications,
      mapFile,
    };
  }

  const result = await mod.handlePersonaCommand(personaId, ctx, pi);
  return { result, registryCalls, setModels, statuses, notifications, mapFile };
}

const exampleMap = {
  models: {
    "openai/gpt-5.5": { provider: "openai-codex", model_id: "gpt-5.5" },
  },
  prefix_rules: [
    { from_prefix: "openrouter/", to_provider: "openrouter", to_model_id_prefix: "" },
  ],
};

const cases = {
  "exact-hit": async () => {
    const observed = await runCommit({
      name: "exact-hit",
      modelMap: exampleMap,
      personaModels: { "exact-hit": "openai/gpt-5.5" },
    });
    assert.equal(observed.result.ok, true);
    assert.deepEqual(observed.registryCalls.at(-1), ["openai-codex", "gpt-5.5"]);
    console.log("exact-hit PASS openai-codex/gpt-5.5 modelRegistry.find", JSON.stringify(observed.registryCalls));
  },
  "prefix-hit": async () => {
    const observed = await runCommit({
      name: "prefix-hit",
      modelMap: exampleMap,
      personaModels: { "prefix-hit": "openrouter/google/gemini-3.1-pro-preview" },
    });
    assert.equal(observed.result.ok, true);
    assert.deepEqual(observed.registryCalls.at(-1), ["openrouter", "google/gemini-3.1-pro-preview"]);
    console.log("prefix-hit PASS openrouter/google/gemini-3.1-pro-preview", JSON.stringify(observed.registryCalls));
  },
  "conflict-invalid": async () => {
    const observed = await runCommit({
      name: "conflict-invalid",
      modelMap: { models: {}, prefix_rules: [
        { from_prefix: "abc/", to_provider: "one", to_model_id_prefix: "" },
        { from_prefix: "abc/", to_provider: "two", to_model_id_prefix: "" },
      ] },
      personaModels: { "conflict-invalid": "abc/model" },
    });
    assert.equal(observed.result.ok, false);
    assert.equal(observed.result.error.code, "LARVA_MODEL_MAP_INVALID");
    console.log("conflict-invalid PASS LARVA_MODEL_MAP_INVALID", JSON.stringify(observed.result.error));
  },
  "missing-config": async () => {
    const observed = await runCommit({
      name: "missing-config",
      modelMap: undefined,
      personaModels: { "missing-config": "provider/model/with/slash" },
    });
    assert.equal(observed.result.ok, true);
    assert.deepEqual(observed.registryCalls.at(-1), ["provider", "model/with/slash"]);
    console.log("missing-config PASS first-slash fallback provider/model/with/slash", JSON.stringify(observed.registryCalls));
  },
  "invalid-config": async () => {
    const observed = await runCommit({
      name: "invalid-config",
      modelMap: "{not-json",
      personaModels: { "invalid-config": "provider/model" },
    });
    assert.equal(observed.result.ok, false);
    assert.equal(observed.result.error.code, "LARVA_MODEL_MAP_INVALID");
    console.log("invalid-config PASS existing invalid file LARVA_MODEL_MAP_INVALID", JSON.stringify({ mapFile: observed.mapFile, error: observed.result.error }));
  },
  "relative-override-invalid": async () => {
    const mod = await importFresh("relative-override-invalid-direct");
    const dir = await mkdtemp(join(tmpdir(), "larva-pi-model-runtime-relative-direct-"));
    const cli = await makeFakeCli(dir);
    const result = await mod.handlePersonaCommand("relative-override-invalid", {
      env: {
        LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, cli]),
        LARVA_PI_MODEL_MAP_FILE: "relative-model-map.json",
        PERSONA_MODELS: JSON.stringify({ "relative-override-invalid": "provider/model" }),
      },
      modelRegistry: { find: async () => ({ id: "model" }) },
      ui: { setStatus: async () => undefined },
    }, {
      getAllTools: async () => ["read"],
      setActiveTools: async () => true,
      setModel: async () => true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "LARVA_MODEL_MAP_INVALID");
    console.log("relative-override-invalid PASS LARVA_MODEL_MAP_INVALID", JSON.stringify(result.error));
  },
  "mapped-unavailable": async () => {
    const observed = await runCommit({
      name: "mapped-unavailable",
      modelMap: exampleMap,
      personaModels: { "mapped-unavailable": "openai/gpt-5.5" },
      registryMiss: true,
    });
    assert.equal(observed.result.ok, false);
    assert.equal(observed.result.error.code, "LARVA_MODEL_UNAVAILABLE");
    assert.deepEqual(observed.registryCalls.at(-1), ["openai-codex", "gpt-5.5"]);
    console.log("mapped-unavailable PASS LARVA_MODEL_UNAVAILABLE valid-map registry-miss", JSON.stringify({ calls: observed.registryCalls, error: observed.result.error }));
  },
  "startup-persona": async () => {
    const observed = await runCommit({
      name: "startup-persona",
      personaId: "startup",
      startup: true,
      modelMap: exampleMap,
      personaModels: { startup: "openai/gpt-5.5" },
    });
    assert.equal(observed.result.ok, true);
    assert.deepEqual(observed.registryCalls.at(-1), ["openai-codex", "gpt-5.5"]);
    console.log("startup-persona PASS shared resolver use openai-codex/gpt-5.5", JSON.stringify(observed.registryCalls));
  },
  "slash-switch": async () => {
    const observed = await runCommit({
      name: "slash-switch",
      modelMap: exampleMap,
      personaModels: { "slash-switch": "openrouter/google/gemini-3.1-pro-preview" },
    });
    assert.equal(observed.result.ok, true);
    assert.deepEqual(observed.registryCalls.at(-1), ["openrouter", "google/gemini-3.1-pro-preview"]);
    console.log("slash-switch PASS shared resolver use openrouter/google/gemini-3.1-pro-preview", JSON.stringify(observed.registryCalls));
  },
  "slash-switch-after-startup": async () => {
    const observed = await runCommit({
      name: "slash-switch-after-startup",
      personaId: "startup",
      startup: true,
      afterStartupSwitch: true,
      modelMap: exampleMap,
      personaModels: { startup: "openai/gpt-5.5", slash: "openrouter/google/gemini-3.1-pro-preview" },
    });
    assert.equal(observed.result.ok, true);
    assert.deepEqual(observed.registryCalls, [["openai-codex", "gpt-5.5"], ["openrouter", "google/gemini-3.1-pro-preview"]]);
    console.log("slash-switch-after-startup PASS no resolver divergence", JSON.stringify(observed.registryCalls));
  },
};

const choice = selectedCase();
if (choice === "all") {
  for (const name of Object.keys(cases)) await cases[name]();
  console.log("model-map runtime: PASS");
} else if (cases[choice]) {
  await cases[choice]();
} else {
  console.error(`unknown --case ${choice}`);
  process.exit(2);
}
