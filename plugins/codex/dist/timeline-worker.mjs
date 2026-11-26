// src/timeline-worker.ts
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { parentPort } from "node:worker_threads";
var SLICE_BYTES = 512 * 1024;
var RECORD_BYTES = 2 * 1024 * 1024;
var MAX_CONTEXTS = 16;
var decoder = new TextDecoder("utf-8", { fatal: true });
var object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
var integer = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function excerptText(value, limit) {
  let text = "", points = 0, escape = "none";
  for (const char of value) {
    if (points >= limit) break;
    if (escape === "start") {
      escape = char === "[" ? "csi" : char === "]" ? "osc" : "none";
      continue;
    }
    if (escape === "csi") {
      if (char >= "@" && char <= "~") escape = "none";
      continue;
    }
    if (escape === "osc") {
      if (char === "\x07") escape = "none";
      else if (char === "\x1B") escape = "osc-end";
      continue;
    }
    if (escape === "osc-end") {
      escape = char === "\\" ? "none" : "osc";
      continue;
    }
    if (char === "\x1B") {
      escape = "start";
      continue;
    }
    const code = char.codePointAt(0);
    if (code < 32 && char !== "\n" && char !== "	" || code >= 127 && code <= 159) continue;
    text += char;
    points++;
  }
  return text;
}
function assistantMessageExcerpt(message) {
  if (!object(message) || message.role !== "assistant" || !Array.isArray(message.content)) return;
  const identity = typeof message.timestamp === "number" && Number.isFinite(message.timestamp) ? createHash("sha256").update(JSON.stringify([message.timestamp, ...[message.api, message.provider, message.model, message.responseId].map((value) => typeof value === "string" ? value : null)])) : void 0;
  let text = "", points = 0;
  const toolCallIds = [];
  for (const [index, part] of message.content.entries()) {
    if (!object(part)) continue;
    if (part.type === "text" && typeof part.text === "string") {
      identity?.update(`
text:${index}:${part.text.length}:`).update(part.text);
      if (points < 1200) {
        if (text) {
          text += "\n";
          points++;
        }
        const excerpt = excerptText(part.text, 1200 - points);
        text += excerpt;
        points += Array.from(excerpt).length;
      }
    } else if (part.type === "toolCall" && typeof part.id === "string") {
      identity?.update(`
tool:${index}:${part.id.length}:`).update(part.id);
      if (toolCallIds.length < 25) toolCallIds.push(excerptText(part.id, 160));
    }
  }
  return { text: text.trim(), toolCallIds, messageKey: identity?.digest("hex") };
}
var contexts = /* @__PURE__ */ new Map();
var newContext = (path) => ({
  path,
  hash: createHash("sha256"),
  offset: 0,
  pending: 0,
  headerChecked: false,
  sessionId: null,
  seen: /* @__PURE__ */ new Set()
});
var sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
var unchanged = (a, b) => sameFile(a, b) && a.size === b.size && a.ctimeNs === b.ctimeNs && a.mtimeNs === b.mtimeNs;
var sourceVersion = (state, info) => createHash("sha256").update(`${info.dev}:${info.ino}:${state.offset}:`).update(state.hash.copy().digest()).digest("hex");
function consume(state, chunk) {
  const excerpts = [];
  let malformed = 0, recordsParsed = 0, diagnostic;
  for (let from = 0; from < chunk.length; ) {
    const newline = chunk.indexOf(10, from);
    const next = newline === -1 ? chunk.length : newline + 1;
    const piece = chunk.subarray(from, newline === -1 ? next : newline);
    const length = state.pending + piece.length;
    if (length > RECORD_BYTES) state.pendingBuffer = void 0;
    else if (newline === -1 || state.pendingBuffer) {
      let buffer = state.pendingBuffer;
      if (!buffer || buffer.length < length) {
        const grown = Buffer.allocUnsafe(Math.min(RECORD_BYTES, Math.max(length, 1024, (buffer?.length ?? 0) * 2)));
        buffer?.copy(grown, 0, 0, state.pending);
        state.pendingBuffer = buffer = grown;
      }
      piece.copy(buffer, state.pending);
    }
    state.pending = length;
    from = next;
    if (newline === -1) break;
    const first = !state.headerChecked;
    state.headerChecked = true;
    try {
      if (state.pending > RECORD_BYTES) throw new Error("Oversized JSONL record.");
      const bytes = state.pendingBuffer?.subarray(0, length) ?? piece;
      const frame = JSON.parse(decoder.decode(bytes));
      recordsParsed++;
      if (first) {
        if (!object(frame) || frame.type !== "session" || frame.version !== 2 && frame.version !== 3 || typeof frame.id !== "string" || !frame.id) throw new Error("Invalid Pi session header.");
        state.sessionId = excerptText(frame.id, 160);
      } else if (state.sessionId !== null && object(frame) && frame.type === "message") {
        const excerpt = assistantMessageExcerpt(frame.message);
        if (!excerpt?.text) continue;
        const offset = state.offset + next;
        const id = typeof frame.id === "string" && frame.id && frame.id.length <= 160 ? frame.id : `offset:${offset}`;
        if (state.seen.has(id)) continue;
        state.seen.add(id);
        if (state.seen.size > 256) {
          const oldest = state.seen.values().next();
          if (!oldest.done) state.seen.delete(oldest.value);
        }
        excerpts.push({ id, offset, ...excerpt });
        if (excerpts.length > 80) excerpts.shift();
      }
    } catch {
      malformed++;
      if (first) diagnostic = "Invalid Pi session header; assistant excerpts unavailable.";
    } finally {
      state.pendingBuffer = void 0;
      state.pending = 0;
    }
  }
  return { excerpts, malformed, recordsParsed, diagnostic };
}
async function scan(request) {
  const { path, invocation } = request;
  const previous = contexts.get(invocation);
  let state = previous?.path === path ? previous : newContext(path);
  let reset = state !== previous;
  contexts.delete(invocation);
  if (contexts.size === MAX_CONTEXTS) {
    const oldest = contexts.keys().next();
    if (!oldest.done) contexts.delete(oldest.value);
  }
  contexts.set(invocation, state);
  const restart = () => {
    state = newContext(path);
    contexts.set(invocation, state);
    reset = true;
  };
  try {
    if (await realpath(path) !== path) throw new Error("Expected a canonical session path.");
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const info = await file.stat({ bigint: true });
      if (!info.isFile() || info.size > BigInt(Number.MAX_SAFE_INTEGER) || !sameFile(info, await stat(path, { bigint: true })) || await realpath(path) !== path) {
        throw new Error("Invalid session file.");
      }
      const size = Number(info.size);
      if (state.observed && (!sameFile(state.observed, info) || size < (state.end ?? state.offset))) restart();
      let bytesRead = 0;
      const read = async (offset, length) => {
        const buffer = Buffer.allocUnsafe(length);
        for (let used = 0; used < length; ) {
          const read2 = await file.read(buffer, used, length - used, offset + used);
          if (!read2.bytesRead) throw new Error("Session was truncated during a scan.");
          used += read2.bytesRead;
        }
        bytesRead += length;
        return buffer;
      };
      if (!state.recheck && state.offset > 0 && state.observed && !unchanged(state.observed, info)) {
        state.recheck = { offset: 0, hash: createHash("sha256"), observed: info };
      }
      if (state.recheck) {
        const check = state.recheck;
        const buffer = await read(check.offset, Math.min(SLICE_BYTES, state.offset - check.offset));
        check.hash.update(buffer);
        check.offset += buffer.length;
        if (check.offset === state.offset) {
          if (check.hash.digest("hex") !== state.hash.copy().digest("hex")) restart();
          else {
            state.recheck = void 0;
            state.observed = check.observed;
          }
        }
      }
      let page = { excerpts: [], malformed: 0, recordsParsed: 0, diagnostic: void 0 };
      if (!state.recheck) {
        state.end ??= size;
        const length = Math.min(SLICE_BYTES - bytesRead, state.end - state.offset);
        if (length) {
          const chunk = await read(state.offset, length);
          page = consume(state, chunk);
          state.offset += length;
          state.hash.update(chunk);
        }
        state.observed ??= info;
        const more = state.offset < state.end;
        if (!more) state.end = void 0;
      }
      const current = await stat(path, { bigint: true });
      if (!sameFile(info, current) || current.size < info.size || current.size === info.size && !unchanged(info, current) || await realpath(path) !== path) {
        throw new Error("Session changed during scan.");
      }
      return {
        ...request,
        ...page,
        reset,
        sessionId: state.sessionId,
        bytesRead,
        more: state.recheck !== void 0 || state.end !== void 0,
        sourceVersion: sourceVersion(state, info)
      };
    } finally {
      await file.close();
    }
  } catch {
    contexts.delete(invocation);
    return {
      ...request,
      reset: true,
      sessionId: null,
      excerpts: [],
      more: false,
      bytesRead: 0,
      diagnostic: "Unable to read the session timeline."
    };
  }
}
var port = parentPort;
if (port) {
  let pending = Promise.resolve();
  port.on("message", (message) => {
    if (!object(message) || !integer(message.invocation)) return;
    const { invocation } = message;
    if (message.kind === "drop") {
      pending = pending.then(() => {
        contexts.delete(invocation);
        port.postMessage({ kind: "dropped", invocation, contextCount: contexts.size });
      });
    } else if (message.kind === "scan" && typeof message.path === "string" && isAbsolute(message.path) && integer(message.generation) && Buffer.byteLength(message.path) <= 4096 && !message.path.includes("\0")) {
      const request = { path: message.path, invocation, generation: message.generation };
      pending = pending.then(async () => {
        port.postMessage({ ...await scan(request), contextCount: contexts.size });
      });
    }
  });
}
export {
  assistantMessageExcerpt
};
