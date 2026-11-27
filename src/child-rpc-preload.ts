import { randomUUID } from "node:crypto";
import { closeSync, linkSync, lstatSync, openSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isRecord } from "./core/predicates.ts";

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

function frameError(message: string): string {
  return JSON.stringify({ type: "larva_rpc_frame_error", error: { code: "LARVA_CHILD_PROTOCOL_FAILED", message } });
}

const OVERSIZED = frameError("Child RPC frame exceeds 1048576 bytes.");
const MALFORMED = frameError("Child RPC frame is not a UTF-8 JSON object.");
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

type Frame = Record<string, unknown>;

function excerpt(value: unknown, limit = 1000): string | undefined {
  return typeof value === "string" ? value.slice(0, limit).toWellFormed() : undefined;
}

function textParts(value: unknown): Frame[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts: Frame[] = [];
  for (const part of value) {
    if (!isRecord(part) || part.type !== "text") continue;
    parts.push({ type: "text", text: excerpt(part.text) });
    if (parts.length === 4) break;
  }
  return parts;
}

function messageSummary(value: unknown) {
  if (!isRecord(value)) return undefined;
  return { role: excerpt(value.role), stopReason: excerpt(value.stopReason),
    errorMessage: excerpt(value.errorMessage), content: textParts(value.content) };
}

function project(frame: Frame): Frame | undefined {
  const { type } = frame;
  switch (type) {
    case "agent_end": {
      const assistant = messageSummary(Array.isArray(frame.messages) ? frame.messages.findLast(m => isRecord(m) && m.role === "assistant") : undefined);
      return { type, willRetry: typeof frame.willRetry === "boolean" ? frame.willRetry : undefined,
        aborted: typeof frame.aborted === "boolean" ? frame.aborted : undefined, messages: assistant ? [assistant] : [] };
    }
    case "turn_end":
      return { type, turnIndex: typeof frame.turnIndex === "number" ? frame.turnIndex : undefined,
        outcome: excerpt(frame.outcome), message: messageSummary(frame.message),
        toolResults: Array.isArray(frame.toolResults) ? frame.toolResults.slice(0, 4).map(messageSummary) : undefined };
    case "message_end":
    case "message_start":
      return { type, message: messageSummary(frame.message) };
    case "extension_error":
      return { type, extensionPath: excerpt(frame.extensionPath), event: excerpt(frame.event), error: excerpt(frame.error) };
    case "message_update": {
      const e = frame.assistantMessageEvent;
      return { type, message: messageSummary(frame.message), assistantMessageEvent: isRecord(e)
        ? { type: excerpt(e.type), delta: excerpt(e.delta), contentIndex: typeof e.contentIndex === "number" ? e.contentIndex : undefined } : undefined };
    }
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end": {
      const key = type === "tool_execution_update" ? "partialResult" : "result";
      const result = frame[key];
      return { type, toolCallId: excerpt(frame.toolCallId), toolName: excerpt(frame.toolName),
        isError: typeof frame.isError === "boolean" ? frame.isError : undefined,
        durationMs: typeof frame.durationMs === "number" ? frame.durationMs : undefined,
        ...(frame.args !== undefined && { args: isRecord(frame.args) ? Object.fromEntries(Object.entries(frame.args).slice(0, 8)
          .map(([key, value]) => [key.slice(0, 160), excerpt(value, 160)])) : excerpt(frame.args, 160) }),
        [key]: isRecord(result) ? { content: textParts(result.content) } : undefined };
    }
  }
}

function install(): void {
  recordChildPid();
  const nativeWrite = process.stdout.write.bind(process.stdout);
  const pending: Buffer[] = [];
  let transform: ((frame: Frame) => readonly Frame[]) | undefined;
  let promptAccepted = false;
  let currentAssistant = false;
  let orphan: NodeJS.Timeout | undefined;
  const armOrphanGuard = () => { orphan ??= setTimeout(() => process.exit(1), 1500).unref(); };
  process.stdin.once("end", armOrphanGuard);
  process.stdin.once("close", armOrphanGuard);

  function writeRecord(frame: Frame): boolean {
    const record = JSON.stringify(frame);
    return nativeWrite(`${Buffer.byteLength(record) > MAX_RECORD_BYTES ? OVERSIZED : record}\n`, "utf8");
  }

  function writeFrame(frame: Frame, oversized: boolean): boolean {
    // Pi's native reply owns last-assistant selection. Admit it only if this
    // prompt produced an eligible reply, rather than leaking resumed history.
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
          let ready = true;
          for (let start = 0; start < text.length;) {
            // Worst-case JSON escaping is six bytes per UTF-16 unit.
            let end = Math.min(start + 160_000, text.length);
            if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
            ready = writeRecord({ type: "larva_assistant_text_chunk", id, text: text.slice(start, end) }) && ready;
            start = end;
          }
          return writeRecord({ ...frame, data: { chunked: true } }) && ready;
        }
      }
    } else if (frame.type === "agent_settled") {
      if (typeof frame.aborted !== "boolean") return nativeWrite(`${MALFORMED}\n`, "utf8");
      frame = { type: "agent_settled", aborted: frame.aborted };
    } else {
      if (promptAccepted && frame.type === "message_end" && isRecord(frame.message) && frame.message.role === "assistant") {
        const message = frame.message;
        currentAssistant ||= message.stopReason === "stop" || (Array.isArray(message.content)
          && message.content.some(p => isRecord(p) && p.type === "text" && typeof p.text === "string" && p.text.trim()));
      }
      if (oversized) {
        const summary = project(frame);
        if (!summary) return nativeWrite(`${OVERSIZED}\n`, "utf8");
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
    configure(next: (frame: Frame) => readonly Frame[]) { transform = next; },
    emit(frames: readonly Frame[]) { for (const frame of frames) writeRecord(frame); },
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
      const part = bytes.subarray(start, end);
      if (lf < 0) { pending.push(Buffer.from(part)); break; }
      const record = pending.length === 0 ? part : Buffer.concat([...pending, part]);
      pending.length = 0;
      let frame: unknown;
      try { frame = JSON.parse(decoder.decode(record)); } catch { /* emit a framed error below */ }
      const oversized = record.length > MAX_RECORD_BYTES;
      ready = (isRecord(frame) ? writeFrame(frame, oversized) : nativeWrite(`${oversized ? OVERSIZED : MALFORMED}\n`, "utf8")) && ready;
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
