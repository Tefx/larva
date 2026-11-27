import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { ACTIVITY_WIRE_MAX_BYTES, utf8ByteLength } from "../../src/core/activity-wire.ts";
import { exitCodeForError, LarvaError, toErrorEnvelope, toSuccessEnvelope } from "../../src/core/errors.ts";
import type { PersonaSpec, RunTextSliceQuery, SubagentPanelToolInput, ThinkingLevel } from "../../src/core/types.ts";
import { admitToolInput, commonToolSchemas, personaSwitchSchema, searchMentionsSchema, subagentPanelSchema } from "../../src/surfaces/tool-schemas.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const schema: object = JSON.parse(readFileSync(join(root, "contracts/persona_spec.schema.json"), "utf8"));
const validate = new Ajv2020({ strict: true }).compile(schema);
const required = { id: "software-engineer", description: "Implements services.", prompt: "Own the outcome.", model: "provider/project/model" };

function accept(doc: unknown) {
  assert.equal(validate(doc), true, JSON.stringify(validate.errors));
}

function reject(doc: unknown) {
  assert.equal(validate(doc), false, `accepted invalid persona: ${JSON.stringify(doc)}`);
}

test("Draft 2020-12 admits minimal and canonical personas at all seven thinking levels", () => {
  accept(required);
  const thinkingLevels = {
    off: true, minimal: true, low: true, medium: true, high: true, xhigh: true, max: true,
  } satisfies Record<ThinkingLevel, true>;
  assert.deepEqual(Object.keys(thinkingLevels), ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  for (const thinking of Object.keys(thinkingLevels) as ThinkingLevel[]) {
    const canonical: PersonaSpec = {
      ...required,
      thinking,
      can_spawn: ["leaf-agent"],
      tools: { allow: ["read", "mcp_*"], deny: ["write", "read"] },
      spec_digest: `sha256:${"a0".repeat(32)}`,
    };
    accept(canonical);
  }
  accept({ ...required, can_spawn: true, tools: {} });
  accept({ ...required, can_spawn: false, tools: { deny: [] } });
  accept({ ...required, can_spawn: Array.from({ length: 100 }, (_, i) => `agent-${i}`) });
});

test("persona admission rejects retired fields, unknown fields, and missing required values", () => {
  for (const [key, value] of Object.entries({ capabilities: {}, model_params: {}, compaction_prompt: "compact", spec_version: "0.1.0", extra: true })) {
    reject({ ...required, [key]: value });
  }
  for (const key of Object.keys(required)) {
    reject(Object.fromEntries(Object.entries(required).filter(([k]) => k !== key)));
  }
  reject([]);
  reject(null);
  for (const [key, value] of [
    ["id", "Mixed-Case"], ["id", "bad--id"], ["id", "good-id\n"],
    ["description", ""], ["description", " \r\n\t"], ["prompt", ""], ["prompt", "\t"],
    ["thinking", "ultra"], ["can_spawn", []], ["can_spawn", ["leaf", "leaf"]], ["can_spawn", ["BAD"]],
    ["can_spawn", Array.from({ length: 101 }, (_, i) => `agent-${i}`)],
  ]) reject({ ...required, [String(key)]: value });
});

test("persona admission rejects malformed model routes, tool patterns, and digests", () => {
  for (const model of ["", "provider", "/model", "provider/", "with space/model", "provider/model\n", "provider/ model", null]) {
    reject({ ...required, model });
  }
  for (const invalid of ["", "*", "read**", "read*more", "read tool", "read\n", "*read"]) {
    reject({ ...required, tools: { allow: [invalid] } });
    reject({ ...required, tools: { deny: [invalid] } });
  }
  reject({ ...required, tools: { allow: ["read", "read"] } });
  reject({ ...required, tools: { deny: ["read", "read"] } });
  reject({ ...required, tools: { unknown: [] } });
  for (const spec_digest of ["", "sha256:abcd", `sha256:${"A".repeat(64)}`, `md5:${"a".repeat(64)}`, `sha256:${"a".repeat(64)}\n`]) {
    reject({ ...required, spec_digest });
  }
});

test("CLI envelopes preserve typed details and map success, domain failure and usage to 0, 1 and 2", () => {
  const error = new LarvaError("LARVA_PERSONA_INVALID", "Invalid persona.", { field: "id" });
  assert.ok(error instanceof Error);
  assert.deepEqual(toSuccessEnvelope({ id: "alice" }), { ok: true, data: { id: "alice" } });
  assert.deepEqual(toErrorEnvelope(error), {
    ok: false, error: { code: "LARVA_PERSONA_INVALID", message: "Invalid persona.", details: { field: "id" } },
  });
  const usage = new LarvaError("LARVA_CLI_USAGE", "Unknown option.");
  assert.deepEqual(toErrorEnvelope(usage), { ok: false, error: { code: "LARVA_CLI_USAGE", message: "Unknown option." } });
  const foreign = new Error("contains local diagnostics");
  assert.deepEqual(toErrorEnvelope(foreign), { ok: false, error: { code: "LARVA_INTERNAL_ERROR", message: "An internal error occurred." } });
  assert.equal(exitCodeForError(), 0);
  assert.equal(exitCodeForError(undefined), 1); // A catch can receive `throw undefined`.
  assert.equal(exitCodeForError(error), 1);
  assert.equal(exitCodeForError(foreign), 1);
  assert.equal(exitCodeForError(usage), 2);
  assert.equal(exitCodeForError(new LarvaError("LARVA_MODEL_UNAVAILABLE", "Startup model unavailable.", undefined, 2)), 2);
});

test("shared tool schemas describe parameters and reject invalid switch, mention and slice inputs", () => {
  for (const schema of [...Object.values(commonToolSchemas), personaSwitchSchema, searchMentionsSchema, subagentPanelSchema]) {
    assert.equal(schema.additionalProperties, false);
    for (const field of Object.values(schema.properties)) assert.ok(field.description);
  }
  assert.equal(personaSwitchSchema.properties.reason.maxLength, 1000);
  assert.throws(() => admitToolInput("larva_persona_switch", personaSwitchSchema,
    { persona_id: "alice", reason: "x".repeat(1001) }), { code: "LARVA_BAD_INPUT" });
  assert.throws(() => admitToolInput("search_mentions", searchMentionsSchema, { query: "alice", path: [""] }),
    { code: "LARVA_BAD_INPUT" });
  assert.deepEqual(admitToolInput("search_mentions", searchMentionsSchema, { query: "", path: ["personas"] }),
    { query: "", path: ["personas"] });
  const slice = { task_id: "/tmp/child.jsonl", run_epoch: "epoch", source: "prompt", offset: 0, length: 4000 } satisfies RunTextSliceQuery;
  assert.deepEqual(admitToolInput<SubagentPanelToolInput>("larva_subagent_panel", subagentPanelSchema, { slice }), { slice });
  assert.deepEqual(admitToolInput("larva_subagent_panel", subagentPanelSchema,
    { slice: { task_id: slice.task_id, source: "output" } }), { slice: { task_id: slice.task_id, source: "output" } });
  for (const changes of [{ offset: -1 }, { length: 0 }, { length: 4001 }, { length: 1.5 }, { source: "timeline" }, { extra: true }]) {
    assert.throws(() => admitToolInput("larva_subagent_panel", subagentPanelSchema, { slice: { ...slice, ...changes } }),
      { code: "LARVA_BAD_INPUT" });
  }
});

test("activity budget measures the final serialized UTF-8 wire, not JS code units", () => {
  const wire = JSON.stringify({ text: "é🔎\n" });
  assert.equal(utf8ByteLength(wire), 19);
  const exact = wire.padEnd(wire.length + ACTIVITY_WIRE_MAX_BYTES - 19);
  assert.equal(utf8ByteLength(exact), 8192);
  assert.equal(utf8ByteLength(exact + "🔎"), 8196);
});

function runBuild(cwd: string, ...args: string[]) {
  const result = spawnSync(process.execPath, ["scripts/build.mjs", ...args], { cwd, encoding: "utf8", timeout: 15_000 });
  assert.ifError(result.error);
  return result;
}

function buildFixture(t: { after: (fn: () => void) => void }) {
  // Keep the fixture inside the worktree and let it resolve this install's esbuild.
  const fixture = mkdtempSync(join(root, "node_modules/.foundation-build-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  mkdirSync(join(fixture, "scripts"));
  copyFileSync(join(root, "scripts/build.mjs"), join(fixture, "scripts/build.mjs"));
  copyFileSync(join(root, "package.json"), join(fixture, "package.json"));
  return {
    path: fixture,
    write(file: string, text: string) {
      const path = join(fixture, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    },
    read(file: string) { return readFileSync(join(fixture, file), "utf8"); },
  };
}

test("build check validates the repository and accepts a tree with no runtime entrypoints", t => {
  const actual = runBuild(root, "--check-only");
  assert.equal(actual.status, 0, actual.stderr);
  const fixture = buildFixture(t);
  const clean = runBuild(fixture.path, "--check-only");
  assert.equal(clean.status, 0, clean.stderr);
  const manifest = JSON.parse(fixture.read("package.json"));
  for (const invalidMetadata of [
    { dependencies: { example: "1.0.0" } },
    { devDependencies: { ...manifest.devDependencies, esbuild: "^0.28.2" } },
  ]) {
    fixture.write("package.json", JSON.stringify({ ...manifest, ...invalidMetadata }));
    const invalid = runBuild(fixture.path, "--check-only");
    assert.equal(invalid.status, 1, invalid.stderr);
    assert.match(invalid.stderr, /package\.json does not match/);
  }
});

test("build check rejects TUI references in headless source, old bundles, and new headless bundles", t => {
  const fixture = buildFixture(t);
  const leak = 'export const dependency = "@earendil-works/pi-tui";\n';
  for (const file of ["src/core/nested/headless.ts", "src/store/index.ts", "src/runtime/index.ts", "src/activity/index.ts", "dist/nested/stale.mjs", "plugins/codex/dist/stale.mjs", "src/mcp-server.ts"]) {
    fixture.write(file, leak);
    const result = runBuild(fixture.path, "--check-only");
    assert.equal(result.status, 1, `${file}: ${result.stderr}`);
    assert.match(result.stderr, /must not reference @earendil-works\/pi-tui/);
    assert.ok(result.stderr.includes(file === "src/mcp-server.ts" ? "dist/mcp-server.mjs" : file));
    rmSync(join(fixture.path, file));
  }
  fixture.write("src/child-rpc-preload.ts", 'export { parse } from "yaml";\n');
  const yamlPreload = runBuild(fixture.path, "--check-only");
  assert.equal(yamlPreload.status, 1, yamlPreload.stderr);
  assert.match(yamlPreload.stderr, /child-rpc-preload\.mjs must not include YAML modules/);
});

test("dist-only and full replace stale bundles, only full updates Codex, and check-only leaves outputs alone", t => {
  const fixture = buildFixture(t);
  const pluginManifest = "plugins/codex/.codex-plugin/plugin.json";
  const packageVersion: string = JSON.parse(fixture.read("package.json")).version;
  fixture.write(pluginManifest, '{"name":"larva","version":"0.0.0"}\n');
  fixture.write("src/pi-extension.ts", 'export { Text } from "@earendil-works/pi-tui";\n');
  fixture.write("src/cli.ts", '#!/usr/bin/env node\nconsole.log(__LARVA_VERSION__);\n');
  fixture.write("src/mcp-server.ts", `
import { format } from "util";
export const version = __LARVA_VERSION__;
const { basename } = require("path");
if (import.meta.main) console.log(format("%s %s", basename(process.argv[1]), version));
`);
  const preloadSource = "src/child-rpc-preload.ts";
  const shared = ["child-rpc-preload.mjs", "mcp-server.mjs", "pi-extension.js"];
  const rootBundles = [...shared, "cli.mjs"].sort();
  const rootStale = "dist/.gitignore";
  const codexStale = "plugins/codex/dist/old.mjs";
  const previous = "previous output\n";
  fixture.write(rootStale, previous);
  fixture.write(codexStale, previous);
  fixture.write("dist/cli.mjs", previous);

  const failed = runBuild(fixture.path);
  assert.equal(failed.status, 1, failed.stderr);
  assert.match(failed.stderr, /child-rpc-preload\.ts/);
  for (const path of [rootStale, codexStale, "dist/cli.mjs"]) assert.equal(fixture.read(path), previous);
  fixture.write(preloadSource, 'export { format } from "node:util";\n');

  const check = runBuild(fixture.path, "--check-only");
  assert.equal(check.status, 0, check.stderr);
  assert.deepEqual(readdirSync(join(fixture.path, "dist")).sort(), [".gitignore", "cli.mjs"]);
  for (const path of [rootStale, codexStale, "dist/cli.mjs"]) assert.equal(fixture.read(path), previous);

  const dist = runBuild(fixture.path, "--dist-only");
  assert.equal(dist.status, 0, dist.stderr);
  assert.deepEqual(readdirSync(join(fixture.path, "dist")).sort(), rootBundles);
  assert.deepEqual(readdirSync(join(fixture.path, "plugins/codex/dist")), ["old.mjs"]);
  assert.equal(fixture.read(codexStale), previous);
  assert.equal(JSON.parse(fixture.read(pluginManifest)).version, "0.0.0");
  const cli = join(fixture.path, "dist/cli.mjs");
  assert.match(fixture.read("dist/cli.mjs"), /^#!\/usr\/bin\/env node\n[^#]/);
  assert.notEqual(statSync(cli).mode & 0o111, 0);
  const invoked = spawnSync(process.execPath, [cli], { encoding: "utf8", timeout: 5_000 });
  assert.ifError(invoked.error);
  assert.equal(invoked.status, 0, invoked.stderr);
  assert.equal(invoked.stdout.trim(), packageVersion);
  assert.match(fixture.read("dist/mcp-server.mjs"), /from "node:util"/);
  const mcpEntry = spawnSync(process.execPath, ["dist/mcp-server.mjs"], { cwd: fixture.path, encoding: "utf8", timeout: 5_000 });
  assert.ifError(mcpEntry.error);
  assert.equal(mcpEntry.status, 0, mcpEntry.stderr);
  assert.equal(mcpEntry.stdout.trim(), `mcp-server.mjs ${packageVersion}`);
  const mcpImport = spawnSync(process.execPath, ["-e", 'import("./dist/mcp-server.mjs")'], {
    cwd: fixture.path, encoding: "utf8", timeout: 5_000,
  });
  assert.ifError(mcpImport.error);
  assert.equal(mcpImport.status, 0, mcpImport.stderr);
  assert.equal(mcpImport.stdout, "");

  fixture.write(rootStale, previous);
  fixture.write("dist/stale.mjs", 'import "@earendil-works/pi-tui";\n');
  const full = runBuild(fixture.path);
  assert.equal(full.status, 0, full.stderr);
  assert.equal(JSON.parse(fixture.read(pluginManifest)).version, packageVersion);
  assert.deepEqual(readdirSync(join(fixture.path, "dist")).sort(), rootBundles);
  assert.deepEqual(readdirSync(join(fixture.path, "plugins/codex/dist")).sort(), [...shared, "package.json"].sort());
  for (const name of shared) assert.equal(fixture.read(`plugins/codex/dist/${name}`), fixture.read(`dist/${name}`));
  assert.deepEqual(JSON.parse(fixture.read("plugins/codex/dist/package.json")), { type: "module" });
  assert.ok(fixture.read("dist/mcp-server.mjs").includes(JSON.stringify(packageVersion)));
  assert.match(fixture.read("dist/pi-extension.js"), /from "@earendil-works\/pi-tui"/);
});
