import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { LarvaError } from "../core/errors.ts";
import { getLarvaHomePaths, isLexicallyContained } from "../core/paths.ts";
import type { DiskLockState, DiskSessionSummary } from "../core/types.ts";
import { entryExists } from "./model-map.ts";

const HEADER_LIMIT = 1_048_576;

type SessionHeader = { task_id: string; version: 2 | 3; cwd: string };

function invalid(): LarvaError {
  return new LarvaError("LARVA_SESSION_INVALID", "Invalid Pi session header or transcript path.");
}

function parseHeader(bytes: Uint8Array, task_id: string): SessionHeader {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw invalid();
  }
  if (value === null || typeof value !== "object" || !("type" in value) || value.type !== "session"
      || !("version" in value) || !("cwd" in value)) throw invalid();
  const { version, cwd } = value;
  if ((version !== 2 && version !== 3) || typeof cwd !== "string" || !isAbsolute(cwd) || cwd.includes("\0")) {
    throw invalid();
  }
  return { task_id, version, cwd };
}

function sessionReadError(error: unknown): LarvaError {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    return new LarvaError("LARVA_SESSION_NOT_FOUND", "Session transcript is missing.");
  }
  return error instanceof LarvaError ? error : invalid();
}

// Pi can allocate its exact session path before the first persisted message.
export async function canonicalPath(path: string): Promise<string> {
  if (await entryExists(path)) return realpath(path);
  return join(await canonicalPath(dirname(path)), basename(path));
}

export async function resolveCanonicalSessionPath(home: string, taskId: string): Promise<string> {
  if (taskId.includes("\0") || !isAbsolute(taskId) || resolve(taskId) !== taskId || !taskId.endsWith(".jsonl")) throw invalid();
  try {
    const root = await canonicalPath(getLarvaHomePaths(home).sessions);
    // Check existing ancestors before classifying a missing leaf. A dangling
    // symlink fails realpath during canonicalization, so it is invalid too.
    if (!isLexicallyContained(root, taskId) || await canonicalPath(taskId) !== taskId) throw invalid();
    const info = await lstat(taskId).catch(error => { throw sessionReadError(error); });
    if (!info.isFile() || await realpath(taskId) !== taskId) throw invalid();
    return taskId;
  } catch (error) {
    throw error instanceof LarvaError ? error : invalid();
  }
}

export async function readSessionHeader(home: string, taskId: string): Promise<SessionHeader> {
  const task_id = await resolveCanonicalSessionPath(home, taskId);
  try {
    const file = await open(task_id, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      if (!(await file.stat()).isFile()) throw invalid();
      const buffer = Buffer.alloc(HEADER_LIMIT + 1);
      let used = 0;
      while (used < buffer.length) {
        const { bytesRead } = await file.read(buffer, used, Math.min(8192, buffer.length - used), used);
        if (bytesRead === 0) return parseHeader(buffer.subarray(0, used), task_id);
        const newline = buffer.subarray(used, used + bytesRead).indexOf(0x0a);
        if (newline !== -1) return parseHeader(buffer.subarray(0, used + newline), task_id);
        used += bytesRead;
      }
      throw invalid();
    } finally {
      await file.close();
    }
  } catch (error) {
    throw sessionReadError(error);
  }
}

async function sessionCwdExists(cwd: string): Promise<boolean> {
  try {
    return (await stat(cwd)).isDirectory();
  } catch {
    return false;
  }
}

type LockReader = { diskLockState(taskId: string): Promise<DiskLockState> };

export async function readDiskSession(home: string, taskId: string, leases: LockReader): Promise<DiskSessionSummary> {
  const { task_id, cwd } = await readSessionHeader(home, taskId);
  const [cwd_exists, lock_state] = await Promise.all([sessionCwdExists(cwd), leases.diskLockState(task_id)]);
  return { task_id, cwd, cwd_exists, lock_state };
}

export async function scanDiskSessions(home: string, leases: LockReader): Promise<DiskSessionSummary[]> {
  let root: string, names: string[];
  try {
    root = await realpath(getLarvaHomePaths(home).sessions);
    names = await readdir(root);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const sessions: DiskSessionSummary[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".jsonl")) continue;
    try {
      sessions.push(await readDiskSession(home, join(root, name), leases));
    } catch (error) {
      // Exact lookup reports the error; a bad/disappearing sibling must not hide
      // the rest of the index.
      if (!(error instanceof LarvaError) || (error.code !== "LARVA_SESSION_INVALID" && error.code !== "LARVA_SESSION_NOT_FOUND")) {
        throw error;
      }
    }
  }
  return sessions;
}
