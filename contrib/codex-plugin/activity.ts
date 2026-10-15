// File-only activity evidence. No session manager, registry, lifecycle or callback imports.
import { open, stat } from "node:fs/promises";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { createHash } from "node:crypto";

const CEILING = 8192;
const BATCH = 32;
const ACTION_MAX = 200;
const RESULT_MAX = 500;
const decoder = new TextDecoder("utf-8", { fatal: true });
type Obj = Record<string, any>;
const object = (x: unknown): x is Obj => x !== null && typeof x === "object" && !Array.isArray(x);
const fail = (code: string, message: string): never => { throw { activityError: true, code, message }; };
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const encode = (x: Obj) => Buffer.from(JSON.stringify(x)).toString("base64url");
const integer = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
const timestamp = (s: unknown) => typeof s === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(s) && Number.isFinite(Date.parse(s));

type Position = [number, number, number, number];
const compare = (a: Position, b: Position) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3];
type Location = { entry_id?: string; parent_id?: string | null; byte_offset: number; line_byte_length: number; line_number: number; content_index?: number };
type RecordRow = { raw: Obj; location: Location };
type Call = { id: string; name: string; timestamp?: string; message_timestamp?: number; location: Location; action_preview: string; action_truncated: boolean };
type ResultRow = { id: string; name: string; timestamp?: string; message_timestamp?: number; location: Location; is_error?: boolean; content_preview: string; content_total_chars: number; has_image?: boolean; has_details?: boolean; non_text?: boolean; upstream_truncated?: boolean };
type Input = { path: string; limit: number; tool?: string; since?: number; until?: number; filter: string; cursor?: Obj; call?: string; index?: number; entry?: string; resultIndex?: number; part: "args" | "result"; offset: number; length: number; version?: Obj };

function token(raw: unknown): Obj {
  if (typeof raw !== "string" || raw.length > CEILING || !/^[A-Za-z0-9_-]+$/.test(raw)) fail("LARVA_CURSOR_INVALID", "Invalid continuation token.");
  try {
    const value = JSON.parse(Buffer.from(raw as string, "base64url").toString("utf8"));
    if (!object(value) || value.v !== 2 || !integer(value.dev) || !integer(value.ino) || !integer(value.end) || typeof value.path !== "string" || typeof value.sid !== "string" || !/^[a-f0-9]{64}$/.test(value.hash)) fail("LARVA_CURSOR_INVALID", "Invalid continuation fields.");
    return value;
  } catch { return fail("LARVA_CURSOR_INVALID", "Invalid continuation token."); }
}
function parse(input: unknown): Input {
  if (!object(input)) fail("LARVA_BAD_INPUT", "Activity input must be an object.");
  const x = input as Obj;
  const keys = ["session_path", "task_id", "limit", "cursor", "tool_name", "since_timestamp", "until_timestamp", "tool_call_id", "disambiguation_index", "entry_id", "result_index", "segment_part", "offset", "length", "source_version"];
  if (Object.keys(x).some(k => !keys.includes(k))) fail("LARVA_BAD_INPUT", "Unknown activity parameter.");
  for (const k of ["session_path", "task_id", "cursor", "tool_name", "since_timestamp", "until_timestamp", "tool_call_id", "entry_id", "source_version"]) {
    if (x[k] !== undefined && (typeof x[k] !== "string" || !x[k].length || x[k].trim() !== x[k])) fail("LARVA_BAD_INPUT", `${k} must be a nonempty exact string.`);
  }
  if (x.session_path && x.task_id && x.session_path !== x.task_id) fail("LARVA_BAD_INPUT", "session_path and task_id differ.");
  const path = x.session_path ?? x.task_id;
  if (typeof path !== "string" || !isAbsolute(path) || normalize(path) !== path || !path.endsWith(".jsonl") || path.includes("\0")) fail("LARVA_BAD_INPUT", "Supply one exact normalized absolute .jsonl path.");
  const limit = x.limit ?? 5, offset = x.offset ?? 0, length = x.length ?? 2000;
  if (!integer(limit) || limit < 1 || limit > 20 || !integer(offset) || !integer(length) || length < 1 || length > 4000) fail("LARVA_BAD_INPUT", "limit: 1..20; offset: nonnegative integer; length: 1..4000.");
  for (const k of ["disambiguation_index", "result_index"]) if (x[k] !== undefined && !integer(x[k])) fail("LARVA_BAD_INPUT", `${k} must be a nonnegative integer.`);
  if (x.disambiguation_index !== undefined && x.entry_id !== undefined) fail("LARVA_BAD_INPUT", "Use one call selector.");
  const part = x.segment_part ?? "result";
  if (part !== "args" && part !== "result") fail("LARVA_BAD_INPUT", "segment_part must be args or result.");
  for (const k of ["since_timestamp", "until_timestamp"]) if (x[k] !== undefined && !timestamp(x[k])) fail("LARVA_BAD_INPUT", `${k} requires a timezone-qualified ISO timestamp.`);
  const since = x.since_timestamp === undefined ? undefined : Date.parse(x.since_timestamp);
  const until = x.until_timestamp === undefined ? undefined : Date.parse(x.until_timestamp);
  if (since !== undefined && until !== undefined && since > until) fail("LARVA_BAD_INPUT", "Timestamp range is reversed.");
  const filter = digest(JSON.stringify([x.tool_name ?? null, since ?? null, until ?? null]));
  const cursor = x.cursor === undefined ? undefined : token(x.cursor);
  const version = x.source_version === undefined ? undefined : token(x.source_version);
  const pathHash = digest(path);
  for (const t of [cursor, version]) if (t && t.path !== pathHash) fail("LARVA_CURSOR_INVALID", "Continuation belongs to another path.");
  if (cursor && (cursor.kind !== "activity" || cursor.filter !== filter || !integer(cursor.base) || cursor.base > cursor.end || (cursor.after !== undefined && (!Array.isArray(cursor.after) || cursor.after.length !== 4 || !cursor.after.every(integer))) || typeof cursor.paging !== "boolean" || !["recent", "updates"].includes(cursor.mode))) fail("LARVA_CURSOR_INVALID", "Cursor query or position is invalid.");
  if (version && version.kind !== "source") fail("LARVA_CURSOR_INVALID", "Expected source_version token.");
  if (x.tool_call_id === undefined && [x.disambiguation_index, x.entry_id, x.result_index, x.source_version, x.segment_part, x.offset, x.length].some(v => v !== undefined)) fail("LARVA_BAD_INPUT", "Detail parameters require tool_call_id.");
  if (x.tool_call_id !== undefined && (cursor || x.tool_name !== undefined || since !== undefined || until !== undefined)) fail("LARVA_BAD_INPUT", "Exact lookup does not accept recent-mode filters or cursor.");
  if (offset > 0 && !version) fail("LARVA_BAD_INPUT", "Continued segments require source_version.");
  return { path, limit, tool: x.tool_name, since, until, filter, cursor, call: x.tool_call_id, index: x.disambiguation_index, entry: x.entry_id, resultIndex: x.result_index, part, offset, length, version };
}

// A single descriptor owns a finite snapshot for the entire request. A pass holds
// one JSONL record, never a session array. Async reads yield to cancellation even
// on cached files. A large record costs O(record bytes), including JSON.parse;
// cancellation cannot interrupt JSON.parse itself. Chunk accumulation is linear.
class ActivityReader {
  end = 0; hash = ""; sid = ""; totalCalls = 0; diagnosticCount = 0;
  diagnostics: Obj[] = [];
  readonly file: FileHandle;
  readonly size: number;
  readonly signal?: AbortSignal;
  constructor(file: FileHandle, size: number, signal?: AbortSignal) { this.file = file; this.size = size; this.signal = signal; }
  check() { if (this.signal?.aborted) fail("LARVA_CHILD_CANCELLED", "Activity inspection was cancelled."); }
  diagnostic(kind: string, location: Partial<Location>, message: string) {
    this.diagnosticCount++;
    if (this.diagnostics.length < 5) this.diagnostics.push({ kind, ...location, message });
  }
  async *records(first = false): AsyncGenerator<RecordRow> {
    const boundary = first ? this.size : this.end;
    const hasher = createHash("sha256");
    let pos = 0, start = 0, line = 0, parts: Buffer[] = [], partBytes = 0;
    while (pos < boundary) {
      this.check();
      const buffer = Buffer.allocUnsafe(Math.min(65536, boundary - pos));
      const { bytesRead } = await this.file.read(buffer, 0, buffer.length, pos);
      this.check();
      if (!bytesRead) fail("LARVA_CURSOR_STALE", "Session was truncated while reading the captured snapshot.");
      pos += bytesRead;
      let from = 0;
      while (from < bytesRead) {
        const newline = buffer.indexOf(10, from);
        if (newline < 0 || newline >= bytesRead) { const tail = buffer.subarray(from, bytesRead); parts.push(tail); partBytes += tail.length; break; }
        const piece = buffer.subarray(from, newline + 1);
        parts.push(piece); partBytes += piece.length;
        const bytes = parts.length === 1 ? parts[0] : Buffer.concat(parts, partBytes);
        parts = []; partBytes = 0;
        hasher.update(bytes);
        const location: Location = { byte_offset: start, line_byte_length: bytes.length, line_number: ++line };
        start += bytes.length; from = newline + 1;
        let text: string, raw: unknown;
        try { text = decoder.decode(bytes); }
        catch { if (line === 1) fail("LARVA_SESSION_INVALID", "Invalid UTF-8 session header."); if (first) this.diagnostic("invalid_utf8", location, "Invalid UTF-8 record."); continue; }
        try { raw = JSON.parse(text!); }
        catch { if (line === 1) fail("LARVA_SESSION_INVALID", "Malformed session header."); if (first) this.diagnostic("malformed_json", location, "Malformed JSON record."); continue; }
        if (line === 1) {
          if (!object(raw) || raw.type !== "session" || typeof raw.id !== "string" || !raw.id.length || ![2, 3].includes(raw.version)) fail("LARVA_SESSION_INVALID", "Expected Pi session header with id and supported version 2 or 3; no migration is performed.");
          if (first) this.sid = raw.id;
          else if (this.sid !== raw.id) fail("LARVA_CURSOR_STALE", "Session identity changed during inspection.");
          continue;
        }
        if (!object(raw)) { if (first) this.diagnostic("malformed_record", location, "Record must be an object."); continue; }
        const r = raw as Obj;
        if (typeof r.id === "string") location.entry_id = r.id;
        if (r.parentId === null || typeof r.parentId === "string") location.parent_id = r.parentId;
        if (first && r.type === "message") {
          if (!object(r.message)) this.diagnostic("malformed_record", location, "Missing message payload.");
          else if (["assistant", "toolResult"].includes(r.message.role)) {
            if (!location.entry_id || !timestamp(r.timestamp) || (r.parentId !== undefined && r.parentId !== null && typeof r.parentId !== "string")) this.diagnostic("malformed_record", location, "Missing or invalid recorded provenance; fields are preserved as absent, never synthesized.");
            if (r.message.role === "assistant") {
              if (!Array.isArray(r.message.content)) this.diagnostic("malformed_record", location, "Assistant content must be an array.");
              else for (const [index, block] of r.message.content.entries()) {
                if (object(block) && block.type === "toolCall") {
                  if (!validCall(block)) this.diagnostic("malformed_record", { ...location, content_index: index }, "Tool call requires nonempty id/name and recorded arguments.");
                  else this.totalCalls++;
                }
              }
            } else if (!validResult(r.message)) this.diagnostic("malformed_record", location, "Tool result requires id/name/content and a boolean error marker when recorded.");
          }
        }
        yield { raw: r, location };
        this.check();
      }
    }
    if (first) {
      this.end = start; this.hash = hasher.digest("hex");
      if (partBytes) this.diagnostic("unterminated_tail", { byte_offset: start, line_byte_length: partBytes, line_number: line + 1 }, "Pending tail is uncommitted until its newline is recorded.");
      if (!this.sid) fail("LARVA_SESSION_INVALID", "No complete session header.");
    } else if (hasher.digest("hex") !== this.hash) fail("LARVA_CURSOR_STALE", "Session contents changed during inspection.");
  }
  async verify(t: Obj) {
    if (t.end > this.end || t.sid !== this.sid) fail("LARVA_CURSOR_STALE", "Session was replaced or truncated.");
    const h = createHash("sha256");
    for (let pos = 0; pos < t.end;) {
      this.check();
      const b = Buffer.allocUnsafe(Math.min(65536, t.end - pos));
      const { bytesRead } = await this.file.read(b, 0, b.length, pos);
      if (!bytesRead) fail("LARVA_CURSOR_STALE", "Session was truncated during validation.");
      h.update(b.subarray(0, bytesRead)); pos += bytesRead;
    }
    if (h.digest("hex") !== t.hash) fail("LARVA_CURSOR_STALE", "Consumed prefix changed, including truncation followed by regrowth.");
  }
}
function validCall(b: Obj) { return typeof b.id === "string" && b.id.length > 0 && typeof b.name === "string" && b.name.length > 0 && Object.hasOwn(b, "arguments"); }
function validResult(m: Obj) { return typeof m.toolCallId === "string" && m.toolCallId.length > 0 && typeof m.toolName === "string" && m.toolName.length > 0 && Object.hasOwn(m, "content") && (typeof m.content === "string" || Array.isArray(m.content)) && (m.isError === undefined || typeof m.isError === "boolean"); }

function hasSubstantialDetails(details: unknown): boolean {
  if (details === null || details === undefined) return false;
  if (typeof details === "string") return details.length > 0;
  if (typeof details === "number" || typeof details === "boolean") return true;
  if (Array.isArray(details)) return details.length > 0;
  if (object(details)) {
    for (const [k, v] of Object.entries(details)) {
      if (k === "truncated" || k === "fullOutputPath") continue;
      if (k === "truncation") {
        if (object(v)) {
          if (Object.keys(v).some(tk => tk !== "truncated")) return true;
          continue;
        }
        if (v !== null && v !== undefined) return true;
        continue;
      }
      if (v !== null && v !== undefined) return true;
    }
    return false;
  }
  return false;
}

function extractResultContent(m: Obj): { text: string; total_chars: number; has_image?: boolean; has_details?: boolean; non_text?: boolean } {
  let text = "", has_image = false, has_details = false, non_text = false;
  if (typeof m.content === "string") {
    text = m.content;
  } else if (Array.isArray(m.content)) {
    const pieces: string[] = [];
    for (const b of m.content) {
      if (typeof b === "string") pieces.push(b);
      else if (object(b)) {
        if (b.type === "text" && typeof b.text === "string") pieces.push(b.text);
        else if (b.type === "image") has_image = true;
        else non_text = true;
      } else if (b !== null && b !== undefined) non_text = true;
    }
    text = pieces.join("\n");
  } else if (m.content !== null && m.content !== undefined) non_text = true;

  if (hasSubstantialDetails(m.details)) has_details = true;
  return { text: text.slice(0, RESULT_MAX), total_chars: text.length, ...(has_image ? { has_image: true } : {}), ...(has_details ? { has_details: true } : {}), ...(non_text ? { non_text: true } : {}) };
}

function *calls(row: RecordRow): Generator<Call> {
  const m = row.raw.message;
  if (row.raw.type !== "message" || !object(m) || m.role !== "assistant" || !Array.isArray(m.content)) return;
  for (const [i, b] of m.content.entries()) if (object(b) && b.type === "toolCall" && validCall(b)) {
    const fullAction = `${b.name} ${JSON.stringify(b.arguments)}`;
    const truncated = fullAction.length > ACTION_MAX;
    yield {
      id: b.id,
      name: b.name,
      timestamp: typeof row.raw.timestamp === "string" ? row.raw.timestamp : undefined,
      message_timestamp: typeof m.timestamp === "number" ? m.timestamp : undefined,
      location: { ...row.location, content_index: i },
      action_preview: truncated ? fullAction.slice(0, ACTION_MAX) : fullAction,
      action_truncated: truncated,
    };
  }
}
function resultRow(row: RecordRow): ResultRow | undefined {
  const m = row.raw.message;
  if (row.raw.type !== "message" || !object(m) || m.role !== "toolResult" || !validResult(m)) return;
  const top = object(m.details) ? m.details.truncated : undefined;
  const nested = object(m.details?.truncation) ? m.details.truncation.truncated : undefined;
  const upstream = top === true || nested === true ? true : top === false || nested === false ? false : undefined;
  const extracted = extractResultContent(m);
  return {
    id: m.toolCallId,
    name: m.toolName,
    timestamp: typeof row.raw.timestamp === "string" ? row.raw.timestamp : undefined,
    message_timestamp: typeof m.timestamp === "number" ? m.timestamp : undefined,
    location: row.location,
    is_error: m.isError,
    content_preview: extracted.text,
    content_total_chars: extracted.total_chars,
    has_image: extracted.has_image,
    has_details: extracted.has_details,
    non_text: extracted.non_text,
    upstream_truncated: upstream,
  };
}
const callPosition = (c: Call): Position => [c.location.byte_offset, c.location.content_index!, 0, 0];
const resultPosition = (c: Call, r: ResultRow): Position => [r.location.byte_offset, 0, c.location.byte_offset, c.location.content_index!];
function timeMatch(c: Call, r: ResultRow | undefined, q: Input): string | undefined {
  if (q.tool !== undefined && c.name !== q.tool) return undefined;
  if (q.since === undefined && q.until === undefined) return "unfiltered";
  const inside = (s?: string) => timestamp(s) && (q.since === undefined || Date.parse(s!) >= q.since) && (q.until === undefined || Date.parse(s!) <= q.until);
  if (inside(c.timestamp)) return "call_timestamp";
  if (inside(r?.timestamp)) return "result_timestamp";
  return undefined;
}
function item(c: Call, r: ResultRow | undefined, reader: ActivityReader, count = r ? 1 : 0, dupeInfo?: { total: number; index: number }): Obj {
  const it: Obj = {
    call_id: c.id,
    ...(dupeInfo && dupeInfo.total > 1 ? { disambiguation_index: dupeInfo.index } : {}),
    action: c.action_preview,
    ...(c.action_truncated ? { action_truncated: true } : {}),
  };

  if (count > 1) {
    it.result_state = "ambiguous";
    it.result_candidates_count = count;
    it.result_selection = "Use exact call lookup with result_index.";
    return it;
  }

  if (!r) {
    it.result_state = reader.diagnosticCount ? "incomplete" : "not_observed";
    return it;
  }

  const hasExtras = Boolean(r.has_image || r.has_details || r.non_text);
  const textTruncated = r.content_total_chars > RESULT_MAX;
  const resultTruncated = textTruncated || hasExtras;

  it.result = r.content_preview;
  if (resultTruncated) it.result_truncated = true;
  if (r.has_image) it.has_image = true;
  if (r.has_details) it.has_details = true;
  if (r.non_text) it.non_text = true;
  if (r.is_error !== undefined) it.is_error = r.is_error;
  if (r.upstream_truncated === true) it.upstream_truncated = true;

  return it;
}

// Duplicate call IDs require ancestry, never first/last-write selection. Resolve
// backwards one entry at a time (constant storage). Strictly decreasing offsets
// bound malformed cycles and keep historical branches distinct.
async function ancestor(reader: ActivityReader, r: ResultRow): Promise<Position | undefined> {
  let parent = r.location.parent_id, before = r.location.byte_offset;
  while (typeof parent === "string") {
    let found: RecordRow | undefined, count = 0;
    for await (const row of reader.records()) if (row.location.byte_offset < before && row.location.entry_id === parent) { found = row; count++; }
    if (count !== 1 || !found) return undefined;
    let selected: Call | undefined, matches = 0;
    for (const c of calls(found)) if (c.id === r.id && c.name === r.name) { selected = c; matches++; }
    if (matches) return matches === 1 ? callPosition(selected!) : undefined;
    parent = found.location.parent_id; before = found.location.byte_offset;
  }
  return undefined;
}

type Selected = { position: Position; value: Obj };
function keep(selected: Selected[], entry: Selected, limit: number, tail: boolean) {
  selected.push(entry); selected.sort((a, b) => compare(a.position, b.position));
  if (selected.length > limit) tail ? selected.shift() : selected.pop();
}
function response(payload: Obj) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], details: { status: payload.status }, isError: payload.status === "failed" };
}
function fits(payload: Obj) { return Buffer.byteLength(JSON.stringify(response(payload)), "utf8") <= CEILING; }
function bounded(payload: Obj) {
  if (fits(payload)) return response(payload);
  // Never slice serialized JSON, identifiers, cursors or segment metadata. An
  // oversized metadata record is an explicit error, with no advanced cursor.
  return response({ status: "failed", error: { code: "LARVA_ACTIVITY_METADATA_TOO_LARGE", message: "Required provenance exceeds the 8192-byte response ceiling. No continuation position was advanced.", byte_offset: payload.call?.call_location?.byte_offset ?? payload.candidates?.[0]?.byte_offset ?? undefined } });
}

export async function inspectSessionActivity(input: unknown, signal?: AbortSignal) {
  let file: FileHandle | undefined;
  try {
    const q = parse(input);
    if (signal?.aborted) fail("LARVA_CHILD_CANCELLED", "Activity inspection was cancelled.");
    // Nonblocking open lets the regular-file check reject an accidental FIFO
    // rather than waiting indefinitely before cancellation can be observed.
    file = await open(q.path, constants.O_RDONLY | constants.O_NONBLOCK);
    const initial = await file.stat();
    if (!initial.isFile()) fail("LARVA_SESSION_INVALID", "Target is not a regular session file.");
    for (const t of [q.cursor, q.version]) if (t && (initial.dev !== t.dev || initial.ino !== t.ino || initial.size < t.end)) fail("LARVA_CURSOR_STALE", "Session was replaced or truncated.");
    const fixed = q.version ?? (q.cursor?.paging ? q.cursor : undefined);
    const reader = new ActivityReader(file, fixed?.end ?? initial.size, signal);
    for await (const _ of reader.records(true)) { /* validation pass, bounded diagnostic sample */ }
    for (const t of [q.cursor, q.version]) if (t) await reader.verify(t);
    const source = { v: 2, kind: "source", path: digest(q.path), sid: reader.sid, dev: initial.dev, ino: initial.ino, end: reader.end, hash: reader.hash };
    const diagnosticInfo = reader.diagnosticCount ? { inspection_complete: false, diagnostics: reader.diagnostics, total_diagnostics_count: reader.diagnosticCount, diagnostics_truncated: reader.diagnosticCount > reader.diagnostics.length } : {};
    const checkTarget = async () => {
      await reader.verify(source);
      const current = await stat(q.path);
      if (current.dev !== initial.dev || current.ino !== initial.ino || current.size < reader.size) fail("LARVA_CURSOR_STALE", "Target changed during inspection.");
      reader.check();
    };
    const base = q.cursor?.paging ? q.cursor.base : q.cursor?.end ?? 0;
    const mode = q.cursor?.paging ? q.cursor.mode : q.cursor ? "updates" : "recent";
    const tail = !q.cursor;
    const after: Position | undefined = q.cursor?.paging ? q.cursor.after : undefined;
    const selected: Selected[] = [];
    let eligible = 0, sawAfter = after === undefined;
    const offer = (c: Call, r: ResultRow | undefined, count = r ? 1 : 0, late = false, uncertain = false, dupeInfo?: { total: number; index: number }) => {
      const match = timeMatch(c, r, q);
      const position = late ? resultPosition(c, r!) : callPosition(c);
      if (!match) return;
      if (after && compare(position, after) === 0) sawAfter = true;
      if (after && compare(position, after) <= 0) return;
      const value = item(c, r, reader, count, dupeInfo);
      if (uncertain) { value.result_state = "ambiguous"; value.result_association = "ambiguous"; delete value.result; delete value.result_truncated; }
      if (late) value.update_type = "late_result";
      if (match !== "unfiltered") value.matched_by = match;
      eligible++; keep(selected, { position, value }, q.limit, tail);
    };

    let exactCount = 0, exactEligible = 0, exact: Call | undefined;
    const candidates: Obj[] = [];
    // Call locators are batched; results and duplicate counts are joined by a
    // rescan. This trades disk I/O for memory without a persistent index/cache.
    // Typical recent reads without time filters need just the tail batch.
    let lateRange: [number, number] | undefined;
    const batches = async function* (): AsyncGenerator<Call[]> {
      let batch: Call[] = [];
      for await (const row of reader.records()) for (const c of calls(row)) {
        if (q.call !== undefined) {
          if (c.id !== q.call) continue;
          const index = exactCount++;
          if (candidates.length < 5) candidates.push({ index, ...c.location, call_timestamp: c.timestamp });
          if ((q.index === undefined || q.index === index) && (q.entry === undefined || q.entry === c.location.entry_id)) { exactEligible++; if (!exact) exact = c; }
        } else if (!tail || q.since !== undefined || q.until !== undefined) {
          if (mode === "updates" && c.location.byte_offset < base) continue;
          batch.push(c); if (batch.length === BATCH) { yield batch; batch = []; }
        } else if (q.tool === undefined || c.name === q.tool) {
          batch.push(c); if (batch.length > q.limit) batch.shift();
        }
      }
      if (q.call !== undefined) { if (exact) yield [exact]; }
      else if (batch.length) yield batch;
      if (q.call !== undefined || mode !== "updates") return;
      // Old-call updates are driven by newly recorded result batches. A quiet
      // large history does not trigger a join pass for every old call.
      let updates: { id: string; name: string; offset: number }[] = [];
      const oldCalls = async function* (): AsyncGenerator<Call[]> {
        lateRange = [updates[0].offset, updates.at(-1)!.offset];
        let old: Call[] = [];
        for await (const row of reader.records()) for (const c of calls(row)) {
          if (c.location.byte_offset >= base || !updates.some(r => r.id === c.id && r.name === c.name)) continue;
          old.push(c); if (old.length === BATCH) { yield old; old = []; }
        }
        if (old.length) yield old;
      };
      for await (const row of reader.records()) {
        if (row.location.byte_offset < base || (after && row.location.byte_offset < after[0])) continue;
        const r = resultRow(row);
        if (!r || (q.tool !== undefined && r.name !== q.tool)) continue;
        updates.push({ id: r.id, name: r.name, offset: r.location.byte_offset });
        if (updates.length === BATCH) { yield* oldCalls(); updates = []; }
      }
      if (updates.length) yield* oldCalls();
    };
    let lookup: Obj | undefined;
    for await (const batch of batches()) {
      const callDupes = new Map<Call, { total: number; index: number }>(batch.map(c => [c, { total: 0, index: 0 }]));
      for await (const row of reader.records()) for (const c of calls(row)) {
        const posC = callPosition(c);
        for (const b of batch) if (c.id === b.id) {
          const info = callDupes.get(b)!;
          info.total++;
          if (compare(posC, callPosition(b)) < 0) info.index++;
        }
      }
      const results = new Map<Call, { count: number; first?: ResultRow; chosen?: ResultRow; candidates: Obj[]; timeResult?: ResultRow; uncertain: number }>(batch.map(c => [c, { count: 0, candidates: [], uncertain: 0 }]));
      for await (const row of reader.records()) {
        const r = resultRow(row); if (!r) continue;
        const matching = batch.filter(c => c.id === r.id && c.name === r.name && c.location.byte_offset < r.location.byte_offset);
        if (!matching.length) continue;
        const association = callDupes.get(matching[0])!.total > 1 ? await ancestor(reader, r) : undefined;
        for (const c of matching) {
          const rec = results.get(c)!;
          const uncertain = callDupes.get(c)!.total > 1 && !association;
          if (callDupes.get(c)!.total > 1 && association && compare(association, callPosition(c)) !== 0) continue;
          if (uncertain) rec.uncertain++;
          const index = rec.count++;
          if (!rec.first) rec.first = r;
          if (q.resultIndex === index) rec.chosen = r;
          if (timeMatch(c, r, q)) rec.timeResult = r;
          if (rec.candidates.length < 5) rec.candidates.push({ index, ...r.location, result_timestamp: r.timestamp, is_error: r.is_error });
          if (q.call === undefined && mode === "updates" && c.location.byte_offset < base && lateRange && r.location.byte_offset >= lateRange[0] && r.location.byte_offset <= lateRange[1]) offer(c, r, 1, true, uncertain, callDupes.get(c));
        }
      }
      for (const c of batch) {
        const rec = results.get(c)!;
        const r = rec.chosen ?? rec.first;
        if (q.call !== undefined) {
          const isUncertain = Boolean(rec.uncertain);
          const hasMultipleResults = rec.count > 1;
          const isAmbiguous = isUncertain || (hasMultipleResults && q.resultIndex === undefined);
          lookup = {
            call_id: c.id,
            tool_name: c.name,
            call_timestamp: c.timestamp,
            call_message_timestamp: c.message_timestamp,
            call_location: c.location,
            result_state: isAmbiguous ? "ambiguous" : r ? undefined : reader.diagnosticCount ? "incomplete" : "not_observed",
            ...(r ? {
              result_timestamp: r.timestamp,
              result_message_timestamp: r.message_timestamp,
              result_location: r.location,
              is_error: r.is_error,
              upstream_truncated: r.upstream_truncated,
            } : {}),
            result_candidates: hasMultipleResults ? rec.candidates : undefined,
            result_candidates_count: hasMultipleResults ? rec.count : undefined,
            selected_result_index: q.resultIndex,
            unassociated_results_count: rec.uncertain || undefined,
          };
          if (isUncertain) { lookup.result_state = "ambiguous"; lookup.result_association = "ambiguous"; }
          if (q.resultIndex !== undefined && !rec.chosen) fail("LARVA_BAD_INPUT", "result_index is out of range.");
          if (q.part === "result" && (!r || ((rec.uncertain || rec.count > 1) && q.resultIndex === undefined))) continue;
          let text = "";
          for await (const row of reader.records()) {
            if (q.part === "args" && row.location.byte_offset === c.location.byte_offset) text = JSON.stringify(row.raw.message.content[c.location.content_index!].arguments);
            if (q.part === "result" && r && row.location.byte_offset === r.location.byte_offset) text = JSON.stringify(row.raw.message);
          }
          if (q.offset > text.length) fail("LARVA_BAD_INPUT", "Segment offset exceeds saved data length.");
          // Segment identity includes exact call/result selection, while the file
          // portion uses the same consumed-prefix validation as recent cursors.
          const selection = `${c.location.byte_offset}:${c.location.content_index}:${q.part}:${q.part === "result" ? r?.location.byte_offset ?? "none" : "args"}`;
          if (q.version && q.version.selection !== selection) fail("LARVA_CURSOR_INVALID", "source_version belongs to a different call, result or segment part.");
          const part = text.slice(q.offset, q.offset + q.length);
          lookup.segment = { part: q.part, encoding: "json", offset_units: "UTF-16 code units", offset: q.offset, length: part.length, total_chars: text.length, has_more: q.offset + part.length < text.length, continuation_offset: q.offset + part.length < text.length ? q.offset + part.length : undefined, source_version: encode({ ...source, selection }), text: part, upstream_truncated: q.part === "result" ? r?.upstream_truncated : undefined };
        } else if (mode === "recent" || c.location.byte_offset >= base) {
          offer(c, rec.timeResult ?? r, rec.count, false, false, callDupes.get(c));
          const emitted = selected.find(x => x.position[0] === c.location.byte_offset && x.position[1] === c.location.content_index);
          if (emitted && rec.uncertain) {
            emitted.value.result_state = "ambiguous";
            emitted.value.result_association = "ambiguous";
            emitted.value.unassociated_results_count = rec.uncertain;
            delete emitted.value.result;
            delete emitted.value.result_truncated;
          }
        }
      }
    }
    await checkTarget();
    if (!sawAfter) fail("LARVA_CURSOR_INVALID", "Cursor position does not identify a matching recorded event.");
    if (q.call !== undefined) {
      if (!exactCount) return bounded({ status: reader.diagnosticCount ? "partial" : "not_found", error: { code: reader.diagnosticCount ? "LARVA_ACTIVITY_INCOMPLETE" : "LARVA_TOOL_CALL_NOT_FOUND", message: reader.diagnosticCount ? "ID not observed; inspection incomplete." : "ID not found in session after complete inspection." }, ...diagnosticInfo });
      if (!exactEligible) fail("LARVA_BAD_INPUT", "Call selector is out of range or does not match.");
      if (exactEligible > 1) return bounded({ status: "ambiguous", candidates, total_candidates_count: exactCount, candidates_truncated: exactCount > candidates.length, selection: "Use disambiguation_index (file order, zero-based); entry_id must select exactly one call.", ...diagnosticInfo });
      const payload = { status: "success", session_id: reader.sid, call: lookup!, ...diagnosticInfo };
      if (lookup!.segment) {
        const segment = lookup!.segment;
        while (!fits(payload) && segment.text.length > 1) {
          segment.text = segment.text.slice(0, Math.max(1, Math.floor(segment.text.length * .75)));
          segment.length = segment.text.length;
          segment.has_more = segment.offset + segment.length < segment.total_chars;
          segment.continuation_offset = segment.has_more ? segment.offset + segment.length : undefined;
        }
      }
      return bounded(payload);
    }
    // A fresh tail intentionally excludes older history. Only items removed
    // from that selected window by the byte budget become paging obligations.
    if (tail) eligible = selected.length;
    const makePayload = () => {
      const more = eligible > selected.length && selected.length > 0;
      const cursor = encode({ ...source, kind: "activity", filter: q.filter, mode, base, paging: more, ...(more ? { after: selected.at(-1)!.position } : {}) });
      return { status: "success", items: selected.map(x => x.value), has_more: more, cursor, ...diagnosticInfo };
    };
    let payload = makePayload();
    // Budget removal never commits a dropped item: regenerate the cursor from
    // the last actually delivered event within the same frozen snapshot/query.
    while (!fits(payload) && selected.length > 1) { selected.pop(); payload = makePayload(); }
    if (!fits(payload) && selected.length) {
      const v = selected[0].value;
      if (v.action && v.action.length > 50) {
        v.action = v.action.slice(0, 50);
        v.action_truncated = true;
      }
      if (v.result !== undefined) {
        delete v.result;
        v.result_state = "present_omitted";
        v.result_truncated = true;
      }
      payload = makePayload();
    }
    return bounded(payload);
  } catch (e) {
    const err = e as Obj;
    const code = err.activityError ? err.code : err.code === "ENOENT" ? "LARVA_SESSION_NOT_FOUND" : err.code === "EACCES" || err.code === "EPERM" ? "LARVA_SESSION_ACCESS_DENIED" : "LARVA_SESSION_READ_FAILED";
    return bounded({ status: "failed", error: { code, message: err.activityError ? err.message : "Unable to read the exact session snapshot." } });
  } finally {
    try { await file?.close(); }
    catch { return response({ status: "failed", error: { code: "LARVA_SESSION_READ_FAILED", message: "Session descriptor close failed." } }); }
  }
}
