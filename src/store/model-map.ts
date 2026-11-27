import { constants } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { loadModelMap, type ModelMapReader } from "../core/model-map.ts";
import { resolveContainedPath } from "../core/paths.ts";
import type { ModelMapDoc } from "../core/types.ts";
import { readBoundedRegularText as readRegularText } from "./bounded-read.ts";
import { isErrno } from "./capsule.ts";

export async function entryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

export function readBoundedRegularText(path: string, flags = 0): Promise<string> {
  return readRegularText(path, { maxBytes: 1_048_576, flags });
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
