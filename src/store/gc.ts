import type { Stats } from "node:fs";
import { lstat, readdir, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { parseLarvaConfig } from "../core/config.ts";
import { LarvaError } from "../core/errors.ts";
import { getLarvaHomePaths } from "../core/paths.ts";
import type { GcConfig, GcReport, SessionLeaseRecord } from "../core/types.ts";
import { canonicalPath, isErrno } from "./bounded-read.ts";

type GcOptions = Partial<GcConfig> & {
  dry_run?: boolean;
  leases: {
    readonly home: string;
    inspect(taskId: string): Promise<
      | { disposition: "missing" | "invalid" }
      | { disposition: "active" | "uncertain" | "stale"; record: SessionLeaseRecord }
    >;
    reclaim(taskId: string, leaseId: string): Promise<boolean>;
    acquire(taskId: string, state: "gc_unlinking"): Promise<{ release(): Promise<void> }>;
  };
  capsules: Pick<typeof import("./capsule.ts"), "capsuleParentPid" | "pidExited" | "inspectCapsule" | "linkedCapsuleRoots">;
};

type Candidate = { path: string; session: boolean; stat: Stats };
const DAY_MS = 86_400_000;

const absent = (error: unknown) => isErrno(error, "ENOENT");
const SESSION_DEBRIS = /^(?:[\s\S]*\.jsonl\.lock\.(?:tmp|guard\.tmp)|\.guard\.tmp)\.([1-9][0-9]{0,9})\.[a-f0-9]{32}(?:\.tmp\.[1-9][0-9]{0,9}\.[a-f0-9]{32})?$/;
// Public lease detachment is the commit point; no PID proof is needed afterward.
const RETIRED_LEASE = /^[\s\S]*\.jsonl\.lock\.retired\.([1-9][0-9]{0,9})\.[a-f0-9]{32}$/;
const CAPSULE_DEBRIS = /^\.child-([1-9][0-9]{0,9})-[a-f0-9]{32}\.tmp$/;
const ARTIFACT_DEBRIS = /^\.artifact\.tmp\.([1-9][0-9]{0,9})\.[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

async function entry(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (absent(error)) return undefined;
    throw error;
  }
}

async function names(path: string): Promise<string[]> {
  try {
    return (await entry(path))?.isDirectory() ? (await readdir(path)).sort() : [];
  } catch (error) {
    if (absent(error)) return [];
    throw error;
  }
}

export async function runGc(options: GcOptions): Promise<GcReport> {
  const { dry_run, leases, capsules } = options;
  const canonicalHome = await canonicalPath(leases.home);
  const paths = getLarvaHomePaths(canonicalHome);
  const { max_age_days, max_bytes } = parseLarvaConfig({ gc: {
    ...(options.max_age_days === undefined ? {} : { max_age_days: options.max_age_days }),
    ...(options.max_bytes === undefined ? {} : { max_bytes: options.max_bytes }),
  } }).gc;
  const now = Date.now();
  const retention = max_bytes === undefined ? 60_000 : DAY_MS;
  const report: GcReport & { unreconciled_capsules: string[] } = {
    deleted_sessions: 0, deleted_artifacts: 0, freed_bytes: 0, remaining_bytes: 0,
    protected_bytes: 0, budget_met: true, unreconciled_capsules: [],
  };
  if (!(await entry(paths.state))?.isDirectory()) return report;

  // Snapshot capsule proof before sweeping leases, but don't remove any
  // evidence until the scan has reconciled and rechecked its lease references.
  const capsuleNames = await names(paths.capsules);
  const graph = new Map<string, { incoming: number; links: Set<string> }>();
  const retained = new Set<string>();
  const unreconciled = new Set<string>();
  for (const name of capsuleNames) {
    const root = join(paths.capsules, name);
    const ppid = capsules.capsuleParentPid(canonicalHome, root);
    if (ppid === undefined || !(await entry(root))?.isDirectory()) continue;
    graph.set(root, { incoming: 0, links: new Set() });
    if (!capsules.pidExited(ppid)) { retained.add(root); continue; }
    const proof = await capsules.inspectCapsule(canonicalHome, root);
    if (!proof || ((proof.state === "spawning" || proof.state === "unreconciled") && (!proof.all_exited || !proof.has_child))) {
      unreconciled.add(root);
    }
    if (!proof?.all_exited || unreconciled.has(root)) retained.add(root);
  }

  const sessionNames = await names(paths.sessions);
  let unknownReferences = false;
  for (const name of sessionNames) {
    if (!name.endsWith(".jsonl.lock")) continue;
    const path = join(paths.sessions, name.slice(0, -".lock".length));
    let inspection = await leases.inspect(path);
    if (!dry_run && "record" in inspection && (inspection.disposition === "stale" || inspection.disposition === "uncertain")) {
      await leases.reclaim(path, inspection.record.lease_id);
      inspection = await leases.inspect(path);
    }
    if (inspection.disposition === "invalid") unknownReferences = true;
    if (!("record" in inspection) || inspection.record.capsule_root === null) continue;
    const root = inspection.record.capsule_root;
    if (!(dry_run && inspection.disposition === "stale")) retained.add(root);
    if (inspection.disposition === "uncertain") unreconciled.add(root);
  }

  // Sample links after exit checks, so an intent published by a just-exited
  // owner is visible before any of its evidence becomes eligible for removal.
  for (const [root, node] of graph) {
    try {
      node.links = await capsules.linkedCapsuleRoots(canonicalHome, root);
    } catch {
      if (await entry(root)) {
        unreconciled.add(root);
        unknownReferences = true; // The unreadable record could refer to any capsule.
      }
    }
    for (const link of node.links) {
      const child = graph.get(link);
      if (child) child.incoming++;
    }
  }
  if (unknownReferences) {
    for (const root of graph.keys()) if (!retained.has(root)) unreconciled.add(root);
  }
  report.unreconciled_capsules = [...unreconciled].sort();

  // A single topological pass propagates retention and removes ancestors first.
  // Cycles (and everything dependent on them) never reach zero incoming edges.
  const ready = [...graph.keys()].filter(root => graph.get(root)!.incoming === 0);
  for (const root of ready) {
    if (!unknownReferences && !retained.has(root) && !dry_run) await rm(root, { recursive: true, force: true });
    for (const link of graph.get(root)!.links) {
      const child = graph.get(link);
      if (!child) continue;
      if (retained.has(root)) retained.add(link);
      if (--child.incoming === 0) ready.push(link);
    }
  }

  async function cleanDebris(directory: string, entries: string[], pattern: RegExp, retired = false) {
    for (const name of entries) {
      const pid = Number(pattern.exec(name)?.[1]);
      if (!Number.isInteger(pid) || pid > 0x7fff_ffff || (!retired && !capsules.pidExited(pid))) continue;
      const path = join(directory, name);
      const info = await entry(path);
      if (info?.isDirectory() || info?.isFile()) await rm(path, { recursive: info.isDirectory(), force: true });
    }
  }
  if (!dry_run) {
    await cleanDebris(paths.sessions, sessionNames, SESSION_DEBRIS);
    await cleanDebris(paths.sessions, sessionNames, RETIRED_LEASE, true);
    await cleanDebris(paths.capsules, capsuleNames, CAPSULE_DEBRIS);
    await cleanDebris(paths.artifacts, await names(paths.artifacts), ARTIFACT_DEBRIS);
  }

  async function locked(path: string): Promise<boolean> {
    const { disposition } = await leases.inspect(path);
    return disposition !== "missing" && !(dry_run && disposition === "stale");
  }

  const protectedMtime = (stat: Stats) => now - stat.mtimeMs <= retention;
  const rank = (a: Candidate, b: Candidate) => a.stat.mtimeMs - b.stat.mtimeMs || a.path.localeCompare(b.path);
  const deleted = new Set<string>();

  async function census(): Promise<Candidate[]> {
    const candidates: Candidate[] = [];
    for (const session of [true, false]) {
      const dir = session ? paths.sessions : paths.artifacts;
      for (const name of await names(dir)) {
        if (!name.endsWith(session ? ".jsonl" : ".txt")) continue;
        const path = join(dir, name);
        if (dry_run && deleted.has(path)) continue;
        const stat = await entry(path);
        if (stat?.isFile()) candidates.push({ path, session, stat });
      }
    }
    return candidates.sort(rank);
  }

  async function remove(candidate: Candidate, minAge: number): Promise<boolean> {
    const { path, session } = candidate;
    if (protectedMtime(candidate.stat) || (session && await locked(path))) return false;
    let lease;
    if (session && !dry_run) {
      try {
        lease = await leases.acquire(path, "gc_unlinking");
      } catch (error) {
        if (error instanceof LarvaError && error.code === "LARVA_SESSION_BUSY") return false;
        throw error;
      }
    }
    try {
      const current = await entry(path);
      if (!current?.isFile() || current.dev !== candidate.stat.dev || current.ino !== candidate.stat.ino
          || current.mtimeMs !== candidate.stat.mtimeMs || current.size !== candidate.stat.size
          || protectedMtime(current) || now - current.mtimeMs <= minAge) return false;
      if (!dry_run) {
        try {
          await unlink(path);
        } catch (error) {
          if (absent(error)) return false;
          throw error;
        }
      }
      deleted.add(path);
      if (session) report.deleted_sessions++;
      else report.deleted_artifacts++;
      report.freed_bytes += current.size;
      return true;
    } finally {
      // A release failure may leave a conservative lock, but doesn't undo unlink.
      try { await lease?.release(); } catch { /* Unlink is already committed. */ }
    }
  }

  for (const candidate of await census()) {
    if (now - candidate.stat.mtimeMs > max_age_days * DAY_MS) await remove(candidate, max_age_days * DAY_MS);
  }

  if (max_bytes !== undefined) {
    const remaining = await census();
    let total = remaining.reduce((sum, candidate) => sum + candidate.stat.size, 0);
    for (const candidate of remaining) {
      if (total <= max_bytes) break;
      if (await remove(candidate, DAY_MS)) total -= candidate.stat.size;
    }
  }

  for (const { path, session, stat } of await census()) {
    report.remaining_bytes += stat.size;
    if (protectedMtime(stat) || (session && await locked(path))) report.protected_bytes += stat.size;
  }
  report.budget_met = max_bytes === undefined || report.remaining_bytes <= max_bytes;
  return report;
}
