const BRIDGE_SYMBOL = Symbol.for("larva.pi.child-rpc-frame-preload.v1");
const CAPABILITY = "larva-child-rpc-frame-preload-v1";
const MAX_RECORD_BYTES = 1_048_576;

if (globalThis[BRIDGE_SYMBOL] === undefined) {
  const nativeWrite = process.stdout.write.bind(process.stdout);
  let transformRecord = null;

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
    const records = text.slice(0, -1).split("\n");
    const transformed = records.map((record) => {
      const outbound = transformRecord(record);
      if (typeof outbound !== "string") throw new TypeError("Larva child RPC preload transform returned a non-string record.");
      const bytes = Buffer.byteLength(outbound, "utf8");
      if (bytes > MAX_RECORD_BYTES) throw new RangeError(`Larva child RPC preload emitted ${bytes} bytes (limit ${MAX_RECORD_BYTES}).`);
      return outbound;
    }).join("\n") + "\n";
    return writeNative(transformed);
  });
}
