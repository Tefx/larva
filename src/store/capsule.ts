import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, opendir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { LarvaError } from "../core/errors.ts";
import { getLarvaHomePaths, resolveContainedPath, resolveExtensionSources } from "../core/paths.ts";

const { O_RDONLY, O_NONBLOCK, O_NOFOLLOW, R_OK, X_OK } = constants;
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

export function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

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
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (!(await lstat(parent)).isDirectory()) {
    throw new LarvaError("LARVA_STORE_WRITE_FAILED", "Expected a real state directory.");
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  const entry = await lstat(path);
  if (!entry.isDirectory() || (entry.mode & 0o077) !== 0) {
    throw new LarvaError("LARVA_STORE_WRITE_FAILED", "Expected a private state directory.");
  }
}

/** Bounded, non-blocking reads of managed metadata, without following a final symlink. */
export async function readMetadata(path: string): Promise<unknown> {
  const file = await open(path, O_RDONLY | O_NONBLOCK | O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(65_537);
    if (!(await file.stat()).isFile()) throw new Error("Expected regular metadata file.");
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await file.read(buffer, used, buffer.length - used, used);
      if (bytesRead === 0) return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, used)));
      used += bytesRead;
    }
    throw new Error("Metadata exceeds the read limit.");
  } finally {
    await file.close();
  }
}

export function metadataObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

async function readPiConfig(path: string, name: string, flags: number): Promise<Buffer> {
  const file = await open(path, O_RDONLY | O_NONBLOCK | flags);
  try {
    const limit = 1_048_576;
    const entry = await file.stat();
    if (!entry.isFile() || entry.size > limit) {
      throw new LarvaError("LARVA_CONFIG_INVALID", `Pi ${name} must be a regular file of at most 1 MiB.`);
    }
    const bytes = Buffer.alloc(limit + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await file.read(bytes, used, bytes.length - used, used);
      if (bytesRead === 0) return bytes.subarray(0, used);
      used += bytesRead;
    }
    throw new LarvaError("LARVA_CONFIG_INVALID", `Pi ${name} exceeds 1 MiB.`);
  } finally {
    await file.close();
  }
}

async function readModels(agentDir: string): Promise<Buffer | undefined> {
  const root = resolve(agentDir);
  const path = join(root, "models.json");
  try {
    try {
      await lstat(path);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    }
    return await readPiConfig(await resolveContainedPath(root, path, realpath), "models.json", O_NOFOLLOW);
  } catch {
    throw new LarvaError("LARVA_CONFIG_INVALID", "Pi models.json must be a readable, contained regular file of at most 1 MiB.");
  }
}

export async function createCapsule(options: CapsuleOptions): Promise<{ root: string; extension_sources: string[] }> {
  const capsules = getLarvaHomePaths(options.home).capsules;
  const root = join(capsules, `child-${process.pid}-${randomBytes(16).toString("hex")}`);
  await privateDirectory(capsules);
  const [extension_sources, settings, models] = await Promise.all([
    resolveExtensionSources(options.extension_sources, {
      larvaHome: options.home,
      userHome: options.user_home ?? homedir(),
      piAgentDir: options.pi_agent_dir,
      realpath,
      async assertReadable(path) {
        const entry = await stat(path);
        if (!entry.isDirectory() && !entry.isFile()) throw new Error("Expected file or directory.");
        await access(path, entry.isDirectory() ? R_OK | X_OK : R_OK);
      },
    }),
    readPiConfig(join(options.pi_agent_dir, "settings.json"), "settings.json", 0).catch(error => {
      if (isErrno(error, "ENOENT")) return Buffer.from("{}\n");
      throw error;
    }),
    readModels(options.pi_agent_dir),
  ]);
  await mkdir(root, { mode: 0o700 });
  try {
    await mkdir(join(root, "descendants"), { mode: 0o700 });
    await writeFile(join(root, "settings.json"), settings, { mode: 0o600, flag: "wx" });
    if (models !== undefined) await writeFile(join(root, "models.json"), models, { mode: 0o600, flag: "wx" });
    await writeMetadata(join(root, "owner.json"), { owner_pid: process.pid, state: "reserving" } satisfies CapsuleOwner);
    return { root, extension_sources };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
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
  if (!metadataObject(value) || Object.keys(value).some(key => !["owner_pid", "state", "child_pid"].includes(key))) {
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

type DescendantRecord = { pid: unknown; linked?: { root: string; owner: number } };

async function* readDescendants(home: string, dir: string, names: readonly string[]): AsyncGenerator<DescendantRecord | undefined> {
  for (const name of names) {
    const record = await readMetadata(join(dir, name)).catch(() => undefined);
    if (!metadataObject(record)) {
      yield undefined;
      continue;
    }
    const { pid, capsule_root: root } = record;
    const owner = typeof root === "string" ? capsuleParentPid(home, root) : undefined;
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
  try {
    if (!(await lstat(root)).isDirectory() || !(await lstat(dir)).isDirectory()) return links;
    for await (const record of readDescendants(home, dir, await descendantCensus()(dir))) {
      if (record?.linked) links.add(record.linked.root);
    }
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
  return links;
}

type CapsuleProof = { all_exited: boolean; has_child: boolean; state: OwnerState };

/** Live settlement permits only this process as the root owner; every descendant owner must be exited. */
export async function inspectCapsule(
  home: string, root: string, leaseChildPid?: number | null, ownerMode: "exited" | "live" = "exited",
): Promise<CapsuleProof | undefined> {
  const seen = new Set<string>();
  const records = descendantCensus();

  async function inspect(root: string, ppid: number, expectedPid: number | null | undefined, depth: number): Promise<CapsuleProof> {
    if (depth > MAX_TREE_DEPTH || seen.has(root) || !(await lstat(root)).isDirectory()) {
      throw new Error("Invalid capsule tree.");
    }
    seen.add(root);
    const ownedHere = depth === 0 && ownerMode === "live";
    // Prove a stale owner is dead before sampling the child records it publishes.
    const ownerSettled = ownedHere ? ppid === process.pid : pidExited(ppid);
    const owner = parseOwner(await readMetadata(join(root, "owner.json")));
    if (owner.owner_pid !== ppid) throw new Error("Capsule owner does not match its path.");
    const childPids = new Set<number>();
    if (expectedPid != null) childPids.add(expectedPid);
    if (owner.child_pid != null) childPids.add(owner.child_pid);
    try {
      const self = await readMetadata(join(root, "child_self.json"));
      if (!metadataObject(self) || !isPid(self.pid)) throw new Error("Invalid capsule PID record.");
      childPids.add(self.pid);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
    const proof = { all_exited: false, has_child: childPids.size > 0, state: owner.state };
    if (!ownerSettled || (ownedHere && expectedPid != null && childPids.size !== 1)) return proof;
    if (![...childPids].every(pidExited)) return proof;

    // Start the census only once the processes that publish records have exited.
    const descendants = join(root, "descendants");
    const before = await lstat(descendants, { bigint: true });
    if (!before.isDirectory()) throw new Error("Invalid descendant directory.");
    const names = await records(descendants);
    for await (const record of readDescendants(home, descendants, names)) {
      if (!record) throw new Error("Invalid descendant record.");
      const { pid, linked } = record;
      if ((pid !== undefined && !isPid(pid)) || (pid === undefined && !linked)) throw new Error("Invalid descendant PID record.");
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
      const nested = await inspect(linked.root, linked.owner, pid ?? null, depth + 1);
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
    const ppid = capsuleParentPid(home, root);
    if (ppid !== undefined && (await lstat(dirname(root))).isDirectory()) return await inspect(root, ppid, leaseChildPid, 0);
  } catch {
    // Missing, partial, malformed, or over-limit evidence is not proof.
  }
  return undefined;
}
