import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { LarvaError } from "../../src/core/errors.ts";
import { getLarvaHomePaths, resolveLarvaHome } from "../../src/core/paths.ts";
import { readArtifactSlice, readRunTextSlice, writeOutputSnapshot } from "../../src/store/artifacts.ts";
import { PersonaStore } from "../../src/store/persona-store.ts";

function json(id: string, prompt = "Private instructions", description = `Persona ${id}`): string {
  return JSON.stringify({ id, description, model: "example/model", prompt });
}

function markdown(prompt = "Private instructions", explicitId?: string): string {
  return `---\n${explicitId === undefined ? "" : `id: ${explicitId}\n`}description: Example Persona\nmodel: example/model\n---\n${prompt}\n`;
}

async function fixture(run: (home: string, store: PersonaStore, personas: string, sources: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "larva-personas-artifacts-"));
  try {
    const home = resolveLarvaHome({ LARVA_HOME: join(root, "home") });
    const { personas } = getLarvaHomePaths(home);
    const sources = join(root, "sources");
    await mkdir(personas, { recursive: true });
    await mkdir(sources);
    await run(home, new PersonaStore(home), personas, sources);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function assertPartial(committed_ids: string[], pruned_ids: string[], failed_id: string) {
  return (error: unknown) => {
    assert.ok(error instanceof LarvaError);
    assert.equal(error.code, "LARVA_STORE_WRITE_FAILED");
    assert.deepEqual(error.details, { committed_ids, pruned_ids, failed_id });
    return true;
  };
}

test("get isolates broken siblings; list diagnoses conflicts and only returns valid personas", () => fixture(async (_, store, personas) => {
  await writeFile(join(personas, "zulu.json"), json("zulu", "secret"));
  await writeFile(join(personas, "alpha.md"), markdown());
  await writeFile(join(personas, "both.md"), markdown());
  await writeFile(join(personas, "both.json"), "malformed");
  await writeFile(join(personas, "broken.json"), "malformed");
  await writeFile(join(personas, ".hidden.json"), "malformed");
  await mkdir(join(personas, "unreadable.md"));

  assert.equal((await store.get("alpha")).id, "alpha");
  await assert.rejects(store.get("both"), { code: "LARVA_PERSONA_CONFLICT" });
  await assert.rejects(store.get("missing"), { code: "LARVA_PERSONA_NOT_FOUND" });
  await assert.rejects(store.get("broken"), { code: "LARVA_PERSONA_INVALID" });
  await assert.rejects(store.get("unreadable"), { code: "LARVA_PERSONA_INVALID" });
  await assert.rejects(store.get("../alpha"), { code: "LARVA_BAD_INPUT" });
  const summaries = await store.list();
  assert.deepEqual(summaries.map(item => item.id), ["alpha", "zulu"]);
  assert.ok(summaries.every(item => !("prompt" in item) && !("tools" in item)));
  assert.deepEqual(store.diagnostics.map(({ persona_id, code }) => [persona_id, code]), [
    ["both", "LARVA_PERSONA_CONFLICT"], ["broken", "LARVA_PERSONA_INVALID"], ["unreadable", "LARVA_PERSONA_INVALID"],
  ]);
  assert.deepEqual((await store.list({ query: " EXAMPLE ", limit: 1, full: true })).map(item => item.prompt), ["Private instructions"]);
  assert.equal(store.diagnostics.length, 3);
  assert.deepEqual(await store.list({ query: "secret" }), []);
}));

test("list ranks ID matches before metadata matches and caps diagnostics independently of limits", () => fixture(async (_, store, personas) => {
  await writeFile(join(personas, "aaa.json"), json("aaa", "private", "Worker metadata match"));
  await writeFile(join(personas, "worker-z.json"), json("worker-z"));
  await writeFile(join(personas, "worker.json"), json("worker"));
  for (let i = 0; i < 101; i++) await writeFile(join(personas, `bad-${i}.json`), '{"private field":"secret"}');
  assert.deepEqual((await store.list({ query: "worker", limit: 2 })).map(item => item.id), ["worker", "worker-z"]);
  assert.equal(store.diagnostics.length, 100);
  assert.ok(store.diagnostics.every(item => item.message === 'Unexpected persona field: "private field".'));
  assert.ok(store.diagnostics.every(item => !item.message.includes("secret")));
}));

test("put and rm repair dual-format conflicts independently of the read validator", () => fixture(async (_, store, personas) => {
  const md = join(personas, "repair.md");
  const js = join(personas, "repair.json");
  await writeFile(md, markdown("before"));
  assert.equal((await store.get("repair")).prompt, "before");
  await writeFile(js, "malformed");
  await assert.rejects(store.get("repair"), { code: "LARVA_PERSONA_CONFLICT" });

  const text = json("repair", "after");
  assert.deepEqual(await store.put("-", { stdinText: text }), { committed_ids: ["repair"], pruned_ids: [] });
  assert.deepEqual(await readdir(personas), ["repair.json"]);
  assert.equal(await readFile(js, "utf8"), text);
  assert.equal((await store.get("repair")).prompt, "after");

  await writeFile(md, "malformed");
  await assert.rejects(store.rm(["repair", "missing"]), { code: "LARVA_PERSONA_NOT_FOUND" });
  await assert.rejects(store.get("repair"), { code: "LARVA_PERSONA_CONFLICT" });
  await store.rm(["repair", "repair"]);
  assert.deepEqual(await readdir(personas), []);
  await assert.rejects(store.get("repair"), { code: "LARVA_PERSONA_NOT_FOUND" });
}));

test("validate and put admit the whole batch before writing anything", () => fixture(async (_, store, personas, sources) => {
  const existing = join(personas, "alpha.md");
  await writeFile(existing, markdown("existing"));
  await writeFile(join(personas, "unlisted.json"), json("unlisted"));
  await writeFile(join(sources, "alpha.md"), markdown("replacement"));
  await writeFile(join(sources, "zulu.json"), json("mismatched-id"));
  await writeFile(join(sources, ".hidden.json"), "malformed");
  await assert.rejects(store.validate(sources), { code: "LARVA_PERSONA_INVALID" });
  await assert.rejects(store.put(sources, { prune: true }), { code: "LARVA_PERSONA_INVALID" });
  assert.equal(await readFile(existing, "utf8"), markdown("existing"));
  assert.deepEqual((await readdir(personas)).sort(), ["alpha.md", "unlisted.json"]);

  await writeFile(join(sources, "zulu.json"), json("zulu"));
  assert.deepEqual((await store.validate(sources)).map(item => item.id), ["alpha", "zulu"]);
  await writeFile(join(sources, "alpha.json"), json("alpha"));
  await assert.rejects(store.validate(sources), { code: "LARVA_PERSONA_CONFLICT" });
  await assert.rejects(store.put(sources), { code: "LARVA_PERSONA_CONFLICT" });
  assert.equal(await readFile(existing, "utf8"), markdown("existing"));
  assert.deepEqual((await readdir(personas)).sort(), ["alpha.md", "unlisted.json"]);

  const md = markdown("from stdin", "stdin");
  assert.equal((await store.validate("-", md))[0].id, "stdin");
  await assert.rejects(store.validate("-", markdown()), { code: "LARVA_PERSONA_INVALID" });
  await store.put("-", { stdinText: md });
  assert.equal(await readFile(join(personas, "stdin.md"), "utf8"), md);
}));

test("prune requires a directory and removes unlisted definitions after upserts", () => fixture(async (_, store, personas, sources) => {
  const source = join(sources, "keep.md");
  await writeFile(source, markdown("replacement"));
  await writeFile(join(personas, "keep.json"), json("keep"));
  await writeFile(join(personas, "old.json"), "malformed");
  await writeFile(join(personas, "old.md"), "malformed");
  await writeFile(join(personas, "Bad_Name.json"), "malformed");
  await writeFile(join(personas, ".scratch.md"), "keep");
  await writeFile(join(personas, "notes.txt"), "keep");
  await assert.rejects(store.put(source, { prune: true }), { code: "LARVA_BAD_INPUT" });
  await assert.rejects(store.put("-", { prune: true, stdinText: json("x") }), { code: "LARVA_BAD_INPUT" });
  assert.equal((await store.get("keep")).prompt, "Private instructions");
  assert.deepEqual(await store.put(sources, { prune: true }), { committed_ids: ["keep"], pruned_ids: ["Bad_Name", "old"] });
  assert.deepEqual((await readdir(personas)).sort(), [".scratch.md", "keep.md", "notes.txt"]);
  assert.equal((await store.get("keep")).prompt, "replacement");
}));

test("partial put reports the rename commit boundary and does not begin prune on failure", () => fixture(async (_, store, personas, sources) => {
  await writeFile(join(sources, "alpha.md"), markdown());
  await writeFile(join(sources, "zulu.json"), json("zulu"));
  await writeFile(join(personas, "old.json"), json("old"));
  await mkdir(join(personas, "zulu.json"));
  await assert.rejects(store.put(sources, { prune: true }), assertPartial(["alpha"], [], "zulu"));
  assert.deepEqual((await readdir(personas)).sort(), ["alpha.md", "old.json", "zulu.json"]);
  assert.equal((await store.get("alpha")).id, "alpha");

  await rm(join(personas, "zulu.json"), { recursive: true });
  await mkdir(join(personas, "zulu.md"));
  await assert.rejects(store.put(sources, { prune: true }), assertPartial(["alpha", "zulu"], [], "zulu"));
  assert.equal(await readFile(join(personas, "zulu.json"), "utf8"), json("zulu"));
  await assert.rejects(store.get("zulu"), { code: "LARVA_PERSONA_CONFLICT" });
  assert.equal((await store.get("old")).id, "old");
}));

test("partial prune identifies completed writes, unlinks and the failing entry", () => fixture(async (_, store, personas, sources) => {
  await writeFile(join(sources, "keep.md"), markdown());
  await writeFile(join(personas, "old.json"), json("old"));
  await mkdir(join(personas, "problem.json"));
  await writeFile(join(personas, "zulu.json"), json("zulu"));
  await assert.rejects(store.put(sources, { prune: true }), assertPartial(["keep"], ["old"], "problem"));
  await assert.rejects(store.get("old"), { code: "LARVA_PERSONA_NOT_FOUND" });
  assert.equal((await store.get("zulu")).id, "zulu");
  assert.equal((await store.get("keep")).id, "keep");
}));

test("cached parses observe same-stat edits, inode replacement and format changes", () => fixture(async (_, store, personas) => {
  const path = join(personas, "cache.json");
  const timestamp = 1_700_000_000;
  await writeFile(path, json("cache", "red"));
  await utimes(path, timestamp, timestamp);
  const before = await stat(path, { bigint: true });
  const first = await store.get("cache");
  first.tools.allow.push("wrong");
  assert.deepEqual((await store.get("cache")).tools.allow, []);

  await writeFile(path, json("cache", "tan"));
  await utimes(path, timestamp, timestamp);
  const edited = await stat(path, { bigint: true });
  assert.deepEqual([edited.ino, edited.size, edited.mtimeNs], [before.ino, before.size, before.mtimeNs]);
  assert.equal((await store.get("cache")).prompt, "tan");

  const replacement = join(personas, ".replacement");
  await writeFile(replacement, json("cache", "sky"));
  await utimes(replacement, timestamp, timestamp);
  await rename(replacement, path);
  assert.notEqual((await stat(path, { bigint: true })).ino, before.ino);
  assert.equal((await store.get("cache")).prompt, "sky");

  await writeFile(join(personas, "cache.md"), markdown("markdown"));
  await assert.rejects(store.get("cache"), { code: "LARVA_PERSONA_CONFLICT" });
  await unlink(path);
  assert.equal((await store.get("cache")).prompt, "markdown");
  await unlink(join(personas, "cache.md"));
  await assert.rejects(store.get("cache"), { code: "LARVA_PERSONA_NOT_FOUND" });
}));

test("output threshold counts Unicode code points and artifacts have private mode and exact UTF-8 bytes", () => fixture(async (home) => {
  const { artifacts } = getLarvaHomePaths(home);
  const inline = "😀é".repeat(18_000);
  assert.deepEqual(await writeOutputSnapshot(home, inline), { output_state: "inline", result_text: inline });
  await assert.rejects(stat(artifacts), { code: "ENOENT" });

  await mkdir(artifacts, { recursive: true });
  await chmod(artifacts, 0o755);
  const full = `${inline}\nlast line\n`;
  const output = await writeOutputSnapshot(home, full);
  assert.equal(output.output_state, "artifactized");
  assert.equal(output.result_preview, "😀é".repeat(1_000));
  assert.equal(output.result_text, undefined);
  const ref = output.full_output_artifact;
  assert.ok(ref);
  assert.equal(dirname(ref.path), await realpath(artifacts));
  assert.match(ref.path, /\.txt$/);
  assert.deepEqual(await readFile(ref.path), Buffer.from(full));
  assert.deepEqual(ref, {
    path: ref.path, bytes: Buffer.byteLength(full), sha256: createHash("sha256").update(full).digest("hex"), lines: 2,
  });
  assert.equal((await stat(artifacts)).mode & 0o777, 0o700);
  assert.equal((await stat(ref.path)).mode & 0o777, 0o600);
  assert.equal((await readdir(artifacts)).length, 1);

  assert.equal((await writeOutputSnapshot(home, `${inline}😀`)).output_state, "artifactized");
}));

test("artifact and inline pages count code points across UTF-8 read boundaries", () => fixture(async (home) => {
  const full = `\ufeff${"a".repeat(16_379)}😀é\n${"b".repeat(20_000)}\nend`;
  const output = await writeOutputSnapshot(home, full);
  const path = output.full_output_artifact?.path;
  assert.ok(path);
  const query = { offset: 16_379, length: 4 };
  const expected = { state: "ok", text: "a😀é\n", offset: 16_379, length: 4, continuation_offset: 16_383 };
  assert.deepEqual(readRunTextSlice(full, query), expected);
  assert.deepEqual(await readArtifactSlice(home, path, query), expected);
  const tail = { offset: 36_384, length: 3 };
  assert.deepEqual(await readArtifactSlice(home, path, tail), { state: "ok", text: "end", offset: 36_384, length: 3 });
  assert.deepEqual(await readArtifactSlice(home, path, { length: 4_001 }), { state: "unavailable" });
  const alias = join(dirname(path), "alias.txt");
  await symlink(path, alias);
  assert.deepEqual(await readArtifactSlice(home, alias, query), { state: "unavailable" });
  await unlink(path);
  assert.deepEqual(await readArtifactSlice(home, path, query), { state: "unavailable" });
}));

test("managed directories do not redirect persona mutations or artifact I/O through symlinks", () => fixture(async (home, store, personas, sources) => {
  const outside = join(sources, "outside");
  await mkdir(outside);
  await mkdir(join(outside, "artifacts"));
  await writeFile(join(outside, "artifacts", "secret.txt"), "outside");
  await writeFile(join(outside, "alpha.json"), json("alpha"));
  const { state, artifacts } = getLarvaHomePaths(home);
  await symlink(outside, state);
  await rm(personas, { recursive: true });
  await symlink(outside, personas);
  assert.equal((await writeOutputSnapshot(home, "z".repeat(36_001))).output_state, "delivery_failed");
  assert.deepEqual(await readArtifactSlice(home, join(artifacts, "secret.txt"), {}), { state: "unavailable" });
  await assert.rejects(store.get("alpha"), { code: "LARVA_PERSONA_INVALID" });
  await assert.rejects(store.put("-", { stdinText: json("alpha", "replacement") }), assertPartial([], [], "alpha"));
  await assert.rejects(store.rm(["alpha"]), { code: "LARVA_STORE_WRITE_FAILED" });
  assert.deepEqual(await readdir(join(outside, "artifacts")), ["secret.txt"]);
  assert.equal(await readFile(join(outside, "alpha.json"), "utf8"), json("alpha"));
}));

test("independent writers recover a dead short lock and serialize long-name format replacement", () => fixture(async (home, store, personas) => {
  const id = "a".repeat(250);
  const lock = join(personas, ".write.lock");
  const exec = promisify(execFile);
  const node = (script: string, args: string[]) => exec(process.execPath, ["--input-type=module", "--eval", script, ...args], { timeout: 10_000 });
  await node(`
    import { mkdir, writeFile } from "node:fs/promises";
    const path = process.argv[1];
    await mkdir(path);
    await writeFile(path + "/owner.json", JSON.stringify({ id: "exited-writer", pid: process.pid }));
  `, [lock]);
  await writeFile(join(personas, `${id}.md`), markdown());
  await writeFile(join(personas, `${id}.json`), json(id));
  const script = `
    import { PersonaStore } from ${JSON.stringify(import.meta.resolve("../../src/store/persona-store.ts"))};
    const [home, stdinText] = process.argv.slice(1);
    await new PersonaStore(home).put("-", { stdinText });
  `;
  await Promise.all([node(script, [home, json(id, "json replacement")]), node(script, [home, markdown("md replacement", id)])]);
  const [name, ...rest] = await readdir(personas);
  assert.deepEqual(rest, []);
  assert.equal((await store.get(id)).prompt, name.endsWith(".md") ? "md replacement" : "json replacement");
}));

test("case aliases cannot be read as canonical persona filenames", () => fixture(async (_, store, personas) => {
  await writeFile(join(personas, "ALPHA.json"), json("alpha"));
  const alias = join(personas, "alpha.json");
  const foldsCase = await stat(alias).then(() => true, () => false);
  await assert.rejects(store.get("alpha"), foldsCase
    ? { code: "LARVA_PERSONA_INVALID", message: /match alpha\.json exactly/ }
    : { code: "LARVA_PERSONA_NOT_FOUND" });
  await assert.rejects(store.validate(alias), foldsCase
    ? { code: "LARVA_PERSONA_INVALID", message: /match alpha\.json exactly/ }
    : { code: "LARVA_PERSONA_INVALID", message: /Cannot read persona input/ });
  assert.deepEqual(await store.list(), []);
  assert.equal(store.diagnostics[0]?.message, "Invalid persona filename stem.");
}));

test("failed output delivery contains no replay and does not mask run success", () => fixture(async (home) => {
  const { state, artifacts } = getLarvaHomePaths(home);
  await mkdir(state);
  await writeFile(artifacts, "blocked");
  const run = { status: "success", ...await writeOutputSnapshot(home, "private 😀".repeat(5_000)) };
  assert.deepEqual(run, {
    status: "success", output_state: "delivery_failed",
    output_diagnostic: { code: "LARVA_STORE_WRITE_FAILED", message: "Could not persist full output artifact." },
  });
  assert.equal(await readFile(artifacts, "utf8"), "blocked");
}));
