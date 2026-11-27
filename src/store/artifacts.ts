import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, open, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { getLarvaHomePaths } from "../core/paths.ts";
import type { OutputSnapshot, RunTextSliceQuery, RunTextSliceResult } from "../core/types.ts";
import { canonicalPath, requireStateDirectory } from "./bounded-read.ts";

const inlineCodePoints = 36_000;
const previewCodePoints = 2_000;
const maxSlicePoints = 4_000;
type SliceRange = Pick<RunTextSliceQuery, "offset" | "length"> | RunTextSliceQuery;

function sliceCollector({ offset = 0, length = maxSlicePoints }: SliceRange) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 1 || length > maxSlicePoints) return;
  let skipped = 0;
  const points: string[] = [];
  let more = false;
  return {
    // Return true only on seeing a real lookahead code point.
    add(chunk: string): boolean {
      for (const point of chunk) {
        if (skipped < offset) { skipped++; continue; }
        if (points.length === length) { more = true; return true; }
        points.push(point);
      }
      return false;
    },
    result(): RunTextSliceResult {
      return { state: "ok", text: points.join(""), offset, length: points.length,
        ...(more ? { continuation_offset: offset + points.length } : {}) };
    },
  };
}

/** Slice an in-memory prompt or inline completion by Unicode code point. */
export function readRunTextSlice(text: string, query: SliceRange): RunTextSliceResult {
  const slice = sliceCollector(query);
  if (!slice) return { state: "unavailable" };
  slice.add(text);
  return slice.result();
}

/** Read only enough UTF-8 from a contained output file to satisfy the requested slice. */
export async function readArtifactSlice(home: string, path: string, query: SliceRange): Promise<RunTextSliceResult> {
  const slice = sliceCollector(query);
  if (!slice) return { state: "unavailable" };
  try {
    const directory = getLarvaHomePaths(await canonicalPath(home)).artifacts;
    if (dirname(path) !== directory || resolve(path) !== path || !path.endsWith(".txt") || path.includes("\0")) {
      return { state: "unavailable" };
    }
    await requireStateDirectory(directory);
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile()) return { state: "unavailable" };
      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      const buffer = Buffer.alloc(16_384);
      for (let remaining = before.size; remaining > 0n;) {
        const { bytesRead } = await file.read(buffer, 0, remaining < buffer.length ? Number(remaining) : buffer.length, null);
        if (bytesRead === 0) return { state: "unavailable" };
        remaining -= BigInt(bytesRead);
        if (slice.add(decoder.decode(buffer.subarray(0, bytesRead), { stream: remaining > 0n }))) break;
      }
      const after = await file.stat({ bigint: true });
      if (before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs) return slice.result();
    } finally {
      await file.close();
    }
  } catch {
    // GC may remove an artifact between snapshot lookup and open.
  }
  return { state: "unavailable" };
}

/** Persist complete output before publishing its reference. Delivery does not set run status. */
export async function writeOutputSnapshot(home: string, text: string): Promise<OutputSnapshot> {
  let points = 0;
  let previewEnd = 0;
  for (const char of text) {
    points++;
    if (points <= previewCodePoints) previewEnd += char.length;
    if (points > inlineCodePoints) break;
  }
  if (points <= inlineCodePoints) return { output_state: "inline", result_text: text };

  let staged: string | undefined;
  try {
    const bytes = Buffer.from(text, "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    // Count LF-delimited lines without treating a terminal newline as an extra line.
    let lines = bytes[bytes.length - 1] === 0x0a ? 0 : 1;
    for (const byte of bytes) if (byte === 0x0a) lines++;

    const directory = getLarvaHomePaths(await canonicalPath(home)).artifacts;
    const metadata = await requireStateDirectory(directory, true);
    if ((metadata.mode & 0o7777) !== 0o700) await chmod(directory, 0o700);

    const name = randomUUID();
    const path = join(directory, `${name}.txt`);
    const temporary = join(directory, `.artifact.tmp.${process.pid}.${name}`);
    const file = await open(temporary, "wx", 0o600);
    staged = temporary;
    try {
      await file.chmod(0o600);
      await file.writeFile(bytes);
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    return {
      output_state: "artifactized", result_preview: text.slice(0, previewEnd),
      full_output_artifact: { path, bytes: bytes.length, sha256, lines },
    };
  } catch {
    if (staged !== undefined) await unlink(staged).catch(() => undefined);
    return {
      output_state: "delivery_failed",
      output_diagnostic: { code: "LARVA_STORE_WRITE_FAILED", message: "Could not persist full output artifact." },
    };
  }
}
