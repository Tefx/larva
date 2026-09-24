// Private presentation reader. Runs off the parent Pi event loop; never returns raw session records.
import { parentPort } from "node:worker_threads";
import { open, stat } from "node:fs/promises";
import { TextDecoder } from "node:util";

const SLICE = 512 * 1024;
const contexts = new Map();
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
// Stop at the output limit without allocating a code-point array or sanitizing
// an entire potentially huge persisted assistant text on the Worker heap.
function bounded(value, limit) {
  let result = "", count = 0, escape = 0;
  for (const char of value) {
    if (count >= limit) break;
    if (escape === 1) { escape = char === "[" ? 2 : char === "]" ? 3 : 0; continue; }
    if (escape === 2) { if (char >= "@" && char <= "~") escape = 0; continue; }
    if (escape === 3) { if (char === "\x07") escape = 0; else if (char === "\x1b") escape = 4; continue; }
    if (escape === 4) { escape = char === "\\" ? 0 : 3; continue; }
    if (char === "\x1b") { escape = 1; continue; }
    const code = char.codePointAt(0);
    if (code < 32 && char !== "\n" && char !== "\t" || code === 127) continue;
    result += char;
    count += 1;
  }
  return result;
}

async function scan({ path, invocation, generation, testFailAfterReset = false }) {
  let cursor = contexts.get(invocation);
  if (cursor?.path !== path) {
    cursor = { path, offset: 0, pendingParts: [], pendingLength: 0, seen: new Set(), identity: null, sessionId: null, headerChecked: false, end: null };
    contexts.set(invocation, cursor);
  }
  let reset = false;
  let handle;
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("session is not a file");
    handle = await open(path, "r");
    const opened = await handle.stat();
    if (opened.dev !== info.dev || opened.ino !== info.ino) throw new Error("session changed during open");
    const identity = `${opened.dev}:${opened.ino}`;
    if (cursor.identity !== null && (cursor.identity !== identity || opened.size < cursor.offset || (cursor.end !== null && opened.size < cursor.end))) {
      cursor.offset = 0;
      cursor.pendingParts = [];
      cursor.pendingLength = 0;
      cursor.seen.clear();
      cursor.headerChecked = false;
      cursor.sessionId = null;
      cursor.end = null;
      reset = true;
    }
    cursor.identity = identity;
    // Private deterministic fault seam for the replacement/error regression.
    if (reset && testFailAfterReset === true) throw new Error("injected read failure after file replacement");
    // One finite file snapshot per catch-up, shared over fair, bounded slices.
    if (cursor.end === null) cursor.end = opened.size;
    const start = cursor.offset;
    const length = Math.min(SLICE, Math.max(0, cursor.end - start));
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = length ? await handle.read(buffer, 0, length, start) : { bytesRead: 0 };
    const excerpts = [];
    let malformed = 0;
    let recordsParsed = 0;
    let diagnostic;
    let begin = 0;
    for (let i = 0; i < bytesRead; i += 1) {
      if (buffer[i] !== 10) continue;
      const part = buffer.subarray(begin, i);
      const position = start + i + 1;
      begin = i + 1;
      const line = cursor.pendingLength ? Buffer.concat([...cursor.pendingParts, part], cursor.pendingLength + part.length) : part;
      cursor.pendingParts = [];
      cursor.pendingLength = 0;
      try {
        recordsParsed += 1;
        const frame = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
        if (!cursor.headerChecked) {
          cursor.headerChecked = true;
          if (frame?.type === "session" && typeof frame.id === "string" && frame.id.length > 0 && [2, 3].includes(frame.version)) cursor.sessionId = frame.id;
          else diagnostic = "Invalid Pi session header; assistant excerpts unavailable.";
          continue;
        }
        if (cursor.sessionId === null || frame?.type !== "message" || !isObject(frame.message) || frame.message.role !== "assistant" || !Array.isArray(frame.message.content)) continue;
        const id = typeof frame.id === "string" && frame.id.length > 0 && frame.id.length <= 160 ? frame.id : `offset:${position}`;
        if (cursor.seen.has(id)) continue;
        let text = "", points = 0;
        const toolCallIds = [];
        for (const part of frame.message.content) {
          if (!isObject(part)) continue;
          if (part.type === "text" && typeof part.text === "string" && points < 1200) {
            if (text) { text += "\n"; points += 1; }
            const excerpt = bounded(part.text, 1200 - points);
            text += excerpt;
            points += Array.from(excerpt).length;
          } else if (part.type === "toolCall" && typeof part.id === "string" && toolCallIds.length < 25) toolCallIds.push(bounded(part.id, 160));
        }
        text = text.trim();
        if (!text) continue;
        cursor.seen.add(id);
        if (cursor.seen.size > 256) cursor.seen.delete(cursor.seen.values().next().value);
        excerpts.push({ id, offset: position, text, toolCallIds });
        if (excerpts.length > 80) excerpts.shift();
      } catch { malformed += 1; if (!cursor.headerChecked) { cursor.headerChecked = true; diagnostic = "Malformed Pi session header; assistant excerpts unavailable."; } }
    }
    const remainder = buffer.subarray(begin, bytesRead);
    if (remainder.length) {
      cursor.pendingParts.push(Buffer.from(remainder));
      cursor.pendingLength += remainder.length;
    }
    cursor.offset = start + bytesRead;
    const more = cursor.offset < cursor.end && bytesRead > 0;
    if (!more) cursor.end = null;
    parentPort.postMessage({ invocation, generation, path, reset, sessionId: cursor.sessionId === null ? null : bounded(cursor.sessionId, 160), excerpts, malformed, recordsParsed, more, bytesRead, diagnostic, contextCount: contexts.size });
  } catch (error) {
    cursor.end = null;
    parentPort.postMessage({ invocation, generation, path, reset, sessionId: cursor.sessionId === null ? null : bounded(cursor.sessionId, 160), excerpts: [], more: false, bytesRead: 0, diagnostic: bounded(String(error?.message ?? error), 160), contextCount: contexts.size });
  } finally { await handle?.close().catch(() => {}); }
}

// Serialize requests so two sessions cannot monopolize the reader or race one cursor.
let tail = Promise.resolve();
parentPort.on("message", (message) => {
  if (message?.kind === "drop") { tail = tail.then(() => { contexts.delete(message.invocation); parentPort.postMessage({ kind: "dropped", contextCount: contexts.size }); }); return; }
  if (message?.kind !== "scan" || typeof message.path !== "string" || typeof message.invocation !== "number") return;
  tail = tail.then(() => scan(message)).catch(() => {});
});
