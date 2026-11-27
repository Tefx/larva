import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { CliJsonEnvelope } from "../../src/core/errors.ts";
import type { DoctorReport, GcReport, PersonaSpec, PersonaSummary } from "../../src/core/types.ts";
import { loadDiskModelMap } from "../../src/store/model-map.ts";
import { dispatchCli } from "../../src/surfaces/cli-commands.ts";
import { runDoctor } from "../../src/surfaces/doctor.ts";

const npmBin = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const day = 86_400_000;
const baseModel = "fixture-provider/team/model";

function persona(id: string, model = baseModel) {
  return { id, description: `Role for ${id}`, model, prompt: `Help ${id} at the café.` };
}

async function writeJson(path: string, value: unknown) {
  await writeFile(path, JSON.stringify(value));
}

async function fixture(use: (setup: {
  root: string; home: string; agent: string; env: NodeJS.ProcessEnv;
}) => Promise<void>) {
  const temporary = await mkdtemp(join(tmpdir(), "larva-cli-"));
  try {
    const root = await realpath(temporary);
    const home = join(root, "larva");
    const agent = join(root, ".pi", "agent");
    await mkdir(home);
    await mkdir(agent, { recursive: true });
    await use({ root, home, agent, env: { LARVA_HOME: home, HOME: root, PI_CODING_AGENT_DIR: agent, PATH: npmBin } });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

type DispatchOptions = Partial<Parameters<typeof dispatchCli>[1]>;

async function invoke(args: string[], env: NodeJS.ProcessEnv, options: DispatchOptions = {}) {
  let stdout = "";
  let stderr = "";
  const exit = await dispatchCli(args, {
    env,
    runMcp: () => assert.fail("Unexpected MCP dispatch"),
    stdout: { write: value => { stdout += value; } },
    stderr: { write: value => { stderr += value; } },
    version: "2.3.4",
    ...options,
  });
  return { exit, stdout, stderr };
}

async function json<T>(args: string[], env: NodeJS.ProcessEnv, exit = 0, options: DispatchOptions = {}) {
  const result = await invoke([...args, "--json"], env, options);
  assert.equal(result.stderr, "");
  assert.equal(result.exit, exit, result.stdout);
  const envelope: CliJsonEnvelope<T> = JSON.parse(result.stdout);
  return envelope;
}

async function success<T>(args: string[], env: NodeJS.ProcessEnv, options?: DispatchOptions): Promise<T> {
  const envelope = await json<T>(args, env, 0, options);
  assert.equal(envelope.ok, true);
  assert.deepEqual(Object.keys(envelope).sort(), ["data", "ok"]);
  return envelope.data;
}

async function failure(args: string[], env: NodeJS.ProcessEnv, exit: number, code: string, options?: DispatchOptions) {
  const envelope = await json(args, env, exit, options);
  assert.equal(envelope.ok, false);
  assert.deepEqual(Object.keys(envelope).sort(), ["error", "ok"]);
  assert.equal(envelope.error.code, code);
  return envelope.error;
}

function stdin(...chunks: (string | Uint8Array)[]) {
  return (async function* () { yield* chunks; })();
}

async function registry(agent: string) {
  await writeJson(join(agent, "models.json"), { providers: { "fixture-provider": {
    baseUrl: "https://id.example.com", api: "openai-completions", models: [{ id: "team/model" }],
  } } });
}

test("persona validates and installs file and directory inputs; get and list project canonical data", async () => {
  await fixture(async ({ root, home, env }) => {
    const input = join(root, "input");
    await mkdir(input);
    const bob = join(input, "bob.json");
    await writeJson(bob, persona("bob"));
    const aliceMd = join(input, "alice.md");
    const aliceJson = join(root, "alice.json");
    await writeFile(aliceMd, "---\n? description\n: Role for alice\n? 'model'\n: fixture-provider/team/model\n---\nHelp alice.\n");
    await writeJson(aliceJson, { ...persona("alice"), prompt: "Help alice." });
    const [alice] = await success<PersonaSpec[]>(["persona", "validate", aliceJson], env);
    assert.deepEqual(await success(["persona", "validate", aliceMd], env), [alice]);
    const validated = await success<PersonaSpec[]>(["persona", "validate", bob], env);
    assert.deepEqual(validated.map(item => item.id), ["bob"]);
    assert.match(validated[0].spec_digest, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(await readdir(home), []);
    assert.deepEqual((await success<PersonaSpec[]>(["persona", "validate", input], env)).map(item => item.id), ["alice", "bob"]);
    assert.deepEqual(await success(["persona", "put", bob], env), { committed_ids: ["bob"], pruned_ids: [] });
    assert.deepEqual(await success(["persona", "get", "bob"], env), validated[0]);
    assert.deepEqual(await success(["persona", "put", input], env), { committed_ids: ["alice", "bob"], pruned_ids: [] });
    assert.deepEqual(await success(["persona", "get", "alice"], env), alice);

    const summaries = await success<PersonaSummary[]>(["persona", "list"], env);
    assert.deepEqual(summaries.map(item => item.id), ["alice", "bob"]);
    assert.ok(summaries.every(item => !("prompt" in item) && !("tools" in item)));
    const full = await success<PersonaSpec[]>(["persona", "list", "--query", "ALICE", "--full"], env);
    assert.deepEqual(full.map(item => [item.id, item.prompt, item.tools]), [["alice", "Help alice.", { allow: [], deny: [] }]]);

    // An invalid sibling must stop a directory put before either replacing or pruning anything.
    await writeFile(join(input, "carol.json"), "not JSON");
    await writeJson(bob, { ...persona("bob"), prompt: "changed" });
    await failure(["persona", "put", input, "--prune"], env, 1, "LARVA_PERSONA_INVALID");
    assert.deepEqual(await success(["persona", "get", "bob"], env), validated[0]);
  });
});

test("persona puts and reads accept exactly 1 MiB and reject oversized persona files before commit", async () => {
  await fixture(async ({ root, home, env }) => {
    const input = join(root, "alice.json");
    const text = JSON.stringify(persona("alice"));
    const exact = text.padEnd(text.length + 1_048_576 - Buffer.byteLength(text));
    await writeFile(input, exact);
    await success(["persona", "put", input], env);
    assert.equal((await success<PersonaSpec>(["persona", "get", "alice"], env)).id, "alice");
    await writeFile(input, exact + " ");
    await failure(["persona", "put", input], env, 1, "LARVA_PERSONA_INVALID");
    const installed = join(home, "personas", "alice.json");
    assert.equal(await readFile(installed, "utf8"), exact);
    await writeFile(installed, exact + " ");
    await failure(["persona", "get", "alice"], env, 1, "LARVA_PERSONA_INVALID");
  });
});

test("persona stdin preserves split UTF-8, prune requires a directory, and rm prechecks every ID", async () => {
  await fixture(async ({ root, home, env }) => {
    const bob = persona("bob");
    const bytes = Buffer.from(JSON.stringify(bob));
    const split = bytes.indexOf(0xc3) + 1;
    const validated = await success<PersonaSpec[]>(["persona", "validate", "-"], env, {
      stdin: stdin(bytes.subarray(0, split), bytes.subarray(split)),
    });
    assert.equal(validated[0].prompt, bob.prompt);
    const markdown = "---\nid: bob\ndescription: Role for bob\nmodel: fixture-provider/team/model\n---\nHelp bob at the café.\n";
    await success(["persona", "put", "-"], env, { stdin: stdin(markdown) });
    assert.deepEqual(await success(["persona", "get", "bob"], env), validated[0]);
    await failure(["persona", "validate", "-"], env, 1, "LARVA_PERSONA_INVALID", { stdin: stdin(Buffer.from([0xff])) });
    await failure(["persona", "put", "-", "--prune"], env, 1, "LARVA_BAD_INPUT", {
      stdin: { [Symbol.asyncIterator]() { return assert.fail("Prune must not try to read stdin"); } },
    });

    const input = join(root, "input");
    await mkdir(input);
    const alice = join(input, "alice.json");
    await writeJson(alice, persona("alice"));
    await writeJson(join(input, "carol.json"), persona("carol"));
    await failure(["persona", "put", alice, "--prune"], env, 1, "LARVA_BAD_INPUT");
    assert.deepEqual(await success(["persona", "put", input, "--prune"], env), {
      committed_ids: ["alice", "carol"], pruned_ids: ["bob"],
    });
    await failure(["persona", "rm", "alice", "missing"], env, 1, "LARVA_PERSONA_NOT_FOUND");
    assert.deepEqual((await readdir(join(home, "personas"))).sort(), ["alice.json", "carol.json"]);
    await writeFile(join(home, "personas", "alice.md"), "conflicting format");
    assert.deepEqual(await success(["persona", "rm", "alice", "carol"], env), { removed_ids: ["alice", "carol"] });
    assert.deepEqual(await readdir(join(home, "personas")), []);
  });
});

test("doctor checks the selected profile against the real Pi catalog and stays read-only", async () => {
  await fixture(async ({ root, home, agent, env }) => {
    const personas = join(home, "personas");
    await mkdir(personas);
    const installed = join(personas, "alice.json");
    const literal = persona("alice");
    await writeJson(installed, literal);
    await registry(agent);
    const initial = await success<DoctorReport>(["doctor"], env);
    assert.deepEqual(initial, {
      ok: true, larva_home: home, profile: "default", personas_checked: 1, diagnostics: [],
      pi: { path: await realpath(join(npmBin, "pi")), version: "1.6.1" },
    });

    // Only the second Persona needs mapping. A successful profile must check both.
    const bobPath = join(personas, "bob.json");
    const bob = persona("bob", "alias/team/model");
    await writeJson(bobPath, bob);
    await failure(["doctor"], env, 1, "LARVA_MODEL_UNAVAILABLE");
    const defaultMap = join(home, "model-map.json");
    const profileMap = join(home, "model-map.ci.json");
    await writeJson(defaultMap, { models: { [bob.model]: { provider: "fixture-provider", model_id: "missing" } } });
    const prefixMap = { prefix_rules: [{ from_prefix: "alias/", to_provider: "fixture-provider", to_model_id_prefix: "" }] };
    await writeJson(profileMap, prefixMap);
    const passing = await success<DoctorReport>(["doctor", "--profile", "ci"], env);
    assert.deepEqual(passing, { ...initial, profile: "ci", personas_checked: 2 });
    assert.deepEqual(await loadDiskModelMap(home, profileMap), prefixMap);

    const inside = join(home, "routes.json");
    const outside = join(root, "routes.json");
    await writeJson(inside, prefixMap);
    await writeJson(outside, prefixMap);
    await rm(profileMap);
    await symlink(inside, profileMap);
    assert.deepEqual(await loadDiskModelMap(home, profileMap), prefixMap);
    assert.deepEqual(await runDoctor({ env, profile: "ci" }), passing);
    await rm(profileMap);
    await symlink(outside, profileMap);
    for (const dangling of [false, true]) {
      if (dangling) await rm(outside);
      await assert.rejects(loadDiskModelMap(home, profileMap), { code: "LARVA_MODEL_MAP_INVALID" });
      const report = await runDoctor({ env, profile: "ci" });
      assert.equal(report.ok, false);
      assert.deepEqual(report.diagnostics.map(({ code, path }) => [code, path]), [["LARVA_MODEL_MAP_INVALID", profileMap]]);
    }
    await rm(profileMap);
    await rm(inside);
    await writeJson(profileMap, prefixMap);
    await failure(["doctor"], env, 1, "LARVA_MODEL_UNAVAILABLE");
    await writeJson(defaultMap, prefixMap);
    assert.equal((await runDoctor({ env })).ok, true);
    const missing = await failure(["doctor", "--profile", "missing"], env, 1, "LARVA_MODEL_MAP_INVALID");
    const missingReport = await runDoctor({ env, profile: "missing" });
    assert.deepEqual(missing.details, missingReport);
    assert.deepEqual(missingReport.diagnostics.map(item => item.path), [join(home, "model-map.missing.json")]);
    assert.deepEqual((await readdir(home)).sort(), ["model-map.ci.json", "model-map.json", "personas"]);
    assert.deepEqual((await readdir(agent)).sort(), ["models.json"]);
    assert.equal(await readFile(installed, "utf8"), JSON.stringify(literal));
    assert.equal(await readFile(bobPath, "utf8"), JSON.stringify(bob));
  });
});

test("doctor uses the base Pi catalog instead of the capsule and expands tilde paths against its supplied HOME", async () => {
  await fixture(async ({ home, agent, env }) => {
    await mkdir(join(home, "personas"));
    await writeJson(join(home, "personas", "alice.json"), persona("alice"));
    await registry(agent);
    const capsule = { ...env, PI_CODING_AGENT_DIR: "~/capsule/agent", LARVA_PI_BASE_AGENT_DIR: "~/.pi/agent" };
    assert.equal((await success<DoctorReport>(["doctor"], capsule)).personas_checked, 1);
    await failure(["doctor"], { ...capsule, LARVA_PI_BASE_AGENT_DIR: undefined }, 1, "LARVA_MODEL_UNAVAILABLE");
    assert.equal((await success<DoctorReport>(["doctor"], { ...env, PI_CODING_AGENT_DIR: "~/.pi/agent" })).ok, true);
  });
});

test("doctor reports broken and conflicting personas, bad config, malformed unselected maps, and symlinks", async () => {
  await fixture(async ({ home, agent, env }) => {
    const personas = join(home, "personas");
    await mkdir(personas);
    await registry(agent);
    await writeJson(join(personas, "alice.json"), persona("alice", "missing/model"));
    await writeFile(join(personas, "broken.json"), "{");
    await writeJson(join(personas, "conflict.json"), persona("conflict"));
    await writeFile(join(personas, "conflict.md"), "---\n");
    const config = join(home, "config.json");
    const invalidMap = join(home, "model-map.invalid.json");
    const syntaxMap = join(home, "model-map.syntax.json");
    const badName = join(home, "model-map.BAD.json");
    const emptyName = join(home, "model-map..json");
    const link = join(home, "model-map.link.json");
    const defaultLink = join(home, "model-map.json");
    const selected = join(home, "model-map.ci.json");
    await symlink(join(home, "missing-config"), config);
    await writeJson(invalidMap, { unknown: true });
    await writeFile(syntaxMap, "{");
    for (const path of [badName, emptyName, selected]) await writeJson(path, {});
    await symlink(selected, link);
    await symlink(join(home, "missing-map"), defaultLink);

    const report = await runDoctor({ env, profile: "ci" });
    assert.equal(report.ok, false);
    assert.equal(report.personas_checked, 1);
    assert.deepEqual(report.diagnostics.filter(item => item.code === "LARVA_MODEL_MAP_INVALID").map(item => item.path).sort(),
      [badName, defaultLink, emptyName, invalidMap, syntaxMap].sort());
    assert.deepEqual(report.diagnostics.filter(item => item.persona_id).map(item => [item.persona_id, item.code]), [
      ["broken", "LARVA_PERSONA_INVALID"], ["conflict", "LARVA_PERSONA_CONFLICT"], ["alice", "LARVA_MODEL_UNAVAILABLE"],
    ]);
    assert.deepEqual((await failure(["doctor", "--profile", "ci"], env, 1, "LARVA_CONFIG_INVALID")).details, report);
  });
});

test("doctor rejects invalid home and named profile and reports an unavailable Pi installation", async () => {
  await fixture(async ({ home, env }) => {
    const invalidHome = { ...env, LARVA_HOME: "relative" };
    const report = await runDoctor({ env: invalidHome });
    assert.equal(report.larva_home, "");
    assert.equal(report.ok, false);
    assert.deepEqual(report.diagnostics.map(item => item.code), ["LARVA_CONFIG_INVALID"]);
    assert.deepEqual((await failure(["doctor"], invalidHome, 1, "LARVA_CONFIG_INVALID")).details, report);
    for (const profile of ["default", "../outside"]) await failure(["doctor", "--profile", profile], env, 1, "LARVA_MODEL_MAP_INVALID");
    const noPi = await runDoctor({ env: { ...env, PATH: "", LARVA_PI_CLI_SCRIPT: join(home, "missing-pi") } });
    assert.equal(noPi.pi, null);
    assert.deepEqual(noPi.diagnostics.map(item => item.code), ["LARVA_CHILD_START_FAILED"]);
    assert.deepEqual(await readdir(home), []);
  });
});

test("gc previews age and budget evictions then commits the same eligible deletions", async () => {
  await fixture(async ({ home, env }) => {
    const state = join(home, "state");
    const sessions = join(state, "sessions");
    const artifacts = join(state, "artifacts");
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    await mkdir(artifacts);
    const expired = join(sessions, "expired.jsonl");
    const excess = join(artifacts, "excess.txt");
    const recent = join(artifacts, "recent.txt");
    await writeFile(expired, "old");
    await writeFile(excess, Buffer.alloc(1_048_576));
    await writeFile(recent, "recent");
    const now = Date.now();
    const old = new Date(now - 4 * day);
    const over24Hours = new Date(now - 2 * day);
    await utimes(expired, old, old);
    await utimes(excess, over24Hours, over24Hours);
    await writeJson(join(home, "config.json"), { gc: { max_age_days: 5 } });
    const defaults = await success<GcReport>(["gc", "--dry-run"], env);
    assert.equal(defaults.deleted_sessions + defaults.deleted_artifacts, 0);
    const flags = ["--max-age", "3", "--max-bytes", "1048576"];
    const preview = await success<GcReport>(["gc", ...flags, "--dry-run"], env);
    assert.deepEqual(preview, {
      deleted_sessions: 1, deleted_artifacts: 1, freed_bytes: 1_048_579, remaining_bytes: 6, protected_bytes: 6,
      budget_met: true, unreconciled_capsules: [],
    });
    assert.deepEqual(await readdir(sessions), ["expired.jsonl"]);
    assert.equal((await lstat(excess)).size, 1_048_576);
    assert.deepEqual(await success(["gc", ...flags], env), preview);
    assert.deepEqual(await readdir(sessions), []);
    assert.deepEqual(await readdir(artifacts), ["recent.txt"]);
  });
});

test("CLI rejects invalid argument shapes with usage status and keeps MCP stdout protocol-only", async () => {
  await fixture(async ({ home, env }) => {
    const usageCases = [
      ["persona", "validate"], ["persona", "get", "alice", "extra"], ["persona", "rm"],
      ["persona", "list", "--prune"], ["persona", "list", "--full", "--full"],
      ["persona", "put", "--unknown", "-"], ["doctor", "ignore-me"], ["doctor", "--profile"],
      ["gc", "--max-age", "1.5"], ["gc", "--max-bytes", "9007199254740992"],
    ];
    for (const args of usageCases) await failure(args, env, 2, "LARVA_CLI_USAGE");
    await failure(["gc", "--max-age", "0"], env, 1, "LARVA_CONFIG_INVALID");
    await failure(["gc", "--max-bytes", "1024"], env, 1, "LARVA_CONFIG_INVALID");
    assert.deepEqual(await readdir(home), []);

    let calls = 0;
    const mcp = { runMcp: async () => { calls++; return 1; } };
    for (const arg of ["--json", "--unknown", "--help", "extra"]) {
      const invalid = await invoke(["mcp", arg], env, mcp);
      assert.equal(invalid.exit, 2);
      assert.equal(invalid.stdout, "");
      assert.match(invalid.stderr, /^LARVA_CLI_USAGE:/);
    }
    assert.equal(calls, 0);
    assert.deepEqual(await invoke(["mcp"], env, mcp), { exit: 1, stdout: "", stderr: "" });
    assert.equal(calls, 1);
    assert.deepEqual(await invoke(["mcp"], env, { runMcp: () => {} }), { exit: 0, stdout: "", stderr: "" });

    for (const flag of ["--version", "-v"]) {
      assert.deepEqual(await invoke([flag], env), { exit: 0, stdout: "2.3.4\n", stderr: "" });
    }
    const sourceVersion = await invoke(["--version"], env, { version: undefined });
    assert.equal(sourceVersion.exit, 0);
    assert.equal(sourceVersion.stderr, "");
    assert.match(sourceVersion.stdout, /^\d+\.\d+\.\d+\n$/);
    for (const args of [[], ["--help"], ["-h"]]) {
      const help = await invoke(args, env);
      assert.equal(help.exit, 0);
      assert.equal(help.stderr, "");
      assert.match(help.stdout, /larva doctor \[--profile <name>\] \[--json\]/);
    }
  });
});
