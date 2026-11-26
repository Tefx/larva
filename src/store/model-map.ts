import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { loadModelMap, type ModelMapReader } from "../core/model-map.ts";
import { resolveContainedPath } from "../core/paths.ts";
import type { ModelMapDoc } from "../core/types.ts";
import { isErrno } from "./capsule.ts";

const MAX_CONFIG_BYTES = 1_048_576;

export async function entryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

export async function readBoundedRegularText(path: string, flags = 0): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | flags);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES) throw new Error("Invalid configuration file size or type.");
    const bytes = Buffer.allocUnsafe(info.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await file.read(bytes, used, bytes.length - used, null);
      if (bytesRead === 0) return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used));
      used += bytesRead;
    }
    throw new Error("Configuration file grew while being read.");
  } finally {
    await file.close();
  }
}

export function diskModelMapReader(home: string): ModelMapReader {
  return {
    entryExists,
    resolveContainedPath: (_root, path) => resolveContainedPath(home, path, realpath),
    // The selected entry can be a symlink; open its resolved target instead.
    readText: path => readBoundedRegularText(path, constants.O_NOFOLLOW),
  };
}

export function loadDiskModelMap(home: string, path: string): Promise<ModelMapDoc | undefined> {
  return loadModelMap(home, path, diskModelMapReader(home));
}
