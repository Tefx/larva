import { createHash, randomBytes } from "node:crypto";
import { link, lstat, mkdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { LarvaError } from "../core/errors.ts";
import { getLarvaHomePaths, isLexicallyContained } from "../core/paths.ts";
import type { DiskLockState, SessionLeaseRecord } from "../core/types.ts";
import { canonicalPath } from "./session-index.ts";

type LeaseIO = Pick<typeof import("./capsule.ts"),
  "privateDirectory" | "readMetadata" | "writeMetadata" | "metadataObject" | "isErrno" | "isPid"
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

/** Bind the filesystem/evidence primitives supplied by the capsule module. */
export function createSessionLeaseStore(home: string, io: LeaseIO) {
  const configuredSessions = getLarvaHomePaths(home).sessions;

  async function lockPath(taskId: string) {
    const canonicalHome = await canonicalPath(home);
    const sessions = getLarvaHomePaths(canonicalHome).sessions;
    if (!taskId.endsWith(".jsonl") || taskId.includes("\0")
        || (!isLexicallyContained(sessions, taskId) && !isLexicallyContained(configuredSessions, taskId))) {
      throw new LarvaError("LARVA_SESSION_INVALID", "Expected a contained .jsonl task_id.");
    }
    return { path: join(sessions, `${basename(taskId)}.lock`), canonicalHome };
  }

  function parseRecord(value: unknown, canonicalHome: string): SessionLeaseRecord | undefined {
    if (!io.metadataObject(value) || Object.keys(value).some(key => !LEASE_KEYS.includes(key))) return undefined;
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
      if (!(await lstat(dirname(path))).isDirectory() || !(await lstat(path)).isDirectory()) return "invalid";
    } catch (error) {
      return io.isErrno(error, "ENOENT") ? "missing" : "invalid";
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

    // Hash untrusted IDs before using them in a pathname; generated IDs are opaque.
    const prefix = createHash("sha256").update(observedId).digest("hex");
    const stage = `${path}.guard.tmp.${process.pid}.${randomId()}`;
    let claim: string | undefined;
    await io.writeMetadata(stage, { pid: process.pid });
    try {
      for (let slot = 0; ; slot++) {
        const candidate = join(path, `.reclaim.${prefix}.${slot}`);
        try {
          await link(stage, candidate);
          claim = candidate;
          break;
        } catch (error) {
          if (io.isErrno(error, "ENOENT")) return false;
          if (!io.isErrno(error, "EEXIST")) throw error;
        }
        let guard: unknown;
        try {
          guard = await io.readMetadata(candidate);
        } catch {
          return false;
        }
        if (!io.metadataObject(guard) || !(guard.done === true || (io.isPid(guard.pid) && io.pidExited(guard.pid)))) return false;
      }

      // Re-read under the claim, after which no protocol participant can move
      // this instance until our guard settles. This is the compare-and-swap.
      const current = await read(path, canonicalHome);
      if (typeof current === "string" || current.lease_id !== observedId || !io.pidExited(current.owner_pid)) return false;
      if (await assess(current, canonicalHome) === "stale") {
        await detach(path);
        claim = undefined;
        return true;
      }
      if (current.state === "spawning") {
        await io.writeMetadata(join(path, "lease.json"), { ...current, state: "unreconciled" });
      }
      return false;
    } finally {
      try {
        // A rename may already have installed a successor. Only settle a claim
        // still belonging to the observed instance.
        if (claim !== undefined) {
          const current = await read(path, canonicalHome);
          if (typeof current !== "string" && current.lease_id === observedId) await io.writeMetadata(claim, { done: true });
        }
      } finally {
        await rm(stage, { force: true }).catch(() => {});
      }
    }
  }

  async function acquire(taskId: string, state: "reserving" | "gc_unlinking" = "reserving"): Promise<LeaseHandle> {
    const target = await lockPath(taskId);
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
        if (io.isErrno(error, "EEXIST") || io.isErrno(error, "ENOTEMPTY") || io.isErrno(error, "ENOTDIR")) throw busy();
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
    async reclaim(taskId: string, observedId: string) { return reclaimLock(await lockPath(taskId), observedId); },
  };
}
