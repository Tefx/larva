import { createHash, randomBytes } from "node:crypto";
import { link, lstat, mkdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { LarvaError } from "../core/errors.ts";
import { getLarvaHomePaths } from "../core/paths.ts";
import { isRecord } from "../core/predicates.ts";
import type { DiskLockState, SessionLeaseRecord } from "../core/types.ts";
import { canonicalPath, isErrno, requireStateDirectory } from "./bounded-read.ts";
import { isPid, pidExited, readMetadata, writeMetadata } from "./capsule.ts";
import { MAX_SESSION_NAME_BYTES } from "./session-index.ts";

type LeaseIO = Pick<typeof import("./capsule.ts"),
  "privateDirectory" | "readMetadata" | "writeMetadata" | "isPid"
  | "pidExited" | "capsuleParentPid" | "inspectCapsule"
>;
type Inspection =
  | { disposition: "missing" | "invalid" }
  | { disposition: "active" | "uncertain" | "stale"; record: SessionLeaseRecord };
type LeaseHandle = {
  lease_id: string;
  markSpawning(capsuleRoot: string): Promise<void>;
  markRunning(childPid: number): Promise<void>;
  markUnreconciled(): Promise<void>;
  /** Called by the owner only after ownership settlement (or before spawn). */
  release(): Promise<void>;
};

const LEASE_KEYS = ["lease_id", "owner_pid", "state", "child_pid", "capsule_root"];
const randomId = () => randomBytes(16).toString("hex");

/** Serialize recovery for one observed instance; the callback must recheck its ID before mutation. */
export async function withReclaimClaim(path: string, observedId: string, recover: () => Promise<boolean>): Promise<boolean> {
  const prefix = createHash("sha256").update(observedId).digest("hex");
  const stage = join(dirname(path), `.guard.tmp.${process.pid}.${randomId()}`);
  await writeMetadata(stage, { pid: process.pid });
  try {
    for (let slot = 0; ; slot++) {
      const candidate = join(path, `.reclaim.${prefix}.${slot}`);
      try {
        await link(stage, candidate);
        break;
      } catch (error) {
        if (isErrno(error, "ENOENT")) return false;
        if (!isErrno(error, "EEXIST")) throw error;
      }
      try {
        // Never recycle slots. Removing the private source drops the claim's
        // link count and settles it, without rewriting the shared pathname.
        const info = await lstat(candidate);
        if (!info.isFile()) return false;
        const guard = await readMetadata(candidate);
        if (!isRecord(guard)) return false;
        if (guard.done === true) continue;
        if (!isPid(guard.pid) || (info.nlink !== 1 && !pidExited(guard.pid))) return false;
      } catch {
        return false;
      }
    }
    return await recover();
  } finally {
    await rm(stage, { force: true }).catch(() => {});
  }
}

/** Bind the filesystem/evidence primitives supplied by the capsule module. */
export function createSessionLeaseStore(home: string, io: LeaseIO) {
  const configuredSessions = getLarvaHomePaths(home).sessions;

  async function lockPath(taskId: string) {
    const canonicalHome = await canonicalPath(home);
    const sessions = getLarvaHomePaths(canonicalHome).sessions;
    if (!taskId.endsWith(".jsonl") || taskId.includes("\0") || resolve(taskId) !== taskId
        || (dirname(taskId) !== sessions && dirname(taskId) !== configuredSessions)) {
      throw new LarvaError("LARVA_SESSION_INVALID", "Expected a contained .jsonl task_id.");
    }
    return { path: join(sessions, `${basename(taskId)}.lock`), canonicalHome };
  }

  function parseRecord(value: unknown, canonicalHome: string): SessionLeaseRecord | undefined {
    if (!isRecord(value) || Object.keys(value).some(key => !LEASE_KEYS.includes(key))) return undefined;
    const { lease_id, state, owner_pid, child_pid, capsule_root } = value;
    if (typeof lease_id !== "string" || !lease_id.trim() || !io.isPid(owner_pid)) return undefined;
    if ((state === "reserving" || state === "gc_unlinking") && child_pid === null && capsule_root === null) {
      return { lease_id, state, owner_pid, child_pid, capsule_root };
    }
    if (typeof capsule_root !== "string" || io.capsuleParentPid(canonicalHome, capsule_root) !== owner_pid) return undefined;
    if (state === "spawning" && child_pid === null) return { lease_id, state, owner_pid, child_pid, capsule_root };
    if (state === "running" && io.isPid(child_pid)) return { lease_id, state, owner_pid, child_pid, capsule_root };
    if (state === "unreconciled" && (child_pid === null || io.isPid(child_pid))) {
      return { lease_id, state, owner_pid, child_pid, capsule_root };
    }
    return undefined;
  }

  async function read(path: string, canonicalHome: string): Promise<SessionLeaseRecord | "missing" | "invalid"> {
    try {
      await requireStateDirectory(dirname(path));
      if (!(await lstat(path)).isDirectory()) return "invalid";
    } catch (error) {
      return isErrno(error, "ENOENT") ? "missing" : "invalid";
    }
    try {
      return parseRecord(await io.readMetadata(join(path, "lease.json")), canonicalHome) ?? "invalid";
    } catch {
      // Present but unreadable is not equivalent to no lease.
      return "invalid";
    }
  }

  async function assess(record: SessionLeaseRecord, canonicalHome: string): Promise<"active" | "uncertain" | "stale"> {
    if (!io.pidExited(record.owner_pid)) return record.state === "unreconciled" ? "uncertain" : "active";
    if (record.capsule_root === null) return "stale";
    const capsule = await io.inspectCapsule(canonicalHome, record.capsule_root, record.child_pid);
    return capsule?.all_exited && capsule.has_child ? "stale" : "uncertain";
  }

  async function inspect(taskId: string): Promise<Inspection> {
    const { path, canonicalHome } = await lockPath(taskId);
    if (Buffer.byteLength(basename(taskId)) > MAX_SESSION_NAME_BYTES) return { disposition: "invalid" };
    const record = await read(path, canonicalHome);
    if (typeof record === "string") return { disposition: record };
    return { disposition: await assess(record, canonicalHome), record };
  }

  async function diskLockState(taskId: string): Promise<DiskLockState> {
    const lease = await inspect(taskId);
    if (lease.disposition === "missing" || lease.disposition === "stale") return "unlocked";
    if (lease.disposition !== "active") return "unreconciled";
    return lease.record.owner_pid === process.pid ? "active_local" : "active_external";
  }

  async function detach(path: string): Promise<void> {
    // Never remove lease.json at the public path while the directory is installed.
    const detached = `${path}.retired.${process.pid}.${randomId()}`;
    await rename(path, detached);
    // Detach is the commit point; cleanup of a private tombstone cannot undo it.
    await rm(detached, { recursive: true, force: true }).catch(() => {});
  }

  /**
   * Claim immutable slots scoped to this lease ID. Never recycle a slot: a delayed
   * contender could otherwise mistake a successor's guard for its own. A dead or
   * settled guard permits trying the next slot without ever unlinking a guard.
   */
  async function reclaimLock({ path, canonicalHome }: Awaited<ReturnType<typeof lockPath>>, observedId: string): Promise<boolean> {
    const observed = await read(path, canonicalHome);
    if (typeof observed === "string" || observed.lease_id !== observedId || !io.pidExited(observed.owner_pid)) return false;
    const disposition = await assess(observed, canonicalHome);
    if (disposition !== "stale" && observed.state !== "spawning") return false;

    return withReclaimClaim(path, observedId, async () => {
      const current = await read(path, canonicalHome);
      if (typeof current === "string" || current.lease_id !== observedId || !io.pidExited(current.owner_pid)) return false;
      if (await assess(current, canonicalHome) === "stale") {
        await detach(path);
        return true;
      }
      if (current.state === "spawning") {
        await io.writeMetadata(join(path, "lease.json"), { ...current, state: "unreconciled" });
      }
      return false;
    });
  }

  async function acquire(taskId: string, state: "reserving" | "gc_unlinking" = "reserving"): Promise<LeaseHandle> {
    const target = await lockPath(taskId);
    if (Buffer.byteLength(basename(taskId)) > MAX_SESSION_NAME_BYTES) {
      throw new LarvaError("LARVA_SESSION_INVALID", `Session filename exceeds ${MAX_SESSION_NAME_BYTES} UTF-8 bytes.`);
    }
    const { path, canonicalHome } = target;
    const lease_id = randomId();
    const temp = `${path}.tmp.${process.pid}.${lease_id}`;
    const owner_pid = process.pid;
    const initial: SessionLeaseRecord = { lease_id, owner_pid, state, child_pid: null, capsule_root: null };
    const busy = () => new LarvaError("LARVA_SESSION_BUSY", "Session already has an active or unreconciled lease.");
    await io.privateDirectory(dirname(path));
    await mkdir(temp, { mode: 0o700 });
    try {
      await io.writeMetadata(join(temp, "lease.json"), initial);
      const current = await read(path, canonicalHome);
      if (current === "invalid") throw busy();
      if (typeof current !== "string" && !await reclaimLock(target, current.lease_id)) throw busy();
      try {
        await rename(temp, path);
      } catch (error) {
        if (isErrno(error, "EEXIST") || isErrno(error, "ENOTEMPTY") || isErrno(error, "ENOTDIR")) throw busy();
        throw error;
      }
    } finally {
      await rm(temp, { recursive: true, force: true }).catch(() => {});
    }

    // Queue calls on this handle so two owner transitions cannot read the same
    // pre-image and publish in reverse order. External reclaim needs owner ESRCH.
    let settled = Promise.resolve();
    function mutate(operation: (current: SessionLeaseRecord) => Promise<void>): Promise<void> {
      const next = settled.then(async () => {
        const current = await read(path, canonicalHome);
        if (typeof current === "string" || current.lease_id !== lease_id) throw busy();
        await operation(current);
      });
      settled = next.catch(() => {});
      return next;
    }

    async function publish(next: SessionLeaseRecord): Promise<void> {
      await io.writeMetadata(join(path, "lease.json"), next);
    }

    return {
      lease_id,
      markSpawning: capsule_root => mutate(async current => {
        if (current.state !== "reserving" || io.capsuleParentPid(canonicalHome, capsule_root) !== process.pid) throw busy();
        await requireStateDirectory(dirname(capsule_root));
        if (!(await lstat(capsule_root)).isDirectory()) throw busy();
        // Write capsule intent first. An interruption between these writes may
        // retain an orphan, but can never erase ambiguous spawn evidence.
        await io.writeMetadata(join(capsule_root, "owner.json"), { owner_pid, state: "spawning" });
        await publish({ ...current, state: "spawning", capsule_root });
      }),
      markRunning: child_pid => mutate(async current => {
        if (current.state !== "spawning" || !io.isPid(child_pid)) throw busy();
        await io.writeMetadata(join(current.capsule_root, "owner.json"), { owner_pid, state: "running", child_pid });
        await publish({ ...current, state: "running", child_pid });
      }),
      markUnreconciled: () => mutate(async current => {
        if (current.state === "unreconciled") return;
        if (current.state !== "spawning" && current.state !== "running") throw busy();
        await publish({ ...current, state: "unreconciled" });
      }),
      release: () => mutate(() => detach(path)),
    };
  }

  return { home, acquire, inspect, diskLockState,
    async reclaim(taskId: string, observedId: string) {
      const target = await lockPath(taskId);
      return Buffer.byteLength(basename(taskId)) <= MAX_SESSION_NAME_BYTES && reclaimLock(target, observedId);
    },
  };
}
