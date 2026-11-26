import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadLarvaConfig, parseLarvaConfig, resolveWatchdogTimeouts } from "../../src/core/config.ts";
import { LarvaError } from "../../src/core/errors.ts";
import { isValidProfileName, loadModelMap, parseModelMapDoc, resolveModelRoute } from "../../src/core/model-map.ts";
import {
  BASE_PI_AGENT_DIR_ENV, assertContainedRealpath, getLarvaHomePaths, isLexicallyContained, modelMapProfilePath,
  resolveBasePiAgentDir, resolveContainedPath, resolveExtensionSources, resolveLarvaHome,
} from "../../src/core/paths.ts";
import { assertCanSpawnTarget, evaluateEffectiveCanSpawn } from "../../src/core/spawn-policy.ts";
import { composeToolPolicy, evaluateToolInvocation, SPAWN_TOOLS } from "../../src/core/tool-policy.ts";
import type { CanSpawn } from "../../src/core/types.ts";
import { diskModelMapReader, loadDiskModelMap } from "../../src/store/model-map.ts";

async function fixture(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "larva-core-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function entryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function readText(path: string): Promise<string> {
  if (!(await stat(path)).isFile()) throw new Error("Expected a regular file.");
  return readFile(path, "utf8");
}

const readTextIfPresent = async (path: string) => await entryExists(path) ? readText(path) : undefined;
const contained = (root: string, path: string) => resolveContainedPath(root, path, realpath);

test("LARVA_HOME defaults only for unset or empty overrides and derives the managed layout", async () => {
  await fixture(async dir => {
    const home = join(dir, "managed");
    assert.equal(resolveLarvaHome({ HOME: dir }), join(dir, ".larva"));
    assert.equal(resolveLarvaHome({ HOME: dir, LARVA_HOME: "" }), join(dir, ".larva"));
    assert.equal(resolveLarvaHome({ HOME: dir, LARVA_HOME: home }), home);
    for (const value of ["managed", "~/managed", `${dir}/a/../managed`, `${dir}//managed`, `${dir}/\0`]) {
      assert.throws(() => resolveLarvaHome({ HOME: dir, LARVA_HOME: value }), { code: "LARVA_CONFIG_INVALID" });
    }
    assert.deepEqual(getLarvaHomePaths(home), {
      home, personas: join(home, "personas"), config: join(home, "config.json"), model_map: join(home, "model-map.json"),
      state: join(home, "state"), sessions: join(home, "state", "sessions"),
      artifacts: join(home, "state", "artifacts"), capsules: join(home, "state", "capsules"),
    });
    assert.equal(modelMapProfilePath(home, "ci-1"), join(home, "model-map.ci-1.json"));
    assert.equal(modelMapProfilePath(home, "default"), getLarvaHomePaths(home).model_map);
    assert.throws(() => modelMapProfilePath(home, "../escape"), { code: "LARVA_MODEL_MAP_INVALID" });
  });
});

test("base Pi agent config resolves against the supplied host cwd or home", () => {
  const home = join(tmpdir(), "user"), host = join(tmpdir(), "host"), absolute = join(tmpdir(), "absolute");
  const env = { HOME: home, PI_CODING_AGENT_DIR: "agent" };
  assert.equal(resolveBasePiAgentDir(env, undefined, host), join(host, "agent"));
  assert.equal(resolveBasePiAgentDir({ ...env, [BASE_PI_AGENT_DIR_ENV]: "base" }, undefined, host), join(host, "base"));
  assert.equal(resolveBasePiAgentDir({ ...env, [BASE_PI_AGENT_DIR_ENV]: "~/base" }, undefined, host), join(home, "base"));
  assert.equal(resolveBasePiAgentDir({ ...env, PI_CODING_AGENT_DIR: absolute }, undefined, host), absolute);
  assert.equal(resolveBasePiAgentDir({}, home), join(home, ".pi", "agent"));
});

test("session containment rejects apparent siblings and both file and directory symlink escapes", async () => {
  await fixture(async dir => {
    const { sessions } = getLarvaHomePaths(dir);
    const sibling = `${sessions}-other`;
    await mkdir(sessions, { recursive: true });
    await mkdir(sibling);
    const inside = join(sessions, "inside.jsonl");
    const outside = join(sibling, "outside.jsonl");
    await writeFile(inside, "inside");
    await writeFile(outside, "outside");
    const insideLink = join(sessions, "inside-link.jsonl");
    const outsideLink = join(sessions, "outside-link.jsonl");
    const directoryLink = join(sessions, "outside-dir");
    await symlink(inside, insideLink);
    await symlink(outside, outsideLink);
    await symlink(sibling, directoryLink);
    const rootLink = join(dir, "linked-sessions");
    await symlink(sessions, rootLink);

    assert.equal(isLexicallyContained(sessions, inside), true);
    for (const candidate of [sessions, outside, "inside.jsonl", `${sessions}/../sessions-other/outside.jsonl`]) {
      assert.equal(isLexicallyContained(sessions, candidate), false);
    }
    assert.equal(await contained(sessions, insideLink), await realpath(inside));
    assert.equal(await contained(rootLink, join(rootLink, "inside.jsonl")), await realpath(inside));
    for (const escape of [outside, outsideLink, join(directoryLink, "outside.jsonl")]) {
      await assert.rejects(contained(sessions, escape), { code: "LARVA_SESSION_INVALID" });
    }
    assert.throws(() => assertContainedRealpath(sessions, sibling), { code: "LARVA_SESSION_INVALID" });
  });
});

test("extension source resolution supports local directories and each source form", async () => {
  await fixture(async dir => {
    const realHome = join(dir, "managed");
    const larvaHome = join(dir, "linked-home");
    const userHome = join(dir, "home");
    const piAgentDir = join(dir, "base-agent");
    const localFile = join(realHome, "relative.ts"), localDir = join(userHome, "ext"), agent = join(piAgentDir, "agent.ts");
    await mkdir(realHome);
    await symlink(realHome, larvaHome);
    await mkdir(localDir, { recursive: true });
    await mkdir(piAgentDir);
    await writeFile(localFile, "");
    await writeFile(agent, "");
    const schemes = ["builtin:larva", "npm:example", "git:example/repo", "https://example.com/ext.ts"];
    const context = {
      larvaHome, userHome, piAgentDir, realpath,
      async assertReadable(path: string) {
        const target = await stat(path);
        if (!target.isFile() && !target.isDirectory()) throw new Error("Unexpected extension file type.");
        await access(path, target.isDirectory() ? constants.R_OK | constants.X_OK : constants.R_OK);
      },
    };
    assert.deepEqual(await resolveExtensionSources(["relative.ts", "~/ext", "pi-agent:agent.ts", localFile, ...schemes], context),
      [...await Promise.all([localFile, localDir, agent, localFile].map(path => realpath(path))), ...schemes]);
    for (const source of ["missing.ts", "pi-agent:", `pi-agent:${agent}`, "\0"]) {
      await assert.rejects(resolveExtensionSources([source], context), { code: "LARVA_CONFIG_INVALID" });
    }
    assert.deepEqual(await resolveExtensionSources(schemes, { ...context, larvaHome: join(dir, "absent") }), schemes);
  });
});

test("config defaults, allowed endpoints, and closed nested validation", () => {
  assert.deepEqual(parseLarvaConfig({}), {
    default_persona: null, switch_mode: "confirm", confirm_timeout_ms: 900_000,
    subagent: { extension_sources: [], root_session_spawn: "persona", stall_alert_ms: 600_000 },
    gc: { max_age_days: 30 },
  });
  const valid = {
    default_persona: "engineer-1", switch_mode: "free", confirm_timeout_ms: 0,
    subagent: { extension_sources: ["./extension.ts", "npm:example"], root_session_spawn: "allow", max_depth: 1,
      max_active_runs: 100, stall_alert_ms: 86_400_000 },
    gc: { max_age_days: 3650, max_bytes: 1_048_576 },
  };
  assert.deepEqual(parseLarvaConfig(valid), valid);
  for (const value of [null, [], "{}", new Date(), { unknown: true }, { default_persona: "bad--name" },
    { switch_mode: "unknown" }, { confirm_timeout_ms: 999 }, { confirm_timeout_ms: 86_400_001 },
    { subagent: null }, { subagent: { unknown: 1 } }, { subagent: { root_session_spawn: true } },
    { subagent: { extension_sources: ["same", "same"] } }, { subagent: { extension_sources: [""] } },
    { subagent: { extension_sources: [1] } }, { subagent: { max_depth: 0 } }, { subagent: { max_active_runs: 101 } },
    { subagent: { stall_alert_ms: 59_999 } }, { gc: { unknown: 1 } }, { gc: { max_age_days: 1.5 } },
    { gc: { max_age_days: 3651 } }, { gc: { max_bytes: 1_048_575 } }, { gc: { max_bytes: Infinity } }]) {
    assert.throws(() => parseLarvaConfig(value), { code: "LARVA_CONFIG_INVALID" });
  }
});

test("config loader distinguishes absence from invalid bytes, broken links, and read failures", async () => {
  await fixture(async home => {
    const config = getLarvaHomePaths(home).config;
    assert.deepEqual(await loadLarvaConfig(home, readTextIfPresent), parseLarvaConfig({}));
    await writeFile(config, '{"switch_mode":"manual"}');
    assert.equal((await loadLarvaConfig(home, readTextIfPresent)).switch_mode, "manual");
    for (const text of ["{", "null", '"{}"', '{"typo":true}']) {
      await writeFile(config, text);
      await assert.rejects(loadLarvaConfig(home, readTextIfPresent), { code: "LARVA_CONFIG_INVALID" });
    }
    await rm(config);
    await symlink(join(home, "missing"), config);
    await assert.rejects(loadLarvaConfig(home, readTextIfPresent), { code: "LARVA_CONFIG_INVALID" });
    await rm(config);
    await mkdir(config);
    await assert.rejects(loadLarvaConfig(home, readTextIfPresent), { code: "LARVA_CONFIG_INVALID" });
  });
});

test("watchdog clamps inherited stall alerts but validates explicit alerts against the effective hard deadline", () => {
  const defaults = parseLarvaConfig({}).subagent;
  assert.deepEqual(resolveWatchdogTimeouts({}, defaults), { no_progress_timeout_ms: 3_600_000, stall_alert_ms: 600_000 });
  assert.deepEqual(resolveWatchdogTimeouts({ no_progress_timeout_ms: 120_001 }, defaults),
    { no_progress_timeout_ms: 120_001, stall_alert_ms: 60_000 });
  assert.equal(resolveWatchdogTimeouts({ no_progress_timeout_ms: 120_000 }, { stall_alert_ms: 0 }).stall_alert_ms, 0);
  assert.equal(resolveWatchdogTimeouts({ no_progress_timeout_ms: 240_000 }, { stall_alert_ms: 60_000 }).stall_alert_ms, 60_000);
  for (const stall_alert_ms of [0, 60_000, 119_999]) {
    assert.equal(resolveWatchdogTimeouts({ no_progress_timeout_ms: 120_000, stall_alert_ms }, defaults).stall_alert_ms, stall_alert_ms);
  }
  for (const stall_alert_ms of [1, 60_000.5, 120_000, 120_001]) {
    assert.throws(() => resolveWatchdogTimeouts({ no_progress_timeout_ms: 120_000, stall_alert_ms }, defaults),
      { code: "LARVA_BAD_INPUT" });
  }
  for (const no_progress_timeout_ms of [119_999, 120_000.5, 86_400_001, NaN]) {
    assert.throws(() => resolveWatchdogTimeouts({ no_progress_timeout_ms }, defaults), { code: "LARVA_BAD_INPUT" });
  }
});

test("model-map validation and precedence: exact key, longest prefix, then split the literal route once", () => {
  const broad = { from_prefix: "old/", to_provider: "broad", to_model_id_prefix: "all/" };
  const narrow = { from_prefix: "old/group/", to_provider: "narrow", to_model_id_prefix: "" };
  const exact = { provider: "exact", model_id: "pinned" };
  for (const prefix_rules of [[broad, narrow], [narrow, broad]]) {
    const map = parseModelMapDoc({ models: { "old/group/pinned": exact }, prefix_rules });
    assert.deepEqual(resolveModelRoute("old/group/pinned", map), exact);
    assert.deepEqual(resolveModelRoute("old/group/new/model", map), { provider: "narrow", model_id: "new/model" });
    assert.deepEqual(resolveModelRoute("old/new", map), { provider: "broad", model_id: "all/new" });
    assert.deepEqual(resolveModelRoute("other/group/model", map), { provider: "other", model_id: "group/model" });
  }
  const own = parseModelMapDoc({ models: { ["__proto__"]: exact } });
  assert.deepEqual(resolveModelRoute("__proto__", own), exact);
  assert.throws(() => resolveModelRoute("constructor", own), { code: "LARVA_BAD_INPUT" });
  for (const value of [undefined, null, [], { unknown: true }, { models: [] }, { models: { "a b": exact } },
    { models: { model: { ...exact, extra: true } } }, { models: { model: { ...exact, provider: "" } } },
    { models: { model: { ...exact, model_id: "a\nb" } } }, { prefix_rules: {} }, { prefix_rules: [broad, broad] },
    { prefix_rules: [{ ...narrow, from_prefix: "" }] }, { prefix_rules: [{ ...narrow, to_model_id_prefix: " " }] },
    { prefix_rules: [{ ...narrow, to_provider: "a b" }] }, { prefix_rules: [{ ...narrow, unknown: 1 }] }]) {
    assert.throws(() => parseModelMapDoc(value), { code: "LARVA_MODEL_MAP_INVALID" });
  }
  assert.equal(isValidProfileName("test-001"), true);
  for (const profile of [null, "", "default", "UPPER", "../escape", "nested/profile", "test\n"]) {
    assert.equal(isValidProfileName(profile), false);
  }
});

test("model-map loading prefers the selected file and rejects external and dangling symlinks", async () => {
  await fixture(async dir => {
    const home = join(dir, "managed");
    await mkdir(home);
    const paths = getLarvaHomePaths(home);
    const named = modelMapProfilePath(home, "ci");
    const outside = join(dir, "outside.json");
    const internal = join(home, "internal.json");
    const invalid = { code: "LARVA_MODEL_MAP_INVALID" };
    assert.equal(await loadDiskModelMap(home, paths.model_map), undefined);
    await assert.rejects(loadDiskModelMap(home, named), invalid);
    await writeFile(paths.model_map, "{}");
    assert.deepEqual(await loadDiskModelMap(home, paths.model_map), {});
    await assert.rejects(loadDiskModelMap(home, named), invalid);
    const selected = { models: { "literal/model": { provider: "mapped", model_id: "route" } } };
    await writeFile(internal, JSON.stringify(selected));
    await symlink(internal, named);
    assert.deepEqual(await loadDiskModelMap(home, named), selected);
    const homeLink = join(dir, "alias");
    await symlink(home, homeLink);
    assert.deepEqual(await loadModelMap(homeLink, modelMapProfilePath(homeLink, "ci"), diskModelMapReader(homeLink)), selected);
    await writeFile(outside, "{}");
    for (const target of [paths.model_map, named]) {
      await rm(target);
      await symlink(outside, target);
      await assert.rejects(loadDiskModelMap(home, target), invalid);
    }
    await rm(outside);
    for (const target of [paths.model_map, named]) await assert.rejects(loadDiskModelMap(home, target), invalid);
  });
});

test("disk model-map loading bounds bytes and rejects malformed UTF-8 and non-regular entries", async () => {
  await fixture(async home => {
    const path = modelMapProfilePath(home);
    const exact = "{}".padEnd(1_048_576);
    await writeFile(path, exact);
    assert.deepEqual(await loadDiskModelMap(home, path), {});
    const invalidUtf8 = Buffer.from('{"models":{"x":{"provider":"ÿ","model_id":"y"}}}', "latin1");
    for (const text of [exact + " ", invalidUtf8, "false"]) {
      await writeFile(path, text);
      await assert.rejects(loadDiskModelMap(home, path), { code: "LARVA_MODEL_MAP_INVALID" });
    }
    await rm(path);
    await mkdir(path);
    await assert.rejects(loadDiskModelMap(home, path), { code: "LARVA_MODEL_MAP_INVALID" });
  });
});

test("native tool visibility and stale invocations share the ordered policy", () => {
  const subagents = ["larva_subagent", "larva_subagent_wait", "larva_subagent_status", "larva_subagent_activity", "larva_subagent_cancel"];
  assert.deepEqual(SPAWN_TOOLS, new Set(subagents));
  const switchTool = "larva_persona_switch";
  const peer = "larva_subagent_peer_grammar";
  const baseline = ["read", "reader", "write", "larva_personas", switchTool, ...subagents, peer];
  const filtered = { tools: { allow: ["read", "larva_*"], deny: ["larva_subagent_s*", "larva_personas"] } };
  const unrestricted = { tools: { allow: [], deny: [] } };
  const base = { activePersona: filtered, isLaunchedChild: false, switchMode: "confirm", effectiveCanSpawn: true } as const;
  const expected = ["read", switchTool, ...subagents.filter(tool => tool !== "larva_subagent_status"), peer];
  assert.deepEqual(composeToolPolicy(baseline, base), expected);
  assert.deepEqual(composeToolPolicy(baseline, { ...base, isLaunchedChild: true }), expected.filter(tool => tool !== switchTool));
  assert.deepEqual(composeToolPolicy(baseline, { ...base, switchMode: "manual" }), expected.filter(tool => tool !== switchTool));
  assert.deepEqual(composeToolPolicy(baseline, { ...base, effectiveCanSpawn: false, switchMode: "manual" }), ["read", peer]);
  assert.deepEqual(evaluateToolInvocation(peer, baseline, { ...base, effectiveCanSpawn: false }), { action: "allow" });
  assert.deepEqual(composeToolPolicy(baseline, { ...base, activePersona: unrestricted, effectiveCanSpawn: ["target"] }), baseline);
  for (const tool of baseline) {
    assert.equal(evaluateToolInvocation(tool, baseline, base).action, expected.includes(tool) ? "allow" : "deny");
  }
  function expectDenial(tool: string, context: Parameters<typeof evaluateToolInvocation>[2], code: string): void {
    const result = evaluateToolInvocation(tool, baseline, context);
    assert.equal(result.action, "deny");
    assert.ok(result.error instanceof LarvaError);
    assert.equal(result.error.code, code);
  }
  expectDenial("larva_undefined", base, "LARVA_TOOL_DENIED");
  expectDenial(switchTool, { ...base, switchMode: "manual" }, "LARVA_TOOL_DENIED");
  expectDenial(switchTool, { ...base, isLaunchedChild: true }, "LARVA_TOOL_DENIED");
  for (const tool of subagents) {
    expectDenial(tool, { ...base, activePersona: unrestricted, effectiveCanSpawn: false }, "LARVA_SPAWN_NOT_ALLOWED");
    expectDenial(tool, { ...base, activePersona: null, effectiveCanSpawn: false }, "LARVA_NO_ACTIVE_PERSONA");
    expectDenial(tool, { ...base, activePersona: null, isLaunchedChild: true, effectiveCanSpawn: false }, "LARVA_SPAWN_NOT_ALLOWED");
  }
  expectDenial("larva_subagent_status", { ...base, effectiveCanSpawn: false }, "LARVA_TOOL_DENIED");
  assert.deepEqual(evaluateToolInvocation(switchTool, baseline, { ...base, activePersona: null, effectiveCanSpawn: false }),
    { action: "allow" });
});

test("spawn authority truth table covers native root, external MCP root, and both descendant surfaces", () => {
  const caps = new Map<string, CanSpawn>([["blocked", false], ["open", true], ["scoped", ["target"]]]);
  const resolvePersona = (id: string) => {
    const can_spawn = caps.get(id);
    return can_spawn === undefined ? undefined : { can_spawn };
  };
  const pi = { surface: "pi", isLaunchedChild: false, activePersona: null, rootSessionSpawn: "persona", resolvePersona } as const;
  for (const rootSessionSpawn of ["persona", "allow"] as const) {
    assert.equal(evaluateEffectiveCanSpawn({ ...pi, rootSessionSpawn }), false);
    for (const can_spawn of caps.values()) {
      assert.deepEqual(evaluateEffectiveCanSpawn({ ...pi, rootSessionSpawn, activePersona: { can_spawn } }),
        rootSessionSpawn === "allow" && can_spawn === false ? true : can_spawn);
    }
  }
  const mcp = { surface: "mcp", depth: 0, resolvePersona } as const;
  assert.equal(evaluateEffectiveCanSpawn(mcp), true);
  assert.equal(evaluateEffectiveCanSpawn({ ...mcp, env: { LARVA_MCP_PARENT_PERSONA: "  " } }), true);
  for (const [parent_persona_id, cap] of caps) {
    assert.deepEqual(evaluateEffectiveCanSpawn({ ...mcp, parent_persona_id, env: { LARVA_MCP_PARENT_PERSONA: "unknown" } }), cap);
    assert.deepEqual(evaluateEffectiveCanSpawn({ ...mcp, env: { LARVA_MCP_PARENT_PERSONA: ` ${parent_persona_id} ` } }), cap);
  }
  assert.throws(() => evaluateEffectiveCanSpawn({ ...mcp, parent_persona_id: "", env: { LARVA_MCP_PARENT_PERSONA: "open" } }),
    { code: "LARVA_BAD_INPUT" });
  assert.throws(() => evaluateEffectiveCanSpawn({ ...mcp, parent_persona_id: "missing", env: { LARVA_MCP_PARENT_PERSONA: "open" } }),
    { code: "LARVA_PERSONA_NOT_FOUND" });
  for (const child of [
    { ...pi, isLaunchedChild: true, activePersona: { can_spawn: true }, rootSessionSpawn: "allow" } as const,
    { ...mcp, depth: 1 }, { ...mcp, depth: 10 },
  ]) {
    for (const [id, cap] of caps) {
      const env = { LARVA_PI_INITIAL_PERSONA_ID: id, LARVA_MCP_PARENT_PERSONA: "unknown" };
      assert.deepEqual(evaluateEffectiveCanSpawn({ ...child, env }), cap);
      assert.deepEqual(evaluateEffectiveCanSpawn({ ...child, env, parent_persona_id: id }), cap);
      assert.throws(() => evaluateEffectiveCanSpawn({ ...child, env, parent_persona_id: "conflict" }),
        { code: "LARVA_SPAWN_NOT_ALLOWED" });
    }
    for (const initial of [undefined, "", "unknown"]) {
      assert.throws(() => evaluateEffectiveCanSpawn({ ...child, env: {
        LARVA_PI_INITIAL_PERSONA_ID: initial, LARVA_MCP_PARENT_PERSONA: "open",
      } }), { code: "LARVA_SPAWN_NOT_ALLOWED" });
    }
  }
  assert.doesNotThrow(() => assertCanSpawnTarget(true, "other"));
  assert.doesNotThrow(() => assertCanSpawnTarget(["target"], "target"));
  for (const cap of [false, ["target"]] satisfies CanSpawn[]) {
    assert.throws(() => assertCanSpawnTarget(cap, "other"), { code: "LARVA_SPAWN_NOT_ALLOWED" });
  }
});
