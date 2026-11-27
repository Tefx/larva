import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { getLarvaHomePaths } from "../core/paths.ts";
import type { OutputSnapshot } from "../core/types.ts";
import { canonicalPath } from "./session-index.ts";

const inlineCodePoints = 36_000;
const previewCodePoints = 2_000;

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
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(directory);
    if (!metadata.isDirectory()) throw new Error("Artifact path is not a directory.");
    if ((metadata.mode & 0o7777) !== 0o700) await chmod(directory, 0o700);

    const name = randomUUID();
    const path = join(directory, `${name}.txt`);
    const temporary = join(directory, `.${name}.tmp`);
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
