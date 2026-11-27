import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export async function entryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

// Pi can allocate a path before its first persisted message. Existing dangling
// links must fail realpath, not be mistaken for a missing file.
export async function canonicalPath(path: string): Promise<string> {
  if (await entryExists(path)) return realpath(path);
  const parent = dirname(path);
  if (parent === path) return realpath(path);
  return join(await canonicalPath(parent), basename(path));
}

export async function requireRealDirectory(path: string, create = false) {
  if (create) {
    await mkdir(path, { mode: 0o700 }).catch(error => {
      if (!isErrno(error, "EEXIST")) throw error;
    });
  }
  const info = await lstat(path);
  if (!info.isDirectory()) throw new Error(`Expected a real directory: ${path}`);
  return info;
}

/** Caller canonicalizes the home, not the managed state directories beneath it. */
export async function requireStateDirectory(path: string, create = false) {
  const state = dirname(path);
  if (create) await mkdir(dirname(state), { recursive: true, mode: 0o700 });
  await requireRealDirectory(state, create);
  return requireRealDirectory(path, create);
}

const decoder = new TextDecoder("utf-8", { fatal: true });

type ReadOptions = { maxBytes: number; flags?: number };

/** Read bytes and metadata from the same descriptor, rejecting growth beyond the sampled size. */
export async function readBoundedRegularBytes(path: string, { maxBytes, flags = 0 }: ReadOptions) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | flags);
  try {
    const metadata = await file.stat({ bigint: true });
    if (!metadata.isFile() || metadata.size > maxBytes) throw new Error("Invalid regular file size or type.");
    const bytes = Buffer.allocUnsafe(Number(metadata.size) + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await file.read(bytes, used, bytes.length - used, null);
      if (bytesRead === 0) return { bytes: bytes.subarray(0, used), metadata };
      used += bytesRead;
    }
    throw new Error("File grew while being read.");
  } finally {
    await file.close();
  }
}

export async function readBoundedRegularText(
  path: string, options: ReadOptions,
): Promise<string> {
  const { bytes } = await readBoundedRegularBytes(path, options);
  return decoder.decode(bytes);
}

export async function readTextIfPresent(path: string, options: ReadOptions = { maxBytes: 1_048_576 }): Promise<string | undefined> {
  if (await entryExists(path)) return readBoundedRegularText(path, options);
  return undefined;
}
