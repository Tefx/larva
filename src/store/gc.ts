import type { Stats } from "node:fs";
import { lstat, readdir, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { parseLarvaConfig } from "../core/config.ts";
import { LarvaError } from "../core/errors.ts";
import { getLarvaHomePaths } from "../core/paths.ts";
import type { GcConfig, GcReport, SessionLeaseRecord } from "../core/types.ts";

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

function absent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

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
  const home = leases.home;
  const paths = getLarvaHomePaths(home);
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

  // Reconsider the leases first. An outstanding lease may still need the
  // capsule's positive PID evidence; do not erase it before the lease settles.
  const pinned = new Map<string, boolean>();
  for (const name of await names(paths.sessions)) {
    if (!name.endsWith(".jsonl.lock")) continue;
    const path = join(paths.sessions, name.slice(0, -".lock".length));
    let inspection = await leases.inspect(path);
    if (!dry_run && "record" in inspection && (inspection.disposition === "stale" || inspection.disposition === "uncertain")) {
      await leases.reclaim(path, inspection.record.lease_id);
      inspection = await leases.inspect(path);
    }
    if (!("record" in inspection) || inspection.record.capsule_root === null) continue;
    const root = inspection.record.capsule_root;
    pinned.set(root, pinned.get(root) === true || inspection.disposition === "uncertain");
  }

  const graph = new Map<string, { incoming: number; links: Set<string> }>();
  const retained = new Set<string>();
  for (const name of await names(paths.capsules)) {
    const root = join(paths.capsules, name);
    const ppid = capsules.capsuleParentPid(home, root);
    if (ppid === undefined || !(await entry(root))?.isDirectory()) continue;
    graph.set(root, { incoming: 0, links: new Set() });
    if (pinned.has(root) || !capsules.pidExited(ppid)) {
      retained.add(root);
      if (pinned.get(root)) report.unreconciled_capsules.push(root);
      continue;
    }
    const proof = await capsules.inspectCapsule(home, root);
    const unreconciled = !proof || ((proof.state === "spawning" || proof.state === "unreconciled") && (!proof.all_exited || !proof.has_child));
    if (unreconciled) report.unreconciled_capsules.push(root);
    if (unreconciled || !proof.all_exited) retained.add(root);
  }

  // Sample links after exit checks, so an intent published by a just-exited
  // owner is visible before any of its evidence becomes eligible for removal.
  for (const [root, node] of graph) {
    node.links = await capsules.linkedCapsuleRoots(home, root);
    for (const link of node.links) {
      const child = graph.get(link);
      if (child) child.incoming++;
    }
  }
  // A single topological pass propagates retention and removes ancestors first.
  // Cycles (and everything dependent on them) never reach zero incoming edges.
  const ready = [...graph.keys()].filter(root => graph.get(root)!.incoming === 0);
  for (const root of ready) {
    if (!retained.has(root) && !dry_run) await rm(root, { recursive: true, force: true });
    for (const link of graph.get(root)!.links) {
      const child = graph.get(link);
      if (!child) continue;
      if (retained.has(root)) retained.add(link);
      if (--child.incoming === 0) ready.push(link);
    }
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
      await lease?.release();
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
