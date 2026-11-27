import { Buffer } from "node:buffer";

export const ACTIVITY_WIRE_MAX_BYTES = 8192;

/** Measure the serialized wire text, including any escaping already applied by the caller. */
export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
