import { lstatSync, readdirSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const BRIDGE_SYMBOL = Symbol.for("larva.pi.child-rpc-frame-preload.v1");
const CAPABILITY = "larva-child-rpc-frame-preload-v1";
const MAX_RECORD_BYTES = 1_048_576;
const ABORT_GRACE_MS = 1_500;

function removeChildCapsuleRoot(env) {
  const root = env.LARVA_PI_CAPSULE_ROOT;
  if (!root || dirname(root) !== join(env.HOME || homedir(), ".pi", "larva", "runtime") || !/^child-\d+-[a-f0-9]{16}$/.test(basename(root))) return;
  try {
    if (!lstatSync(root).isDirectory()) throw new Error("not an owned directory");
    try {
      const manifests = join(root, "descendants");
      if (!lstatSync(manifests).isDirectory() || readdirSync(manifests).length > 0) return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    rmSync(root, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== "ENOENT") {
      try { writeSync(2, `larva pi: capsule cleanup failed: ${JSON.stringify({ capsule_root: root, reason: error.code ?? "not an owned directory" }).slice(0, 1024)}\n`); }
      catch { /* Diagnostics must not prevent exit. */ }
    }
  }
}

if (globalThis[BRIDGE_SYMBOL] === undefined) {
  const nativeWrite = process.stdout.write.bind(process.stdout);
  let transformRecord = null;
  const encode = (records) => records.map((record) => {
    if (typeof record !== "string") throw new TypeError("Larva child RPC preload transform returned a non-string record.");
    const bytes = Buffer.byteLength(record, "utf8");
    if (bytes > MAX_RECORD_BYTES) throw new RangeError(`Larva child RPC preload emitted ${bytes} bytes (limit ${MAX_RECORD_BYTES}).`);
    return `${record}\n`;
  }).join("");
  const emit = (records) => { nativeWrite(encode(records), "utf8"); };

  // NODE_OPTIONS and the capsule environment also reach resolver/tool subprocesses,
  // including route verification run by the same parent as the child Pi process.
  const capsule = process.env.LARVA_PI_CAPSULE_ROOT;
  const mode = process.argv.indexOf("--mode", 2);
  const isOwnedRpcChild = capsule && (process.ppid === 1 || basename(capsule).startsWith(`child-${process.ppid}-`))
    && mode >= 2 && process.argv[mode + 1] === "rpc" && process.argv.includes("--larva-persona", 2);
  if (process.env.LARVA_PI_LAUNCHED === "1" && isOwnedRpcChild) {
    process.stdin.once("close", () => {
      setTimeout(() => {
        if (process.ppid === 1) removeChildCapsuleRoot(process.env);
        process.exit(143);
      }, ABORT_GRACE_MS).unref();
    });
    // A living parent owns capsule removal on normal exit.
    process.once("exit", () => {
      if (process.ppid === 1) removeChildCapsuleRoot(process.env);
    });
  }

  const bridge = {
    version: 1,
    capability: CAPABILITY,
    maxRecordBytes: MAX_RECORD_BYTES,
    configure(transform) {
      if (typeof transform !== "function") throw new TypeError("Larva child RPC preload transform must be a function.");
      transformRecord = transform;
    },
    isConfigured() {
      return transformRecord !== null;
    },
    emit,
  };
  Object.defineProperty(globalThis, BRIDGE_SYMBOL, { value: bridge, configurable: false, enumerable: false, writable: false });

  process.stdout.write = ((chunk, encodingOrCallback, callback) => {
    const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : "utf8";
    const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    const writeNative = (value) => typeof done === "function"
      ? nativeWrite(value, "utf8", done)
      : nativeWrite(value, "utf8");
    if (process.env.LARVA_PI_CHILD_RPC_FRAME_BOUND !== "1" || transformRecord === null) {
      return typeof done === "function"
        ? (typeof encodingOrCallback === "string" ? nativeWrite(chunk, encodingOrCallback, done) : nativeWrite(chunk, done))
        : (typeof encodingOrCallback === "string" ? nativeWrite(chunk, encodingOrCallback) : nativeWrite(chunk));
    }
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(encoding);
    if (!text.endsWith("\n")) return writeNative(text);
    return writeNative(encode(text.slice(0, -1).split("\n").flatMap(transformRecord)));
  });
}
