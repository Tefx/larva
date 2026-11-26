// src/child-rpc-preload.ts
import { randomUUID } from "node:crypto";
import { closeSync, linkSync, lstatSync, openSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
var BRIDGE = /* @__PURE__ */ Symbol.for("larva.pi.child-rpc-frame-preload.v1");
var MAX_RECORD_BYTES = 1048576;
var CAPABILITY = {
  capability: "larva-child-rpc-frame-preload-v1",
  max_record_bytes: MAX_RECORD_BYTES,
  framing: "lf-only",
  terminal: "agent_settled"
};
function recordChildPid() {
  const home = process.env.LARVA_HOME || join(homedir(), ".larva");
  const root = process.env.LARVA_PI_CAPSULE_ROOT;
  if (root === void 0 || home !== resolve(home) || root !== resolve(root) || home.includes("\0") || root.includes("\0")) {
    throw new Error("Invalid Larva child capsule path.");
  }
  const canonicalHome = realpathSync(home);
  const parent = join(canonicalHome, "state", "capsules");
  const name = basename(root);
  const match = /^child-([1-9][0-9]*)-[a-f0-9]+$/.exec(name);
  if (dirname(root) !== parent && dirname(root) !== join(home, "state", "capsules") || !match || process.ppid !== 1 && match[1] !== String(process.ppid) || realpathSync(root) !== join(parent, name) || !lstatSync(root).isDirectory()) {
    throw new Error("Larva child capsule is not an owned directory under LARVA_HOME/state/capsules.");
  }
  const staging = join(parent, name, `.child_self.${randomUUID()}.tmp`);
  const fd = openSync(staging, "wx", 384);
  try {
    try {
      writeFileSync(fd, `${JSON.stringify({ pid: process.pid })}
`);
    } finally {
      closeSync(fd);
    }
    linkSync(staging, join(parent, name, "child_self.json"));
  } finally {
    unlinkSync(staging);
  }
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function frameError(message) {
  return JSON.stringify({ type: "larva_rpc_frame_error", error: { code: "LARVA_CHILD_PROTOCOL_FAILED", message } });
}
var OVERSIZED = frameError("Child RPC frame exceeds 1048576 bytes.");
var MALFORMED = frameError("Child RPC frame is not a UTF-8 JSON object.");
var decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function prepareRecord(bytes) {
  let record;
  let frame;
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
  if (frame.type === "agent_settled") {
    if (typeof frame.aborted !== "boolean") return MALFORMED;
    return JSON.stringify({ type: "agent_settled", aborted: frame.aborted });
  }
  return record;
}
function install() {
  recordChildPid();
  const nativeWrite = process.stdout.write.bind(process.stdout);
  const pending = Buffer.allocUnsafe(MAX_RECORD_BYTES);
  let used = 0;
  let discarding = false;
  let transform;
  function writeRecord(record) {
    const bounded = Buffer.byteLength(record) > MAX_RECORD_BYTES ? OVERSIZED : record.includes("\n") ? MALFORMED : record;
    return nativeWrite(`${bounded}
`, "utf8");
  }
  Object.defineProperty(globalThis, BRIDGE, { value: Object.freeze({
    version: 1,
    capability: CAPABILITY.capability,
    maxRecordBytes: MAX_RECORD_BYTES,
    configure(next) {
      transform = next;
    },
    emit(records) {
      for (const record of records) writeRecord(record);
    }
  }) });
  process.stdout.write = (chunk, encodingOrCallback, callback) => {
    const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : "utf8";
    const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, encoding) : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let ready = true;
    for (let start = 0; start < bytes.length; ) {
      const lf = bytes.indexOf(10, start);
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
    return done ? nativeWrite("", "utf8", done) && ready : ready;
  };
}
var argv = process.argv.slice(2);
var mode = argv.indexOf("--mode");
if (!Object.hasOwn(globalThis, BRIDGE) && process.env.LARVA_PI_LAUNCHED === "1" && mode !== -1 && argv[mode + 1] === "rpc" && argv.includes("--larva-persona")) {
  try {
    install();
  } catch {
    throw new Error("Larva child RPC preload could not record child_self.json in the owned capsule.");
  }
}
