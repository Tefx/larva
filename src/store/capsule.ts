import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, opendir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { LarvaError } from "../core/errors.ts";
import { getLarvaHomePaths, resolveExtensionSources } from "../core/paths.ts";
import { isRecord } from "../core/predicates.ts";
import { canonicalPath, isErrno, readBoundedRegularBytes, readBoundedRegularText, requireStateDirectory } from "./bounded-read.ts";

export { isErrno } from "./bounded-read.ts";

const { O_NOFOLLOW, R_OK, X_OK } = constants;
const CAPSULE_NAME = /^child-([1-9][0-9]*)-[a-f0-9]+$/;
const MAX_TREE_DEPTH = 100;
const MAX_CENSUS_ENTRIES = 10_000;

type OwnerState = "reserving" | "spawning" | "running" | "unreconciled";
type CapsuleOwner = { owner_pid: number; state: OwnerState; child_pid?: number | null };

type CapsuleOptions = {
  home: string;
  pi_agent_dir: string;
  user_home?: string;
  extension_sources: readonly string[];
};

export function isPid(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 0x7fff_ffff;
}

/** Alive, inaccessible, or indeterminate are all non-reclaimable. */
export function pidExited(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return isErrno(error, "ESRCH");
  }
}

export async function privateDirectory(path: string): Promise<void> {
  try {
    const entry = await requireStateDirectory(path, true);
    if ((entry.mode & 0o077) === 0) return;
  } catch {
    throw new LarvaError("LARVA_STORE_WRITE_FAILED", `Cannot prepare private state directory: ${path}`);
  }
  throw new LarvaError("LARVA_STORE_WRITE_FAILED", `Expected a private state directory: ${path}`);
}

/** Bounded, non-blocking reads of managed metadata, without following a final symlink. */
export async function readMetadata(path: string): Promise<unknown> {
  return JSON.parse(await readBoundedRegularText(path, { maxBytes: 65_536, flags: O_NOFOLLOW }));
}

export async function writeMetadata(path: string, value: object): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > 65_536) throw new LarvaError("LARVA_STORE_WRITE_FAILED", "Metadata exceeds the write limit.");
  const temp = `${path}.tmp.${process.pid}.${randomBytes(16).toString("hex")}`;
  const file = await open(temp, "wx", 0o600);
  try {
    try {
      await file.writeFile(bytes);
    } finally {
      await file.close();
    }
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

const missingBase = (error: unknown) => isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR");

async function snapshotPiConfig(agentDir: string, name: "settings.json" | "models.json") {
  const path = join(agentDir, name);
  try {
    // Distinguish an absent entry from a present but invalid/dangling symlink.
    const entry = await lstat(path).catch(error => { if (!missingBase(error)) throw error; });
    if (!entry) return undefined;
    return (await readBoundedRegularBytes(await realpath(path), { maxBytes: 1_048_576, flags: O_NOFOLLOW })).bytes;
  } catch {
    throw new LarvaError("LARVA_CONFIG_INVALID", `Pi ${name} must be a readable regular file of at most 1 MiB.`);
  }
}

const privatePiEntries = new Set(["settings.json", "models.json", "sessions", "backups", "crashes.json"]);
async function projectPiResources(base: string, agentDir: string) {
  const entries = await opendir(base).catch(error => { if (!missingBase(error)) throw error; });
  if (!entries) return;
  for await (const { name } of entries) {
    if (privatePiEntries.has(name) || name.endsWith("-debug.log") || name.endsWith(".lock")) continue;
    let target: string, info: Awaited<ReturnType<typeof stat>>;
    try {
      target = await realpath(join(base, name));
      info = await stat(target);
    } catch (error) {
      if (missingBase(error) || isErrno(error, "ELOOP")) continue;
      throw error;
    }
    if (info.isFile() || info.isDirectory()) await symlink(target, join(agentDir, name), info.isDirectory() ? "dir" : "file");
  }
}

export type CapsulePaths = { root: string; agent_dir: string; settings_path: string; models_path?: string; extension_sources: string[] };

export async function createCapsule(options: CapsuleOptions): Promise<CapsulePaths> {
  const home = await canonicalPath(options.home);
  const capsules = getLarvaHomePaths(home).capsules;
  const root = join(capsules, `child-${process.pid}-${randomBytes(16).toString("hex")}`);
  await privateDirectory(capsules);
  const [extension_sources, settings, models] = await Promise.all([
    resolveExtensionSources(options.extension_sources, {
      larvaHome: home,
      userHome: options.user_home ?? homedir(),
      piAgentDir: options.pi_agent_dir,
      realpath,
      async assertReadable(path) {
        const entry = await stat(path);
        if (!entry.isDirectory() && !entry.isFile()) throw new Error("Expected file or directory.");
        await access(path, entry.isDirectory() ? R_OK | X_OK : R_OK);
      },
    }),
    snapshotPiConfig(options.pi_agent_dir, "settings.json"),
    snapshotPiConfig(options.pi_agent_dir, "models.json"),
  ]);
  const agent_dir = join(root, "agent");
  const settings_path = join(agent_dir, "settings.json");
  const models_path = models === undefined ? undefined : join(agent_dir, "models.json");
  const staged = join(capsules, `.${basename(root)}.tmp`);
  const stagedAgent = join(staged, "agent");
  await mkdir(staged, { mode: 0o700 });
  try {
    await mkdir(join(staged, "descendants"), { mode: 0o700 });
    await mkdir(stagedAgent, { mode: 0o700 });
    await writeFile(join(stagedAgent, "settings.json"), settings ?? "{}\n", { mode: 0o600, flag: "wx" });
    if (models !== undefined) await writeFile(join(stagedAgent, "models.json"), models, { mode: 0o600, flag: "wx" });
    await projectPiResources(options.pi_agent_dir, stagedAgent);
    await writeMetadata(join(staged, "owner.json"), { owner_pid: process.pid, state: "reserving" } satisfies CapsuleOwner);
    await rename(staged, root);
    return { root, agent_dir, settings_path, models_path, extension_sources };
  } catch (error) {
    await rm(staged, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export function capsuleParentPid(home: string, root: string): number | undefined {
  if (dirname(root) !== getLarvaHomePaths(home).capsules) return undefined;
  const match = CAPSULE_NAME.exec(basename(root));
  if (!match || join(dirname(root), match[0]) !== root) return undefined;
  const pid = Number(match[1]);
  return isPid(pid) ? pid : undefined;
}

function parseOwner(value: unknown): CapsuleOwner {
  if (!isRecord(value) || Object.keys(value).some(key => !["owner_pid", "state", "child_pid"].includes(key))) {
    throw new Error("Invalid capsule owner metadata.");
  }
  const { owner_pid, state, child_pid } = value;
  if (!isPid(owner_pid) || (state !== "reserving" && state !== "spawning" && state !== "running" && state !== "unreconciled")
      || (child_pid !== undefined && child_pid !== null && !isPid(child_pid))
      || (state === "running" && !isPid(child_pid)) || ((state === "reserving" || state === "spawning") && isPid(child_pid))) {
    throw new Error("Invalid capsule owner metadata.");
  }
  return { owner_pid, state, child_pid };
}

type DescendantRecord = { pid: number | undefined; linked?: { root: string; owner: number } };

async function* readDescendants(home: string, dir: string, names: readonly string[]): AsyncGenerator<DescendantRecord | undefined> {
  for (const name of names) {
    const record = await readMetadata(join(dir, name)).catch(() => undefined);
    if (!isRecord(record)) {
      yield undefined;
      continue;
    }
    const { pid, capsule_root: root } = record;
    const owner = typeof root === "string" ? capsuleParentPid(home, root) : undefined;
    if ((pid !== undefined && !isPid(pid)) || (pid === undefined && owner === undefined)) {
      yield undefined;
      continue;
    }
    yield typeof root === "string" && owner !== undefined ? { pid, linked: { root, owner } }
      : root === undefined ? { pid } : undefined;
  }
}

function descendantCensus() {
  let remaining = MAX_CENSUS_ENTRIES;
  return async (dir: string): Promise<string[]> => {
    const names: string[] = [];
    for await (const entry of await opendir(dir)) {
      if (--remaining < 0) throw new Error("Capsule proof exceeds the census limit.");
      if (entry.name.endsWith(".json")) names.push(entry.name);
    }
    return names.sort();
  };
}

/** Direct edges for GC's whole-census ordering, including edges without PID proof. */
export async function linkedCapsuleRoots(home: string, root: string): Promise<Set<string>> {
  const dir = join(root, "descendants");
  const links = new Set<string>();
  const canonicalHome = await canonicalPath(home);
  if (capsuleParentPid(canonicalHome, root) === undefined) throw new Error("Invalid capsule path.");
  await requireStateDirectory(dirname(root));
  if (!(await lstat(root)).isDirectory() || !(await lstat(dir)).isDirectory()) throw new Error("Invalid capsule descendant directory.");
  for await (const record of readDescendants(canonicalHome, dir, await descendantCensus()(dir))) {
    if (!record) throw new Error("Invalid capsule descendant record.");
    if (record.linked) links.add(record.linked.root);
  }
  return links;
}

async function readCapsulePids(root: string, owner: CapsuleOwner, expectedPid?: number | null): Promise<Set<number>> {
  const pids = new Set<number>();
  if (expectedPid != null) pids.add(expectedPid);
  if (owner.child_pid != null) pids.add(owner.child_pid);
  try {
    const self = await readMetadata(join(root, "child_self.json"));
    if (!isRecord(self) || !isPid(self.pid)) throw new Error("Invalid capsule PID record.");
    pids.add(self.pid);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
  return pids;
}

/** Discover recorded child PIDs even while the tree is live. Not an exit proof. */
export async function inspectDescendantPids(home: string, root: string): Promise<{ pids: number[]; complete: boolean }> {
  const seen = new Set<string>();
  const pids = new Set<number>();
  const records = descendantCensus();
  let complete = true;
  async function visit(canonicalHome: string, path: string, ownerPid: number, depth: number): Promise<void> {
    if (depth > MAX_TREE_DEPTH || seen.has(path) || !(await lstat(path)).isDirectory()) throw new Error("Invalid capsule tree.");
    seen.add(path);
    try {
      const owner = parseOwner(await readMetadata(join(path, "owner.json")));
      if (owner.owner_pid !== ownerPid) throw new Error("Capsule owner does not match its path.");
      if (owner.child_pid != null) pids.add(owner.child_pid);
      const children = await readCapsulePids(path, owner);
      for (const pid of children) pids.add(pid);
      if ((owner.state === "spawning" || owner.state === "unreconciled") && children.size === 0) complete = false;
    } catch {
      complete = false;
    }
    const dir = join(path, "descendants");
    if (!(await lstat(dir)).isDirectory()) throw new Error("Invalid descendant directory.");
    for await (const record of readDescendants(canonicalHome, dir, await records(dir))) {
      if (!record) { complete = false; continue; }
      if (record.pid !== undefined) pids.add(record.pid);
      if (record.linked) {
        const { root, owner } = record.linked;
        try { await visit(canonicalHome, root, owner, depth + 1); }
        catch (error) {
          if (!(record.pid !== undefined && isErrno(error, "ENOENT") && pidExited(record.pid) && pidExited(owner))) complete = false;
        }
      }
    }
  }
  try {
    const canonicalHome = await canonicalPath(home);
    const owner = capsuleParentPid(canonicalHome, root);
    if (owner === undefined) throw new Error("Invalid capsule path.");
    await requireStateDirectory(dirname(root));
    await visit(canonicalHome, root, owner, 0);
  } catch {
    complete = false;
  }
  return { pids: [...pids], complete };
}

type CapsuleProof = { all_exited: boolean; has_child: boolean; state: OwnerState };

/** Live settlement permits only this process as the root owner; every descendant owner must be exited. */
export async function inspectCapsule(
  home: string, root: string, leaseChildPid?: number | null, ownerMode: "exited" | "live" = "exited",
): Promise<CapsuleProof | undefined> {
  const seen = new Set<string>();
  const records = descendantCensus();

  async function inspect(canonicalHome: string, root: string, ppid: number, expectedPid: number | null | undefined, depth: number): Promise<CapsuleProof> {
    if (depth > MAX_TREE_DEPTH || seen.has(root) || !(await lstat(root)).isDirectory()) {
      throw new Error("Invalid capsule tree.");
    }
    seen.add(root);
    const ownedHere = depth === 0 && ownerMode === "live";
    // Prove a stale owner is dead before sampling the child records it publishes.
    const ownerSettled = ownedHere ? ppid === process.pid : pidExited(ppid);
    const owner = parseOwner(await readMetadata(join(root, "owner.json")));
    if (owner.owner_pid !== ppid) throw new Error("Capsule owner does not match its path.");
    const childPids = await readCapsulePids(root, owner, expectedPid);
    const proof = { all_exited: false, has_child: childPids.size > 0, state: owner.state };
    if (!ownerSettled || (ownedHere && expectedPid != null && childPids.size !== 1)) return proof;
    if (![...childPids].every(pidExited)) return proof;

    // Start the census only once the processes that publish records have exited.
    const descendants = join(root, "descendants");
    const before = await lstat(descendants, { bigint: true });
    if (!before.isDirectory()) throw new Error("Invalid descendant directory.");
    const names = await records(descendants);
    for await (const record of readDescendants(canonicalHome, descendants, names)) {
      if (!record) throw new Error("Invalid descendant record.");
      const { pid, linked } = record;
      if (pid !== undefined && !pidExited(pid)) return proof;
      if (!linked) continue;
      if (seen.has(linked.root)) return proof;
      try {
        await lstat(linked.root);
      } catch (error) {
        // Only a published, exited PID can stand in for a retired capsule.
        if (!isErrno(error, "ENOENT")) throw error;
        if (pid === undefined || !pidExited(linked.owner)) return proof;
        continue;
      }
      const nested = await inspect(canonicalHome, linked.root, linked.owner, pid ?? null, depth + 1);
      if (!nested.all_exited || (!nested.has_child && pid === undefined)) return proof;
    }
    const finalNames = await records(descendants);
    const after = await lstat(descendants, { bigint: true });
    proof.all_exited = before.dev === after.dev && before.ino === after.ino
      && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs
      && finalNames.length === names.length && finalNames.every((name, index) => name === names[index]);
    return proof;
  }

  try {
    const canonicalHome = await canonicalPath(home);
    const ppid = capsuleParentPid(canonicalHome, root);
    if (ppid !== undefined) {
      await requireStateDirectory(dirname(root));
      return await inspect(canonicalHome, root, ppid, leaseChildPid, 0);
    }
  } catch {
    // Missing, partial, malformed, or over-limit evidence is not proof.
  }
  return undefined;
}
