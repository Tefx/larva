import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
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
  return await import(`${extensionUrl.href}?policy=${encodeURIComponent(name)}-${Date.now()}-${Math.random()}`);
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function makeFakeCli(dir) {
  const cli = join(dir, "fake-larva-cli.mjs");
  await writeFile(cli, `
const [, , command, personaId, jsonFlag] = process.argv;
if (command !== "resolve" || jsonFlag !== "--json") process.exit(3);
process.stdout.write(JSON.stringify({ data: {
  id: personaId,
  prompt: "Prompt for " + personaId,
  model: "provider/model",
  capabilities: {},
  spec_version: "0.1.0",
  spec_digest: "sha256:" + personaId,
  can_spawn: true
}}));
`, "utf8");
  return cli;
}

async function runPolicyCase(name, arrange) {
  const dir = await mkdtemp(join(tmpdir(), `larva-pi-policy-${name}-`));
  const home = join(dir, "home");
  await mkdir(join(home, ".pi", "larva"), { recursive: true });
  const cli = await makeFakeCli(dir);
  const env = {
    HOME: home,
    LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, cli]),
  };
  const paths = {
    home,
    canonical: join(home, ".pi", "larva", "tool-policy.json"),
    legacy: join(home, ".pi", "tool-policy.json"),
    override: join(dir, "override-tool-policy.json"),
  };
  await arrange(paths, env);
  const mod = await importFresh(name);
  const activeToolCalls = [];
  const ctx = {
    env,
    ui: { setStatus: async () => undefined },
    modelRegistry: { find: async () => ({ id: "model" }) },
  };
  const pi = {
    getAllTools: async () => ["read", "bash"],
    setActiveTools: async (tools) => { activeToolCalls.push(tools); return true; },
    setModel: async () => true,
  };
  const result = await mod.commitPersona("p", ctx, pi);
  return { result, activeTools: activeToolCalls.at(-1), paths };
}

const cases = {
  "env-override": async () => {
    const override = await runPolicyCase("env-override", async (paths, env) => {
      await writeFile(paths.override, JSON.stringify({ personas: { p: { deny: ["bash"] } } }), "utf8");
      await writeFile(paths.canonical, JSON.stringify({ personas: { p: { deny: ["read"] } } }), "utf8");
      await writeFile(paths.legacy, JSON.stringify({ personas: { p: { allow: ["bash"] } } }), "utf8");
      env.LARVA_PI_TOOL_POLICY_FILE = paths.override;
    });
    assert.equal(override.result.ok, true);
    assert.deepEqual(override.activeTools, ["read"]);
    console.log("env-override PASS override only activeTools", JSON.stringify(override.activeTools));
  },
  "new-path-exists": async () => {
    const canonical = await runPolicyCase("canonical-exists", async (paths) => {
      await writeFile(paths.canonical, JSON.stringify({ personas: { p: { allow: ["bash"] } } }), "utf8");
      await writeFile(paths.legacy, JSON.stringify({ personas: { p: { allow: ["read"] } } }), "utf8");
    });
    assert.equal(canonical.result.ok, true);
    assert.deepEqual(canonical.activeTools, ["bash"]);
    console.log("new-path-exists PASS canonical activeTools", JSON.stringify(canonical.activeTools));
  },
  "legacy-fallback": async () => {
    const legacy = await runPolicyCase("legacy-fallback", async (paths) => {
      await writeFile(paths.legacy, JSON.stringify({ personas: { p: { deny: ["read"] } } }), "utf8");
    });
    assert.equal(legacy.result.ok, true);
    assert.deepEqual(legacy.activeTools, ["bash"]);
    console.log("legacy-fallback PASS legacy activeTools", JSON.stringify(legacy.activeTools));
  },
  "no-file-empty": async () => {
    const noFile = await runPolicyCase("no-file-canonical-empty", async () => undefined);
    assert.equal(noFile.result.ok, true);
    assert.deepEqual(noFile.activeTools, ["read", "bash"]);
    assert.equal(await exists(noFile.paths.canonical), false);
    assert.equal(await exists(noFile.paths.legacy), false);
    console.log("no-file-empty PASS canonical missing empty policy", JSON.stringify(noFile.activeTools));
  },
};

const choice = selectedCase();
if (choice === "all") {
  for (const name of Object.keys(cases)) await cases[name]();
  console.log("tool-policy paths: PASS");
} else if (cases[choice]) {
  await cases[choice]();
} else {
  console.error(`unknown --case ${choice}`);
  process.exit(2);
}
