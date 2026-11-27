import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { getLarvaHomePaths } from "../../src/core/paths.ts";
import { writeOutputSnapshot } from "../../src/store/artifacts.ts";
import * as capsules from "../../src/store/capsule.ts";
import { runGc } from "../../src/store/gc.ts";
import { MAX_SESSION_NAME_BYTES, readDiskSession, readSessionHeader, resolveCanonicalSessionPath, scanDiskSessions } from "../../src/store/session-index.ts";
import { createSessionLeaseStore } from "../../src/store/session-lease.ts";

const exec = promisify(execFile);
const DAY = 86_400_000;
const MIB = 1_048_576;

async function fixture<T>(run: (f: {
  paths: ReturnType<typeof getLarvaHomePaths>;
  leases: ReturnType<typeof createSessionLeaseStore>;
  piAgentDir: string;
}) => Promise<T>): Promise<T> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "larva-store-")));
  try {
    const paths = getLarvaHomePaths(home);
    const piAgentDir = join(home, "pi-agent");
    await Promise.all([paths.sessions, paths.artifacts, paths.capsules, piAgentDir].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
    return await run({ paths, leases: createSessionLeaseStore(home, capsules), piAgentDir });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function leaseFromExitedOwner(home: string, task: string, spawnIn: string | null = null) {
  const { stdout } = await exec(process.execPath, ["--input-type=module", "--eval", `
    import * as capsules from ${JSON.stringify(import.meta.resolve("../../src/store/capsule.ts"))};
    import { createSessionLeaseStore } from ${JSON.stringify(import.meta.resolve("../../src/store/session-lease.ts"))};
    const [home, task, agent] = process.argv.slice(1);
    const lease = await createSessionLeaseStore(home, capsules).acquire(task);
    let root;
    if (agent) {
      ({root} = await capsules.createCapsule({ home, pi_agent_dir: agent, extension_sources: [] }));
      await lease.markSpawning(root);
    }
    console.log(JSON.stringify({ lease_id: lease.lease_id, pid: process.pid, root }));
  `, home, task, spawnIn ?? ""], { timeout: 10_000 });
  const result = JSON.parse(stdout) as { lease_id: string; pid: number; root?: string };
  assert.equal(capsules.pidExited(result.pid), true);
  return result;
}

async function agedFile(path: string, bytes: number, age: number): Promise<void> {
  await writeFile(path, Buffer.alloc(bytes), { mode: 0o600 });
  const then = new Date(Date.now() - age);
  await utimes(path, then, then);
}

async function fileNames(path: string): Promise<string[]> {
  return (await readdir(path)).sort();
}

test("cold lease acquisition and GC share canonical paths across a symlinked home ancestor", async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "larva-cold-store-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const real = join(base, "real"), alias = join(base, "alias");
  await mkdir(real);
  await symlink(real, alias, "dir");
  const paths = getLarvaHomePaths(join(real, "larva"));
  const home = join(alias, "larva"), piAgentDir = join(base, "agent");
  const aliased = createSessionLeaseStore(home, capsules), canonical = createSessionLeaseStore(paths.home, capsules);
  const task = join(paths.sessions, "cold.jsonl");
  await assert.rejects(lstat(paths.sessions), { code: "ENOENT" });
  const owner = await leaseFromExitedOwner(home, task, piAgentDir);
  assert.ok(owner.root);
  assert.equal(owner.root, await realpath(owner.root));
  assert.equal((await capsules.inspectCapsule(home, owner.root))?.state, "spawning");
  await agedFile(task, 83, DAY * 3);
  for (const leases of [aliased, canonical]) {
    assert.equal((await leases.inspect(task)).disposition, "uncertain");
    const dry = await runGc({ leases, capsules, max_age_days: 1, dry_run: true });
    assert.deepEqual(dry.unreconciled_capsules, [owner.root]);
    assert.equal(dry.protected_bytes, 83);
    assert.equal(dry.deleted_sessions, 0);
  }
  const output = await writeOutputSnapshot(home, "x".repeat(36_001));
  assert.equal(output.output_state, "artifactized");
  assert.ok(output.full_output_artifact);
  assert.equal(output.full_output_artifact.path, await realpath(output.full_output_artifact.path));

  await capsules.writeMetadata(join(owner.root, "child_self.json"), { pid: owner.pid });
  const reclaimed = await runGc({ leases: aliased, capsules, max_age_days: 1 });
  assert.equal(reclaimed.deleted_sessions, 1);
  assert.deepEqual(await fileNames(paths.capsules), []);
  assert.deepEqual(await fileNames(paths.sessions), []);
});

test("atomic acquisitions install one private populated lock", () => fixture(async ({ paths, leases }) => {
  const task = join(paths.sessions, "shared.jsonl");
  const attempts = await Promise.allSettled(Array.from({ length: 16 }, () => leases.acquire(task)));
  const winners = attempts.filter(attempt => attempt.status === "fulfilled");
  assert.equal(winners.length, 1);
  for (const loser of attempts.filter(attempt => attempt.status === "rejected")) {
    assert.equal(loser.reason.code, "LARVA_SESSION_BUSY");
  }
  const [winner] = winners;
  assert.ok(winner);
  const lock = `${task}.lock`;
  assert.deepEqual(await fileNames(paths.sessions), ["shared.jsonl.lock"]);
  assert.equal((await lstat(paths.sessions)).mode & 0o777, 0o700);
  assert.equal((await lstat(lock)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(lock, "lease.json"))).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(join(lock, "lease.json"), "utf8")), {
    lease_id: winner.value.lease_id, owner_pid: process.pid, state: "reserving", child_pid: null, capsule_root: null,
  });
  await winner.value.release();
  assert.deepEqual(await fileNames(paths.sessions), []);
}));

test("stale reclaimers compare the observed lease ID and cannot detach a successor", () => fixture(async ({ paths, leases }) => {
  const task = join(paths.sessions, "stale.jsonl");
  const { lease_id } = await leaseFromExitedOwner(paths.home, task);
  assert.equal((await leases.inspect(task)).disposition, "stale");
  const contenders = await Promise.all(Array.from({ length: 24 }, async () => {
    if (await leases.reclaim(task, lease_id)) return leases.acquire(task);
    return undefined;
  }));
  const [successor, ...unexpected] = contenders.filter(item => item !== undefined);
  assert.ok(successor);
  assert.equal(unexpected.length, 0);
  assert.notEqual(successor.lease_id, lease_id);
  assert.equal(await leases.reclaim(task, lease_id), false);
  assert.deepEqual(await leases.inspect(task), {
    disposition: "active",
    record: { owner_pid: process.pid, lease_id: successor.lease_id, state: "reserving", child_pid: null, capsule_root: null },
  });
  await successor.release();
  assert.deepEqual(await fileNames(paths.sessions), []);
}));

test("a settled hardlink claim cannot self-lock a later reclaim in the same process", () => fixture(async ({ paths, leases }) => {
  const task = join(paths.sessions, "recover.jsonl");
  const { lease_id } = await leaseFromExitedOwner(paths.home, task);
  const digest = createHash("sha256").update(lease_id).digest("hex");
  const source = join(paths.sessions, "private-claim");
  await capsules.writeMetadata(source, { pid: process.pid });
  await link(source, join(`${task}.lock`, `.reclaim.${digest}.0`));
  assert.equal(await leases.reclaim(task, lease_id), false);
  await rm(source);
  assert.equal(await leases.reclaim(task, lease_id), true);
  assert.equal((await leases.inspect(task)).disposition, "missing");
}));

test("dead spawning owners remain unreconciled until child and descendant exit evidence exists", () => fixture(async ({ paths, leases, piAgentDir }) => {
  const task = join(paths.sessions, "spawning.jsonl");
  await agedFile(task, 83, DAY * 50);
  const owner = await leaseFromExitedOwner(paths.home, task, piAgentDir);
  assert.ok(owner.root);
  const { root } = owner;
  const gc = { leases, capsules, max_age_days: 1 };

  assert.deepEqual((await runGc({ ...gc, dry_run: true })).unreconciled_capsules, [root]);
  assert.equal(JSON.parse(await readFile(join(`${task}.lock`, "lease.json"), "utf8")).state, "spawning");
  const retained = await runGc(gc);
  assert.equal(retained.deleted_sessions, 0);
  assert.equal(retained.protected_bytes, 83);
  assert.deepEqual(retained.unreconciled_capsules, [root]);
  assert.equal(JSON.parse(await readFile(join(`${task}.lock`, "lease.json"), "utf8")).state, "unreconciled");
  await assert.rejects(leases.acquire(task), { code: "LARVA_SESSION_BUSY" });

  const exitedChild = await leaseFromExitedOwner(paths.home, join(paths.sessions, "child.jsonl"));
  const descendants = join(root, "descendants", "leaf.json");
  await writeFile(join(root, "child_self.json"), JSON.stringify({ pid: exitedChild.pid }));
  await writeFile(descendants, JSON.stringify({ pid: process.pid }));
  assert.equal((await runGc(gc)).protected_bytes, 83);
  await writeFile(descendants, JSON.stringify({ pid: owner.pid }));
  const reclaimed = await runGc(gc);
  assert.equal(reclaimed.deleted_sessions, 1);
  assert.deepEqual(reclaimed.unreconciled_capsules, []);
  assert.deepEqual(await fileNames(paths.sessions), []);
  assert.deepEqual(await fileNames(paths.capsules), []);
}));

test("GC and lease contenders preserve a crashed ancestor until the full linked tree exits", () => fixture(async ({ paths, leases, piAgentDir }) => {
  const [task, middle, last] = ["ancestor", "middle", "last"].map(name => join(paths.sessions, `${name}.jsonl`));
  await agedFile(task, 83, DAY * 50);
  const ancestor = await leaseFromExitedOwner(paths.home, task, piAgentDir);
  const child = await leaseFromExitedOwner(paths.home, middle, piAgentDir);
  const grandchild = await leaseFromExitedOwner(paths.home, last, piAgentDir);
  assert.ok(ancestor.root && child.root && grandchild.root);

  const leaf = spawn(process.execPath, ["--eval", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
  const closed = once(leaf, "close");
  try {
    assert.ok(leaf.pid);
    const tree = [
      { root: ancestor.root, pid: child.pid }, { root: child.root, pid: grandchild.pid }, { root: grandchild.root, pid: leaf.pid },
    ];
    for (const [index, { root, pid }] of tree.slice(0, -1).entries()) {
      await capsules.writeMetadata(join(root, "child_self.json"), { pid });
      const linked = tree[index + 1];
      await capsules.writeMetadata(join(root, "descendants", `${basename(linked.root)}.json`), {
        ...(index === 0 ? { pid: linked.pid } : {}), capsule_root: linked.root,
      });
    }
    const local = await capsules.createCapsule({ home: paths.home, pi_agent_dir: piAgentDir, extension_sources: [] });
    await capsules.writeMetadata(join(local.root, "child_self.json"), { pid: ancestor.pid });
    const localLink = join(local.root, "descendants", `${basename(ancestor.root)}.json`);
    await capsules.writeMetadata(localLink, { pid: child.pid, capsule_root: ancestor.root });
    const aliasedHome = join(paths.home, "gc-home-alias");
    await symlink(paths.home, aliasedHome, "dir");
    const gc = { leases: createSessionLeaseStore(aliasedHome, capsules), capsules, max_age_days: 1 };
    const allCapsules = [local.root, ...tree.map(({ root }) => root)].map(root => basename(root)).sort();
    const leafOwner = join(grandchild.root, "owner.json");
    for (const state of ["reserving", "spawning"]) {
      await capsules.writeMetadata(leafOwner, { owner_pid: grandchild.pid, state });
      assert.equal((await capsules.inspectCapsule(paths.home, local.root, ancestor.pid, "live"))?.all_exited, false);
      assert.equal((await runGc({ ...gc, dry_run: true })).deleted_sessions, 0);
      assert.equal((await runGc(gc)).deleted_sessions, 0);
      assert.deepEqual(await fileNames(paths.capsules), allCapsules);
      await assert.rejects(leases.acquire(task), { code: "LARVA_SESSION_BUSY" });
    }
    await capsules.writeMetadata(join(grandchild.root, "child_self.json"), { pid: leaf.pid });
    assert.equal((await capsules.inspectCapsule(paths.home, local.root, ancestor.pid, "live"))?.all_exited, false);
    const preview = await runGc({ ...gc, dry_run: true });
    assert.equal(capsules.pidExited(leaf.pid), false);
    assert.equal(preview.deleted_sessions, 0);
    assert.equal(preview.protected_bytes, 83);
    assert.deepEqual(await runGc(gc), preview);
    await assert.rejects(leases.acquire(task), { code: "LARVA_SESSION_BUSY" });
    assert.ok((await lstat(task)).isFile());
    assert.ok((await lstat(`${task}.lock`)).isDirectory());
    assert.ok((await lstat(ancestor.root)).isDirectory());

    leaf.stdin!.end();
    assert.deepEqual(await closed, [0, null]);
    assert.equal(capsules.pidExited(leaf.pid), true);
    const manifest = join(grandchild.root, "descendants", "malformed.json");
    for (const invalidLink of [ancestor.root, join(paths.home, "outside-capsules")]) {
      await capsules.writeMetadata(manifest, { pid: leaf.pid, capsule_root: invalidLink });
      assert.notEqual((await capsules.inspectCapsule(paths.home, ancestor.root))?.all_exited, true);
    }
    await rm(manifest);
    assert.equal((await capsules.inspectCapsule(paths.home, ancestor.root, child.pid, "live"))?.all_exited, false);
    assert.equal((await capsules.inspectCapsule(paths.home, local.root))?.all_exited, false);
    assert.equal((await capsules.inspectCapsule(paths.home, local.root, ancestor.pid, "live"))?.all_exited, true);
    assert.equal((await leases.inspect(task)).disposition, "stale");
    const absent = join(grandchild.root, "descendants", "missing-intent.json");
    await capsules.writeMetadata(absent, { capsule_root: join(paths.capsules, `child-${leaf.pid}-f00`) });
    assert.equal((await leases.inspect(task)).disposition, "uncertain");
    await rm(absent);
    const after = await runGc({ ...gc, dry_run: true });
    assert.equal(after.deleted_sessions, 1);
    assert.deepEqual(await fileNames(paths.capsules), allCapsules);
    const contender = await leases.acquire(task);
    await contender.release();
    assert.deepEqual(await runGc(gc), after);
    assert.deepEqual(await fileNames(paths.sessions), []);
    // Even after the stale leases settle, the live ancestor still owns every link.
    assert.deepEqual(await fileNames(paths.capsules), allCapsules);
    assert.equal((await capsules.inspectCapsule(paths.home, local.root, ancestor.pid, "live"))?.all_exited, true);
    await rm(localLink);
    await runGc(gc);
    assert.deepEqual(await fileNames(paths.capsules), [basename(local.root)]);
  } finally {
    leaf.kill("SIGKILL");
    await closed;
  }
}));

test("capsule settings are private copies and extension paths resolve before startup", () => fixture(async ({ paths, leases, piAgentDir }) => {
  const settings = '{"defaultThinkingLevel":"medium"}\n';
  const base = join(piAgentDir, "settings.json");
  await writeFile(base, settings);
  await writeFile(join(paths.home, "one.ts"), "");
  await writeFile(join(piAgentDir, "two.ts"), "");
  const capsule = await capsules.createCapsule({
    home: paths.home, pi_agent_dir: piAgentDir, user_home: paths.home,
    extension_sources: ["one.ts", "pi-agent:two.ts", "~/one.ts", "npm:example"],
  });
  const copy = capsule.settings_path;
  assert.equal(capsule.agent_dir, join(capsule.root, "agent"));
  assert.equal(copy, join(capsule.agent_dir, "settings.json"));
  assert.equal((await lstat(capsule.root)).mode & 0o777, 0o700);
  assert.equal((await lstat(capsule.agent_dir)).mode & 0o777, 0o700);
  assert.deepEqual(await fileNames(capsule.root), ["agent", "descendants", "owner.json"]);
  assert.equal((await lstat(copy)).mode & 0o777, 0o600);
  assert.equal(await readFile(copy, "utf8"), settings);
  await writeFile(copy, '{"defaultThinkingLevel":"low"}\n');
  assert.equal(await readFile(base, "utf8"), settings);
  assert.deepEqual(capsule.extension_sources, [
    await realpath(join(paths.home, "one.ts")), await realpath(join(piAgentDir, "two.ts")),
    await realpath(join(paths.home, "one.ts")), "npm:example",
  ]);
  const task = join(paths.sessions, "running.jsonl");
  const lease = await leases.acquire(task);
  await Promise.all([lease.markSpawning(capsule.root), lease.markRunning(process.pid)]);
  assert.equal((await leases.inspect(task)).disposition, "active");
  await assert.rejects(lease.markSpawning(capsule.root), { code: "LARVA_SESSION_BUSY" });
  await lease.markUnreconciled();
  assert.equal(await leases.diskLockState(task), "unreconciled");
  const ownerPath = join(capsule.root, "owner.json");
  const owner = await readFile(ownerPath, "utf8");
  await lease.release();
  assert.equal(await readFile(ownerPath, "utf8"), owner);
}));

test("capsule projects canonical shared resources and snapshots an external models.json without sharing writes", () => fixture(async ({ paths, piAgentDir }) => {
  const create = (base = piAgentDir) => capsules.createCapsule({ home: paths.home, pi_agent_dir: base, extension_sources: [] });
  const modelPath = join(piAgentDir, "models.json");
  const auth = join(piAgentDir, "auth.json"), skills = join(piAgentDir, "skills");
  const agents = join(paths.home, "shared-instructions.md");
  await mkdir(skills);
  await writeFile(join(skills, "example.md"), "shared skill");
  await writeFile(auth, "shared auth", { mode: 0o600 });
  await writeFile(agents, "shared instructions");
  await symlink(agents, join(piAgentDir, "AGENTS.md"));
  await symlink("absent", join(piAgentDir, "dangling"));
  await symlink("loop", join(piAgentDir, "loop"));
  for (const name of ["sessions", "backups"]) await mkdir(join(piAgentDir, name));
  for (const name of ["crashes.json", "pi-debug.log", "auth.json.lock"]) await writeFile(join(piAgentDir, name), "");
  for (const base of [piAgentDir, join(paths.home, "missing"), auth]) {
    const absent = await create(base);
    assert.equal(absent.models_path, undefined);
    assert.equal(await readFile(absent.settings_path, "utf8"), "{}\n");
    if (base !== piAgentDir) assert.deepEqual(await fileNames(absent.agent_dir), ["settings.json"]);
  }
  const contents = '{"providers":{"example":{"models":[]}}}\n';
  const original = join(paths.home, "catalog.json");
  await writeFile(original, contents);
  await symlink(original, modelPath);
  const box = await create();
  const copy = join(box.agent_dir, "models.json");
  assert.equal(box.models_path, copy);
  assert.deepEqual(await fileNames(box.agent_dir), ["AGENTS.md", "auth.json", "models.json", "settings.json", "skills"]);
  for (const [name, target] of [["AGENTS.md", agents], ["auth.json", auth], ["skills", skills]]) {
    assert.equal(await readlink(join(box.agent_dir, name)), await realpath(target));
  }
  assert.equal((await lstat(copy)).mode & 0o777, 0o600);
  assert.equal(await readFile(copy, "utf8"), contents);
  await writeFile(copy, "{}\n");
  assert.equal(await readFile(original, "utf8"), contents);
  await rm(box.root, { recursive: true, force: true });
  assert.equal(await readFile(auth, "utf8"), "shared auth");
  assert.equal(await readFile(join(skills, "example.md"), "utf8"), "shared skill");

  const before = await fileNames(paths.capsules);
  await writeFile(original, Buffer.alloc(MIB + 1));
  await assert.rejects(create(), { code: "LARVA_CONFIG_INVALID" });
  await rm(original);
  await assert.rejects(create(), { code: "LARVA_CONFIG_INVALID" });
  await mkdir(original);
  await assert.rejects(create(), { code: "LARVA_CONFIG_INVALID" });
  await rm(modelPath);
  await symlink(original + ".absent", join(piAgentDir, "settings.json"));
  await assert.rejects(create(), { code: "LARVA_CONFIG_INVALID", message: /Pi settings\.json/ });
  assert.deepEqual(await fileNames(paths.capsules), before);
}));

test("session index validates line one and containment and reports the workspace and lock status", () => fixture(async ({ paths, leases }) => {
  const valid = join(paths.sessions, "valid.jsonl");
  const missing = join(paths.sessions, "missing-cwd.jsonl");
  const invalid = join(paths.sessions, "invalid.jsonl");
  const escaped = join(paths.sessions, "escaped.jsonl");
  const outside = join(paths.home, "outside.jsonl");
  const goneCwd = join(paths.home, "gone");
  await writeFile(valid, `${JSON.stringify({ type: "session", version: 2, cwd: paths.home })}\nnot JSON`);
  await writeFile(missing, JSON.stringify({ type: "session", version: 3, cwd: goneCwd }));
  await writeFile(invalid, JSON.stringify({ type: "session", version: 3, cwd: "relative" }));
  await writeFile(outside, await readFile(valid));
  await symlink(outside, escaped);
  await assert.rejects(readSessionHeader(paths.home, invalid), { code: "LARVA_SESSION_INVALID" });
  await assert.rejects(readSessionHeader(paths.home, escaped), { code: "LARVA_SESSION_INVALID" });
  const lease = await leases.acquire(valid);
  const realValid = await realpath(valid);
  assert.deepEqual(await readDiskSession(paths.home, realValid, leases), {
    task_id: realValid, cwd: paths.home, cwd_exists: true, lock_state: "active_local",
  });
  assert.deepEqual(await scanDiskSessions(paths.home, leases), [
    { task_id: await realpath(missing), cwd: goneCwd, cwd_exists: false, lock_state: "unlocked" },
    { task_id: realValid, cwd: paths.home, cwd_exists: true, lock_state: "active_local" },
  ]);
  await lease.release();
}));

test("canonical session handles remain readable through an aliased Larva home", () => fixture(async ({ paths }) => {
  const aliasedHome = join(paths.home, "home-alias");
  await symlink(paths.home, aliasedHome);
  const parent = await realpath(paths.sessions);
  const canonical = join(parent, "canonical.jsonl");
  const containedAlias = join(parent, "alias.jsonl");
  const missing = join(parent, "absent.jsonl");
  const dangling = join(parent, "dangling.jsonl");
  const directoryAlias = join(parent, "via"), danglingDirectoryAlias = join(parent, "dangling-dir");
  await writeFile(canonical, `${JSON.stringify({ type: "session", version: 3, cwd: paths.home })}\n`);
  await symlink(canonical, containedAlias);
  await symlink(missing, dangling);
  await symlink(parent, directoryAlias, "dir");
  await symlink(join(parent, "absent-dir"), danglingDirectoryAlias, "dir");
  assert.equal(await resolveCanonicalSessionPath(aliasedHome, canonical), canonical);
  assert.equal((await readSessionHeader(aliasedHome, canonical)).task_id, canonical);
  assert.deepEqual((await scanDiskSessions(aliasedHome, createSessionLeaseStore(aliasedHome, capsules))).map(s => s.task_id), [canonical]);
  for (const alias of [containedAlias, dangling, join(directoryAlias, "absent.jsonl"),
    join(danglingDirectoryAlias, "absent.jsonl"), join(getLarvaHomePaths(aliasedHome).sessions, "canonical.jsonl"),
    `${parent}/./canonical.jsonl`, `${parent}/bad\0.jsonl`]) {
    await assert.rejects(readSessionHeader(aliasedHome, alias), { code: "LARVA_SESSION_INVALID" });
  }
  await assert.rejects(readSessionHeader(aliasedHome, missing), { code: "LARVA_SESSION_NOT_FOUND" });
}));

test("GC applies age then byte eviction oldest first without deleting protected files; dry-run predicts the same report", () => fixture(async ({ paths, leases }) => {
  const active = join(paths.sessions, "active.jsonl");
  await agedFile(active, MIB, DAY * 99);
  const lease = await leases.acquire(active);
  await agedFile(join(paths.artifacts, "fresh.txt"), 17, 1_000);
  await agedFile(join(paths.sessions, "today.jsonl"), MIB, DAY / 2);
  await agedFile(join(paths.sessions, "expired.jsonl"), 100, DAY * 90);
  await agedFile(join(paths.artifacts, "older.txt"), MIB, DAY * 10);
  await agedFile(join(paths.artifacts, "newer.txt"), MIB, DAY * 5);

  const options = { leases, capsules, max_age_days: 30, max_bytes: 3 * MIB + 17 };
  const dry = await runGc({ ...options, dry_run: true });
  assert.deepEqual(dry, {
    deleted_sessions: 1, deleted_artifacts: 1, freed_bytes: MIB + 100, remaining_bytes: 3 * MIB + 17,
    protected_bytes: 2 * MIB + 17, budget_met: true, unreconciled_capsules: [],
  });
  assert.deepEqual(await fileNames(paths.artifacts), ["fresh.txt", "newer.txt", "older.txt"]);
  assert.deepEqual(await fileNames(paths.sessions), ["active.jsonl", "active.jsonl.lock", "expired.jsonl", "today.jsonl"]);
  assert.deepEqual(await runGc(options), dry);
  assert.deepEqual(await fileNames(paths.artifacts), ["fresh.txt", "newer.txt"]);
  assert.deepEqual(await fileNames(paths.sessions), ["active.jsonl", "active.jsonl.lock", "today.jsonl"]);
  const overBudget = await runGc({ ...options, max_bytes: MIB });
  assert.equal(overBudget.remaining_bytes, 2 * MIB + 17);
  assert.equal(overBudget.remaining_bytes, overBudget.protected_bytes);
  assert.equal(overBudget.budget_met, false);
  const ageOnly = await runGc({ leases, capsules, max_age_days: 1 });
  assert.equal(ageOnly.protected_bytes, MIB + 17);
  await lease.release();
}));

test("session paths are flat, byte-bounded, and refuse symlinked managed directories", () => fixture(async ({ paths, leases, piAgentDir }) => {
  const exact = `${"é".repeat((MAX_SESSION_NAME_BYTES - 6) / 2)}.jsonl`;
  const task = join(paths.sessions, exact);
  assert.equal(Buffer.byteLength(exact), MAX_SESSION_NAME_BYTES);
  const handle = await leases.acquire(task);
  await handle.release();
  await assert.rejects(leases.acquire(join(paths.sessions, `x${exact}`)), { code: "LARVA_SESSION_INVALID" });
  await assert.rejects(leases.acquire(join(paths.sessions, "nested", "leaf.jsonl")), { code: "LARVA_SESSION_INVALID" });
  await writeFile(task, JSON.stringify({ type: "session", version: 3, cwd: paths.home }));
  const moved = join(paths.home, "moved");
  await rm(paths.artifacts, { recursive: true });
  await rm(paths.capsules, { recursive: true });
  await rm(task);
  await rm(paths.sessions, { recursive: true });
  await rm(paths.state, { recursive: true });
  await mkdir(join(moved, "sessions"), { recursive: true });
  await writeFile(join(moved, "sessions", exact), JSON.stringify({ type: "session", version: 3, cwd: paths.home }));
  await symlink(moved, paths.state, "dir");
  assert.equal((await leases.inspect(task)).disposition, "invalid");
  await assert.rejects(leases.acquire(task), { code: "LARVA_STORE_WRITE_FAILED" });
  await assert.rejects(readSessionHeader(paths.home, task), { code: "LARVA_SESSION_INVALID" });
  await assert.rejects(capsules.createCapsule({ home: paths.home, pi_agent_dir: piAgentDir, extension_sources: [] }), { code: "LARVA_STORE_WRITE_FAILED" });
  assert.deepEqual(await fileNames(moved), ["sessions"]);
}));

test("GC keeps unreadable descendant evidence and removes only dead-PID staging debris", () => fixture(async ({ paths, leases, piAgentDir }) => {
  const task = join(paths.sessions, "crashed.jsonl");
  const { root, pid } = await leaseFromExitedOwner(paths.home, task, piAgentDir);
  assert.ok(root);
  const record = join(root, "descendants", "bad.json");
  await capsules.writeMetadata(join(root, "child_self.json"), { pid });
  await symlink("missing", record);
  const deadDebris = [join(paths.sessions, `orphan.jsonl.lock.tmp.${pid}.${"0".repeat(32)}`),
    join(paths.sessions, `orphan.jsonl.lock.retired.${process.pid}.${"1".repeat(32)}`),
    join(paths.capsules, `.child-${pid}-${"2".repeat(32)}.tmp`)];
  const artifactStage = join(paths.artifacts, `.artifact.tmp.${pid}.00000000-0000-0000-0000-000000000000`);
  await writeFile(artifactStage, "partial");
  const live = join(paths.sessions, `.guard.tmp.${process.pid}.${"3".repeat(32)}`);
  await writeFile(live, "live");
  for (const path of deadDebris) await mkdir(path);
  const options = { leases, capsules };
  assert.deepEqual((await runGc({ ...options, dry_run: true })).unreconciled_capsules, [root]);
  for (const path of deadDebris) await lstat(path);
  assert.deepEqual((await runGc(options)).unreconciled_capsules, [root]);
  for (const path of [...deadDebris, artifactStage]) await assert.rejects(lstat(path), { code: "ENOENT" });
  assert.equal(await readFile(live, "utf8"), "live");
  assert.deepEqual(await capsules.inspectDescendantPids(paths.home, root), { pids: [pid], complete: false });
  await rm(record);
  await capsules.writeMetadata(join(root, "descendants", "live.json"), { pid: process.pid });
  assert.deepEqual(await capsules.inspectDescendantPids(paths.home, root), { pids: [pid, process.pid], complete: true });
}));

test("GC reports committed session deletions even when the GC lease cannot release", () => fixture(async ({ paths, leases }) => {
  const task = join(paths.sessions, "expired.jsonl");
  await agedFile(task, 81, 90 * DAY);
  const report = await runGc({ capsules, leases: {
    ...leases,
    async acquire(path, state) {
      const held = await leases.acquire(path, state);
      return { async release() {
        await rm(join(`${path}.lock`, "lease.json"));
        await held.release();
      } };
    },
  } });
  assert.equal(report.deleted_sessions, 1);
  assert.equal(report.freed_bytes, 81);
  assert.equal(report.remaining_bytes, 0);
  await assert.rejects(lstat(task), { code: "ENOENT" });
  assert.equal((await leases.inspect(task)).disposition, "invalid");
}));

test("live GC holds gc_unlinking across the final stat and unlink and skips a newly refreshed transcript", () => fixture(async ({ paths, leases }) => {
  const stale = join(paths.sessions, "delete.jsonl");
  const refreshed = join(paths.sessions, "refresh.jsonl");
  await agedFile(stale, 50, 90 * DAY);
  await agedFile(refreshed, 51, 80 * DAY);
  const report = await runGc({
    capsules,
    leases: {
      ...leases,
      async acquire(path, state) {
        const held = await leases.acquire(path, state);
        try {
          const inspection = await leases.inspect(path);
          assert.ok("record" in inspection);
          assert.equal(inspection.record.state, "gc_unlinking");
          await assert.rejects(leases.acquire(path), { code: "LARVA_SESSION_BUSY" });
          assert.ok((await lstat(path)).isFile());
          if (path === refreshed) await utimes(path, new Date(), new Date());
          return held;
        } catch (error) {
          await held.release();
          throw error;
        }
      },
    },
  });
  assert.equal(report.deleted_sessions, 1);
  assert.equal(report.freed_bytes, 50);
  assert.equal(report.protected_bytes, 51);
  assert.deepEqual(await fileNames(paths.sessions), ["refresh.jsonl"]);
}));
