import { createRequire as larvaCreateRequire } from "node:module";
const require = larvaCreateRequire(import.meta.url);

// src/child-rpc-preload.ts
import { randomUUID } from "node:crypto";
import { closeSync, linkSync, lstatSync, openSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

// src/core/predicates.ts
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// src/child-rpc-preload.ts
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
function frameError(message) {
  return JSON.stringify({ type: "larva_rpc_frame_error", error: { code: "LARVA_CHILD_PROTOCOL_FAILED", message } });
}
var OVERSIZED = frameError("Child RPC frame exceeds 1048576 bytes.");
var MALFORMED = frameError("Child RPC frame is not a UTF-8 JSON object.");
var decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function excerpt(value, limit = 1e3) {
  return typeof value === "string" ? value.slice(0, limit).toWellFormed() : void 0;
}
function textParts(value) {
  if (!Array.isArray(value)) return void 0;
  const parts = [];
  for (const part of value) {
    if (!isRecord(part) || part.type !== "text") continue;
    parts.push({ type: "text", text: excerpt(part.text) });
    if (parts.length === 4) break;
  }
  return parts;
}
function messageSummary(value) {
  if (!isRecord(value)) return void 0;
  return {
    role: excerpt(value.role),
    stopReason: excerpt(value.stopReason),
    errorMessage: excerpt(value.errorMessage),
    content: textParts(value.content)
  };
}
function project(frame) {
  const { type } = frame;
  switch (type) {
    case "agent_end": {
      const assistant = messageSummary(Array.isArray(frame.messages) ? frame.messages.findLast((m) => isRecord(m) && m.role === "assistant") : void 0);
      return {
        type,
        willRetry: typeof frame.willRetry === "boolean" ? frame.willRetry : void 0,
        aborted: typeof frame.aborted === "boolean" ? frame.aborted : void 0,
        messages: assistant ? [assistant] : []
      };
    }
    case "turn_end":
      return {
        type,
        turnIndex: typeof frame.turnIndex === "number" ? frame.turnIndex : void 0,
        outcome: excerpt(frame.outcome),
        message: messageSummary(frame.message),
        toolResults: Array.isArray(frame.toolResults) ? frame.toolResults.slice(0, 4).map(messageSummary) : void 0
      };
    case "message_end":
    case "message_start":
      return { type, message: messageSummary(frame.message) };
    case "extension_error":
      return { type, extensionPath: excerpt(frame.extensionPath), event: excerpt(frame.event), error: excerpt(frame.error) };
    case "message_update": {
      const e = frame.assistantMessageEvent;
      return { type, message: messageSummary(frame.message), assistantMessageEvent: isRecord(e) ? { type: excerpt(e.type), delta: excerpt(e.delta), contentIndex: typeof e.contentIndex === "number" ? e.contentIndex : void 0 } : void 0 };
    }
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end": {
      const key = type === "tool_execution_update" ? "partialResult" : "result";
      const result = frame[key];
      return {
        type,
        toolCallId: excerpt(frame.toolCallId),
        toolName: excerpt(frame.toolName),
        isError: typeof frame.isError === "boolean" ? frame.isError : void 0,
        durationMs: typeof frame.durationMs === "number" ? frame.durationMs : void 0,
        ...frame.args !== void 0 && { args: isRecord(frame.args) ? Object.fromEntries(Object.entries(frame.args).slice(0, 8).map(([key2, value]) => [key2.slice(0, 160), excerpt(value, 160)])) : excerpt(frame.args, 160) },
        [key]: isRecord(result) ? { content: textParts(result.content) } : void 0
      };
    }
  }
}
function install() {
  recordChildPid();
  const nativeWrite = process.stdout.write.bind(process.stdout);
  const pending = [];
  let transform;
  let promptAccepted = false;
  let currentAssistant = false;
  let orphan;
  const armOrphanGuard = () => {
    orphan ??= setTimeout(() => process.exit(1), 1500).unref();
  };
  process.stdin.once("end", armOrphanGuard);
  process.stdin.once("close", armOrphanGuard);
  function writeRecord(frame) {
    const record = JSON.stringify(frame);
    return nativeWrite(`${Buffer.byteLength(record) > MAX_RECORD_BYTES ? OVERSIZED : record}
`, "utf8");
  }
  function writeFrame(frame, oversized) {
    if (frame.type === "response" && frame.success === true) {
      if (frame.command === "get_state" && isRecord(frame.data)) {
        frame = { ...frame, data: { ...frame.data, larvaChildRpcFrame: CAPABILITY } };
      } else if (frame.command === "prompt" && (!isRecord(frame.data) || frame.data.disposition !== "handled")) {
        promptAccepted = true;
        currentAssistant = false;
      } else if (frame.command === "get_last_assistant_text" && isRecord(frame.data)) {
        if (!currentAssistant) frame = { ...frame, data: {} };
        else if (oversized && typeof frame.id === "string" && typeof frame.data.text === "string") {
          const { id } = frame;
          const { text } = frame.data;
          let ready2 = true;
          for (let start = 0; start < text.length; ) {
            let end = Math.min(start + 16e4, text.length);
            if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
            ready2 = writeRecord({ type: "larva_assistant_text_chunk", id, text: text.slice(start, end) }) && ready2;
            start = end;
          }
          return writeRecord({ ...frame, data: { chunked: true } }) && ready2;
        }
      }
    } else if (frame.type === "agent_settled") {
      if (typeof frame.aborted !== "boolean") return nativeWrite(`${MALFORMED}
`, "utf8");
      frame = { type: "agent_settled", aborted: frame.aborted };
    } else {
      if (promptAccepted && frame.type === "message_end" && isRecord(frame.message) && frame.message.role === "assistant") {
        const message = frame.message;
        currentAssistant ||= message.stopReason === "stop" || Array.isArray(message.content) && message.content.some((p) => isRecord(p) && p.type === "text" && typeof p.text === "string" && p.text.trim());
      }
      if (oversized) {
        const summary = project(frame);
        if (!summary) return nativeWrite(`${OVERSIZED}
`, "utf8");
        frame = summary;
      }
    }
    let ready = true;
    for (const output of transform?.(frame) ?? [frame]) ready = writeRecord(output) && ready;
    return ready;
  }
  Object.defineProperty(globalThis, BRIDGE, { value: Object.freeze({
    version: 1,
    capability: CAPABILITY.capability,
    maxRecordBytes: MAX_RECORD_BYTES,
    configure(next) {
      transform = next;
    },
    emit(frames) {
      for (const frame of frames) writeRecord(frame);
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
      const part = bytes.subarray(start, end);
      if (lf < 0) {
        pending.push(Buffer.from(part));
        break;
      }
      const record = pending.length === 0 ? part : Buffer.concat([...pending, part]);
      pending.length = 0;
      let frame;
      try {
        frame = JSON.parse(decoder.decode(record));
      } catch {
      }
      const oversized = record.length > MAX_RECORD_BYTES;
      ready = (isRecord(frame) ? writeFrame(frame, oversized) : nativeWrite(`${oversized ? OVERSIZED : MALFORMED}
`, "utf8")) && ready;
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
