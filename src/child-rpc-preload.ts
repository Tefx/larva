import { randomUUID } from "node:crypto";
import { closeSync, linkSync, lstatSync, openSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const BRIDGE = Symbol.for("larva.pi.child-rpc-frame-preload.v1");
const MAX_RECORD_BYTES = 1_048_576;
const CAPABILITY = {
  capability: "larva-child-rpc-frame-preload-v1",
  max_record_bytes: MAX_RECORD_BYTES,
  framing: "lf-only",
  terminal: "agent_settled",
} as const;

function recordChildPid(): void {
  const home = process.env.LARVA_HOME || join(homedir(), ".larva");
  const root = process.env.LARVA_PI_CAPSULE_ROOT;
  if (root === undefined || home !== resolve(home) || root !== resolve(root)
    || home.includes("\0") || root.includes("\0")) {
    throw new Error("Invalid Larva child capsule path.");
  }
  const canonicalHome = realpathSync(home);
  const parent = join(canonicalHome, "state", "capsules");
  const name = basename(root);
  const match = /^child-([1-9][0-9]*)-[a-f0-9]+$/.exec(name);
  if ((dirname(root) !== parent && dirname(root) !== join(home, "state", "capsules"))
    || !match || (process.ppid !== 1 && match[1] !== String(process.ppid))
    || realpathSync(root) !== join(parent, name) || !lstatSync(root).isDirectory()) {
    throw new Error("Larva child capsule is not an owned directory under LARVA_HOME/state/capsules.");
  }

  // Publish a complete record without following or overwriting a pre-existing file.
  // Leave it for the supervisor/GC even if the child exits before its parent records the PID.
  const staging = join(parent, name, `.child_self.${randomUUID()}.tmp`);
  const fd = openSync(staging, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, `${JSON.stringify({ pid: process.pid })}\n`);
    } finally {
      closeSync(fd);
    }
    linkSync(staging, join(parent, name, "child_self.json"));
  } finally {
    unlinkSync(staging);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function frameError(message: string): string {
  return JSON.stringify({ type: "larva_rpc_frame_error", error: { code: "LARVA_CHILD_PROTOCOL_FAILED", message } });
}

const OVERSIZED = frameError("Child RPC frame exceeds 1048576 bytes.");
const MALFORMED = frameError("Child RPC frame is not a UTF-8 JSON object.");
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function prepareRecord(bytes: Buffer): string {
  let record: string;
  let frame: unknown;
  try {
    record = decoder.decode(bytes);
    frame = JSON.parse(record);
  } catch {
    return MALFORMED;
  }
  if (!isRecord(frame)) return MALFORMED;
  if (frame.type === "response" && frame.command === "get_state" && frame.success === true && isRecord(frame.data)) {
    return JSON.stringify({ ...frame, data: { ...frame.data, larvaChildRpcFrame: CAPABILITY } });
  }
  // Synthesize the wire terminal only from Pi's actual settlement boundary. An
  // agent_end is provisional: recovery, retries and continuation turns may follow.
  if (frame.type === "agent_settled") {
    if (typeof frame.aborted !== "boolean") return MALFORMED;
    return JSON.stringify({ type: "agent_settled", aborted: frame.aborted });
  }
  return record;
}

function install(): void {
  recordChildPid();
  const nativeWrite = process.stdout.write.bind(process.stdout);
  const pending = Buffer.allocUnsafe(MAX_RECORD_BYTES);
  let used = 0;
  let discarding = false;
  let transform: ((record: string) => readonly string[]) | undefined;

  function writeRecord(record: string): boolean {
    // The cooperative extension receives and returns serialized records, never
    // framed chunks. Deferred records must pass the same final byte fence.
    const bounded = Buffer.byteLength(record) > MAX_RECORD_BYTES ? OVERSIZED
      : record.includes("\n") ? MALFORMED : record;
    return nativeWrite(`${bounded}\n`, "utf8");
  }

  Object.defineProperty(globalThis, BRIDGE, { value: Object.freeze({
    version: 1,
    capability: CAPABILITY.capability,
    maxRecordBytes: MAX_RECORD_BYTES,
    configure(next: (record: string) => readonly string[]) { transform = next; },
    emit(records: readonly string[]) { for (const record of records) writeRecord(record); },
  }) });

  process.stdout.write = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean => {
    const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : "utf8";
    const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, encoding)
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let ready = true;
    for (let start = 0; start < bytes.length;) {
      const lf = bytes.indexOf(0x0a, start);
      const end = lf < 0 ? bytes.length : lf;
      const size = end - start;
      if (!discarding) {
        if (size > MAX_RECORD_BYTES - used) {
          ready = writeRecord(OVERSIZED) && ready;
          discarding = true;
          used = 0;
        } else if (lf < 0) {
          bytes.copy(pending, used, start, end);
          used += size;
        } else {
          if (used > 0) bytes.copy(pending, used, start, end);
          const record = prepareRecord(used === 0 ? bytes.subarray(start, end) : pending.subarray(0, used + size));
          used = 0;
          const records = transform && record !== MALFORMED ? transform(record) : [record];
          for (const output of records) ready = writeRecord(output) && ready;
        }
      }
      if (lf < 0) break;
      discarding = false;
      start = lf + 1;
    }
    // Queue the caller's callback behind the last actual write, even if the
    // transform parked the frame or this chunk only buffered a partial record.
    return done ? nativeWrite("", "utf8", done) && ready : ready;
  };
}

const argv = process.argv.slice(2);
const mode = argv.indexOf("--mode");
if (!Object.hasOwn(globalThis, BRIDGE) && process.env.LARVA_PI_LAUNCHED === "1"
  && mode !== -1 && argv[mode + 1] === "rpc" && argv.includes("--larva-persona")) {
  try {
    install();
  } catch {
    // Do not echo untrusted paths or let a child advertise capability without PID evidence.
    throw new Error("Larva child RPC preload could not record child_self.json in the owned capsule.");
  }
}
