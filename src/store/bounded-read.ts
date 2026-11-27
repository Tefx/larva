import { constants } from "node:fs";
import { open } from "node:fs/promises";

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
