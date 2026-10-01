import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const root = process.cwd();
const extensionUrl = pathToFileURL(join(root, "contrib/pi-extension/larva.ts"));
const fixtureDirs = [];

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
  description: "Persona " + personaId,
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
  fixtureDirs.push(dir);
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
  let live = ["read", "bash"];
  const pi = {
    getAllTools: async () => ["read", "bash", "deferred"],
    getActiveTools: async () => [...live],
    setActiveTools: async (tools) => { live = [...tools]; activeToolCalls.push(tools); return true; },
    setModel: async () => true,
  };
  const result = await mod.commitPersona("p", ctx, pi);
  return { result, activeTools: activeToolCalls.at(-1), paths, mod, ctx, pi, active: () => [...live], updates: activeToolCalls };
}

const cases = {
  "live-permissions": async () => {
    const f = await runPolicyCase("live-permissions", async (paths) => {
      await writeFile(paths.canonical, JSON.stringify({ personas: { p: { deny: ["bash"] }, q: {}, empty: { allow: [] }, exact: { allow: ["read", "deferred", "unknown", "read"], deny: ["read", "unknown"] } } }));
    });
    assert.equal(f.result.ok, true);
    assert.deepEqual(f.active(), ["read"]);
    assert.deepEqual(f.mod.decideToolCall("deferred"), { action: "allow" }, "Permission does not declare an undeclared tool");
    assert.deepEqual(await f.mod.decideToolCallWithRefresh("deferred", f.pi), { action: "allow" });
    assert.deepEqual(f.active(), ["read"]);
    assert.equal((await f.mod.commitPersona("q", f.ctx, f.pi)).ok, true);
    assert.deepEqual(f.active(), ["read", "bash"], "Only bash was originally declared and Larva-masked; deferred stays undeclared");
    await f.pi.setActiveTools(["read", "deferred"]); // an observable Pi disable of bash
    assert.deepEqual(await f.mod.decideToolCallWithRefresh("deferred", f.pi), { action: "allow" });
    assert.deepEqual(f.active(), ["read", "deferred"], "Explicit allowed activation and observable bash disable are preserved");
    assert.equal((await f.mod.commitPersona("p", f.ctx, f.pi)).ok, true);
    assert.equal((await f.mod.commitPersona("q", f.ctx, f.pi)).ok, true);
    assert.deepEqual(f.active(), ["read", "deferred"], "A tool disabled before a restrictive roundtrip stays disabled");
    assert.equal((await f.mod.commitPersona("exact", f.ctx, f.pi)).ok, true);
    assert.deepEqual(f.active(), ["deferred"]);
    assert.equal(f.mod.decideToolCall("read").action, "deny", "Deny wins over exact allow");
    assert.equal(f.mod.decideToolCall("Read").action, "deny", "No aliases or pattern extensions");
    assert.equal((await f.mod.commitPersona("empty", f.ctx, f.pi)).ok, true);
    for (const tool of ["read", "bash", "deferred"]) assert.equal(f.mod.decideToolCall(tool).action, "deny");
    assert.deepEqual(f.active(), []);
    assert.deepEqual(f.mod.filterPolicyTools(["read", "bash"], { allow: ["unknown", "read"], deny: ["read"] }), []);
    console.log("live-permissions PASS role-masked declaration restoration, explicit disable and no bulk activation");
  },
  "registration-intent": async () => {
    const f = await runPolicyCase("registration-intent", async (paths) => {
      await writeFile(paths.canonical, JSON.stringify({ personas: { p: {}, q: { deny: ["read"] } } }));
    });
    await f.pi.setActiveTools(["read"]); // user disables bash while available
    assert.equal((await f.mod.commitPersona("q", f.ctx, f.pi)).ok, true);
    assert.deepEqual(f.active(), []);
    f.pi.getAllTools = async () => ["read"];
    assert.equal((await f.mod.decideToolCallWithRefresh("deferred", f.pi)).action, "allow");
    f.pi.getAllTools = async () => ["read", "bash", "deferred", "registry_only"];
    await f.pi.setActiveTools(["bash"]); // Pi's re-registration default
    assert.equal((await f.mod.decideToolCallWithRefresh("bash", f.pi)).action, "allow");
    assert.deepEqual(f.active(), [], "Re-registration cannot overwrite this branch's saved disable");
    assert.equal((await f.mod.commitPersona("p", f.ctx, f.pi)).ok, true);
    assert.deepEqual(f.active(), ["read"], "Masked read returns; pre-disabled bash and undeclared registry tools do not");
    await f.pi.setActiveTools(["read", "bash"]);
    assert.equal((await f.mod.decideToolCallWithRefresh("bash", f.pi)).action, "allow");
    assert.deepEqual(f.active(), ["read", "bash"], "Explicit selection after registration is preserved");
    console.log("registration-intent PASS saved branch selection survives native re-registration defaults");
  },
  "live-rollback": async () => {
    const f = await runPolicyCase("live-rollback", async (paths) => {
      await writeFile(paths.canonical, JSON.stringify({ personas: { p: { deny: ["bash"] }, q: {} } }));
    });
    await f.pi.setActiveTools(["read", "deferred"]); // changed since the first persona commit
    f.pi.setModel = async () => true;
    let fail = true;
    const set = f.pi.setActiveTools;
    f.pi.setActiveTools = async (tools) => { await set(tools); if (fail) { fail = false; throw new Error("Setter failed after mutation"); } return true; };
    const result = await f.mod.commitPersona("q", f.ctx, f.pi);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "LARVA_TOOL_ENUMERATION_FAILED");
    assert.equal(f.mod.getActiveEnvelope().persona_id, "p");
    assert.deepEqual(f.active(), ["read", "deferred"], "Rollback must use Pi's live snapshot, never the prior commit cache");
    assert.equal((await f.mod.commitPersona("q", f.ctx, f.pi)).ok, true);
    assert.deepEqual(f.active(), ["read", "bash", "deferred"], "Rollback also preserves the originally declared role-masked bash intent");
    f.pi.getAllTools = async () => { throw new Error("Registry failed"); };
    assert.equal((await f.mod.decideToolCallWithRefresh("read", f.pi)).error.code, "LARVA_TOOL_ENUMERATION_FAILED", "Allowed cached names cannot bypass registry failures");
    f.pi.getAllTools = async () => ["read", "deferred"];
    f.pi.getActiveTools = async () => { throw new Error("Active set failed"); };
    assert.equal((await f.mod.decideToolCallWithRefresh("deferred", f.pi)).action, "deny");
    console.log("live-rollback PASS partial setter rollback uses current Pi state; enumeration errors fail closed");
  },
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
    });
    assert.equal(canonical.result.ok, true);
    assert.deepEqual(canonical.activeTools, ["bash"]);
    console.log("new-path-exists PASS canonical activeTools", JSON.stringify(canonical.activeTools));
  },
  "both-present-conflict": async () => {
    const conflict = await runPolicyCase("both-present-conflict", async (paths) => {
      await writeFile(paths.canonical, JSON.stringify({ personas: { p: { allow: ["bash"] } } }), "utf8");
      await writeFile(paths.legacy, JSON.stringify({ personas: { p: { deny: ["bash"] } } }), "utf8");
    });
    assert.equal(conflict.result.ok, true);
    assert.deepEqual(conflict.activeTools, ["bash"]);
    assert.equal(await exists(conflict.paths.canonical), true);
    assert.equal(await exists(conflict.paths.legacy), true);
    console.log("both-present-conflict PASS runtime uses canonical only without legacy probing", JSON.stringify(conflict.activeTools));
  },
  "old-only-no-env-is-empty": async () => {
    const legacy = await runPolicyCase("old-only-no-env-is-empty", async (paths) => {
      await writeFile(paths.legacy, JSON.stringify({ personas: { p: { deny: ["read"] } } }), "utf8");
    });
    assert.equal(legacy.result.ok, true);
    assert.deepEqual(legacy.activeTools, ["read", "bash"]);
    console.log("old-only-no-env-is-empty PASS legacy ignored activeTools", JSON.stringify(legacy.activeTools));
  },
  "explicit-env-old-path": async () => {
    const explicitLegacy = await runPolicyCase("explicit-env-old-path", async (paths, env) => {
      await writeFile(paths.legacy, JSON.stringify({ personas: { p: { deny: ["read"] } } }), "utf8");
      env.LARVA_PI_TOOL_POLICY_FILE = paths.legacy;
    });
    assert.equal(explicitLegacy.result.ok, true);
    assert.deepEqual(explicitLegacy.activeTools, ["bash"]);
    console.log("explicit-env-old-path PASS explicit legacy activeTools", JSON.stringify(explicitLegacy.activeTools));
  },
  "relative-env-rejected": async () => {
    const relative = await runPolicyCase("relative-env-rejected", async (_paths, env) => {
      env.LARVA_PI_TOOL_POLICY_FILE = "relative-tool-policy.json";
    });
    assert.equal(relative.result.ok, false);
    assert.equal(relative.result.error.code, "LARVA_POLICY_INVALID");
    console.log("relative-env-rejected PASS LARVA_POLICY_INVALID");
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
try {
  if (choice === "all") {
    for (const name of Object.keys(cases)) await cases[name]();
    console.log("tool-policy paths: PASS");
  } else if (cases[choice]) {
    await cases[choice]();
  } else {
    throw new Error(`unknown --case ${choice}`);
  }
} finally {
  for (const dir of fixtureDirs) await rm(dir, { recursive: true, force: true });
}
