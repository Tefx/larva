import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, stat, type FileHandle } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { LarvaError, toErrorEnvelope } from "../core/errors.ts";
import type {
  ActivityCallDetail, ActivityCallItem, ActivityLocation, ActivityQuery, ActivityResponse, ActivitySegment,
} from "../core/types.ts";
import { isErrno } from "../store/capsule.ts";
import { resolveCanonicalSessionPath } from "../store/session-index.ts";

const RESPONSE_BYTES = 8192;
const READ_BYTES = 64 * 1024;
const RECORD_BYTES = 8 * 1024 * 1024;
const SNAPSHOT_BYTES = 128 * 1024 * 1024;
const INDEX_UNITS = 48 * 1024 * 1024;
const JOIN_STEPS = 1_000_000;
const decoder = new TextDecoder("utf-8", { fatal: true });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const uint = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function badInput(message: string): never { throw new LarvaError("LARVA_BAD_INPUT", message); }
function invalidSession(message: string): never { throw new LarvaError("LARVA_SESSION_INVALID", message); }
function stale(): never { return invalidSession("The recorded session snapshot changed."); }

function timestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length > 128) return;
  const match = /^(\d{4})-(\d\d)-(\d\d)T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!match) return;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) return;
  const ms = Date.parse(value);
  if (Number.isFinite(ms)) return ms;
}

const queryKeys = {
  task_id: true, limit: true, cursor: true, tool_name: true, since_timestamp: true, until_timestamp: true,
  tool_call_id: true, disambiguation_index: true, entry_id: true, result_index: true, segment_part: true,
  offset: true, length: true, source_version: true,
} satisfies Record<keyof ActivityQuery, true>;

type Position = [eventOffset: number, callOffset: number, contentIndex: number];
const compare = (a: Position, b: Position) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
type Source = { file: string; end: number; digest: string };
type Cursor = Source & { filter: string; base: number; after?: Position };
type Version = Source & { selection: string };
const encode = (value: Cursor | Version) => Buffer.from(JSON.stringify(value)).toString("base64url");

function token(value: unknown, extraKeys: string[]): Record<string, unknown> & Source {
  if (typeof value !== "string" || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    badInput("Invalid activity continuation token.");
  }
  let data: unknown;
  try { data = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); }
  catch { badInput("Invalid activity continuation token."); }
  const keys = ["file", "end", "digest", ...extraKeys];
  if (!object(data) || Object.keys(data).some(key => !keys.includes(key)) || !uint(data.end)
      || typeof data.file !== "string" || !/^[a-f0-9]{64}$/.test(data.file)
      || typeof data.digest !== "string" || !/^[a-f0-9]{64}$/.test(data.digest)) {
    badInput("Invalid activity continuation fields.");
  }
  return { ...data, file: data.file, end: data.end, digest: data.digest };
}

function parse(input: unknown) {
  if (!object(input) || Object.keys(input).some(key => !Object.hasOwn(queryKeys, key))) {
    badInput("Unknown activity parameter; supply task_id, not session_path.");
  }
  const { task_id, limit = 5, cursor, tool_name, since_timestamp, until_timestamp, tool_call_id,
    disambiguation_index, entry_id, result_index, segment_part, offset = 0, length = 2000, source_version } = input;
  if (!nonempty(task_id) || !isAbsolute(task_id) || normalize(task_id) !== task_id
      || !task_id.endsWith(".jsonl") || task_id.includes("\0") || Buffer.byteLength(task_id) > 4096) {
    badInput("task_id must be a canonical absolute .jsonl path.");
  }
  const identifier = (value: unknown): string | undefined => {
    if (value === undefined) return;
    if (!nonempty(value) || Buffer.byteLength(value) > 8192) badInput("Invalid activity identifier.");
    return value;
  };
  const tool = identifier(tool_name), callId = identifier(tool_call_id), entryId = identifier(entry_id);
  if (!uint(limit) || limit < 1 || limit > 20 || !uint(length) || length < 1 || length > 4000 || !uint(offset)
      || (disambiguation_index !== undefined && !uint(disambiguation_index))
      || (result_index !== undefined && !uint(result_index))) badInput("Invalid activity limit, offset, length or index.");
  if (entry_id !== undefined && disambiguation_index !== undefined) badInput("Use only one call selector.");
  if (segment_part !== undefined && segment_part !== "args" && segment_part !== "result") badInput("Invalid segment_part.");
  const since = timestamp(since_timestamp), until = timestamp(until_timestamp);
  if ((since_timestamp !== undefined && since === undefined) || (until_timestamp !== undefined && until === undefined)
      || (since !== undefined && until !== undefined && since > until)) badInput("Expected an ordered range of timezone-qualified ISO timestamps.");
  if (tool_call_id === undefined) {
    if ([entry_id, disambiguation_index, result_index, segment_part, input.offset, input.length, source_version]
      .some(value => value !== undefined)) badInput("Detail parameters require tool_call_id.");
  } else if ([cursor, tool_name, since, until].some(value => value !== undefined)) {
    badInput("Exact lookup does not take listing parameters.");
  }
  const filter = hash(JSON.stringify([tool_name ?? null, since ?? null, until ?? null]));
  let page: Cursor | undefined;
  if (cursor !== undefined) {
    const data = token(cursor, ["filter", "base", "after"]);
    const { base, after } = data;
    if (data.filter !== filter || !uint(base) || base > data.end
        || (after !== undefined && (!Array.isArray(after) || after.length !== 3 || !after.every(uint)
          || after[0] >= data.end || after[1] > after[0])) || (after === undefined && base !== data.end)) {
      badInput("Cursor does not match this activity query or position.");
    }
    page = { file: data.file, digest: data.digest, end: data.end, filter, base,
      after: after === undefined ? undefined : [after[0], after[1], after[2]] };
  }
  let version: Version | undefined;
  if (source_version !== undefined) {
    const data = token(source_version, ["selection"]);
    if (typeof data.selection !== "string" || !/^[a-f0-9]{64}$/.test(data.selection)) badInput("Invalid source_version selection.");
    version = { file: data.file, digest: data.digest, end: data.end, selection: data.selection };
  }
  if (offset > 0 && !version) badInput("Continued segments require source_version.");
  const part: "args" | "result" = segment_part ?? "result";
  return { path: task_id, limit, page, version, tool, since, until, filter, callId,
    callIndex: disambiguation_index, entryId, resultIndex: result_index, part, offset, length };
}
type Query = ReturnType<typeof parse>;

type Provenance = { location: ActivityLocation; timestamp?: string; time?: number; messageTime?: number; recordDigest?: string };
type Call = Provenance & { location: ActivityLocation & { content_index: number }; id: string; name: string;
  index: number; action: string; results: Result[]; uncertain: number };
type Result = Provenance & { id: string; name: string; preview: Omit<ActivityCallItem, "call_id" | "action"> };
type Entry = { location: ActivityLocation; calls: Call[] };
type Diagnostics = NonNullable<ActivityResponse["diagnostics"]>;

function record(bytes: Buffer): { value: unknown } | { kind: string; message: string } {
  let text: string;
  try { text = decoder.decode(bytes); }
  catch { return { kind: "invalid_utf8", message: "Invalid UTF-8 record." }; }
  try { return { value: JSON.parse(text) }; }
  catch { return { kind: "malformed_json", message: "Malformed JSON record." }; }
}

function substantialDetails(details: unknown): boolean {
  if (object(details)) return Object.entries(details).some(([key, value]) =>
    key !== "truncated" && key !== "fullOutputPath" && value != null
      && (key !== "truncation" || !object(value) || Object.keys(value).some(key => key !== "truncated")));
  if (typeof details === "string" || Array.isArray(details)) return details.length > 0;
  return typeof details === "number" || typeof details === "boolean";
}

// Detach bounded previews from large V8 string slices without replacing lone surrogates.
const detached = (value: string): string => Buffer.from(value, "utf16le").toString("utf16le");

function resultPreview(content: string | unknown[], details: unknown, isError: boolean | undefined): Result["preview"] {
  let text = "", chars = 0, pieces = 0;
  let hasImage = false, nonText = false;
  for (const part of typeof content === "string" ? [content] : content) {
    const value = typeof part === "string" ? part : object(part) && part.type === "text" ? part.text : undefined;
    if (typeof value === "string") {
      if (pieces++ && chars++ < 500) text += "\n";
      text += value.slice(0, Math.max(0, 500 - chars));
      chars += value.length;
    } else if (object(part) && part.type === "image") hasImage = true;
    else if (part != null) nonText = true;
  }
  const top = object(details) ? details.truncated : undefined;
  const nested = object(details) && object(details.truncation) ? details.truncation.truncated : undefined;
  const upstream = top === true || nested === true ? true : top === false || nested === false ? false : undefined;
  const hasDetails = substantialDetails(details);
  return { result: detached(text), is_error: isError, result_truncated: chars > 500 || hasImage || nonText || hasDetails || undefined,
    has_image: hasImage || undefined, non_text: nonText || undefined, has_details: hasDetails || undefined, upstream_truncated: upstream };
}

// Keep only provenance and compact projections, never whole parsed records or
// image/argument bodies. Each retained object/link and string has an index charge.
async function readSnapshot(file: FileHandle, size: number, q: Query, prior?: Source) {
  const pagingBase = q.page?.base ?? 0;
  if (size > SNAPSHOT_BYTES) invalidSession("Activity snapshot exceeds the inspection byte limit.");
  const calls: Call[] = [], results: Result[] = [];
  const byId = new Map<string, Call[]>(), entries = new Map<string, Entry[]>();
  const diagnostics: Diagnostics = [];
  let diagnosticCount = 0, budget = INDEX_UNITS;
  const diagnose = (kind: string, message: string, location: ActivityLocation) => {
    diagnosticCount++;
    if (diagnostics.length < 5) diagnostics.push({ kind, message, byte_offset: location.byte_offset,
      line_byte_length: location.line_byte_length, line_number: location.line_number, content_index: location.content_index });
  };
  const charge = (...values: (string | undefined | null)[]) => {
    budget -= 128;
    for (const value of values) budget -= 2 * (value?.length ?? 0);
    if (budget < 0) invalidSession("Activity snapshot exceeds the inspection index limit.");
  };
  let sessionId: string | undefined;
  const accept = (parts: Buffer[], location: ActivityLocation) => {
    const bytes = parts.length === 1 ? parts[0] : parts.length > 1 ? Buffer.concat(parts, location.line_byte_length) : undefined;
    const parsed = bytes ? record(bytes) : { kind: "oversized_record", message: "Record exceeds the inspection byte limit." };
    if (!("value" in parsed)) {
      if (location.line_number === 1) invalidSession("Invalid Pi session header.");
      diagnose(parsed.kind, parsed.message, location);
      return;
    }
    const row = parsed.value;
    if (location.line_number === 1) {
      if (!object(row) || row.type !== "session" || (row.version !== 2 && row.version !== 3) || !nonempty(row.id)) {
        invalidSession("Expected a Pi version 2 or 3 session header with an ID.");
      }
      sessionId = row.id;
      return;
    }
    if (!object(row)) { diagnose("malformed_record", "Record must be an object.", location); return; }
    if (nonempty(row.id)) location.entry_id = row.id;
    if (typeof row.parentId === "string" || row.parentId === null) location.parent_id = row.parentId;
    const entry: Entry = { location, calls: [] };
    if (location.entry_id !== undefined) {
      charge(location.entry_id, location.parent_id);
      const group = entries.get(location.entry_id);
      if (group) group.push(entry);
      else entries.set(location.entry_id, [entry]);
    }
    if (row.type !== "message") return;
    const m = row.message;
    if (!object(m)) { diagnose("malformed_record", "Missing message payload.", location); return; }
    if (m.role !== "assistant" && m.role !== "toolResult") return;
    const time = timestamp(row.timestamp);
    if (!location.entry_id || time === undefined || (row.parentId !== undefined && location.parent_id === undefined)) {
      diagnose("malformed_provenance", "Missing or invalid recorded provenance.", location);
    }
    const provenance = { location, time, timestamp: time === undefined ? undefined : String(row.timestamp),
      messageTime: typeof m.timestamp === "number" && Number.isFinite(m.timestamp) ? m.timestamp : undefined };
    let digest: string | undefined;
    const recordDigest = (id: string) => id === q.callId && bytes
      ? (digest ??= createHash("sha256").update(bytes).digest("hex")) : undefined;
    if (m.role === "assistant") {
      if (!Array.isArray(m.content)) { diagnose("malformed_record", "Assistant content must be an array.", location); return; }
      for (const [contentIndex, block] of m.content.entries()) {
        if (!object(block) || block.type !== "toolCall") continue;
        const callLocation = { ...location, content_index: contentIndex };
        if (!nonempty(block.id) || !nonempty(block.name) || !Object.hasOwn(block, "arguments")) {
          diagnose("malformed_record", "Tool call requires an ID, name and recorded arguments.", callLocation);
          continue;
        }
        const group = byId.get(block.id) ?? [];
        const action = detached(block.name.length >= 201 ? block.name.slice(0, 201)
          : `${block.name} ${serialize(block.arguments).slice(0, 200 - block.name.length)}`);
        charge(block.id, block.name, provenance.timestamp, action);
        const call = { ...provenance, location: callLocation, id: block.id, name: block.name,
          index: group.length, action, recordDigest: recordDigest(block.id), results: [], uncertain: 0 };
        if (!group.length) byId.set(call.id, group);
        group.push(call);
        calls.push(call);
        entry.calls.push(call);
      }
    } else if (nonempty(m.toolCallId) && nonempty(m.toolName) && (typeof m.content === "string" || Array.isArray(m.content))
        && (m.isError === undefined || typeof m.isError === "boolean")) {
      const preview = resultPreview(m.content, m.details, m.isError);
      charge(m.toolCallId, m.toolName, provenance.timestamp, preview.result);
      results.push({ ...provenance, id: m.toolCallId, name: m.toolName, preview, recordDigest: recordDigest(m.toolCallId) });
    } else diagnose("malformed_record", "Tool result requires an ID, name, content and an optional boolean error marker.", location);
  };
  let hasher = createHash("sha256"), pendingHash: typeof hasher | undefined;
  let pos = 0, end = 0, line = 0, pending = 0, priorVerified = !prior, sawBase = pagingBase === 0;
  let parts: Buffer[] = [];
  while (pos < size) {
    const buffer = Buffer.allocUnsafe(Math.min(READ_BYTES, size - pos));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, pos);
    if (bytesRead === 0) stale();
    const chunk = buffer.subarray(0, bytesRead);
    for (let from = 0; from < bytesRead;) {
      const nl = chunk.indexOf(10, from);
      const next = nl === -1 ? bytesRead : nl + 1;
      const piece = chunk.subarray(from, next);
      pending += piece.length;
      if (nl === -1) (pendingHash ??= hasher.copy()).update(piece);
      else {
        if (pendingHash) { hasher = pendingHash; pendingHash = undefined; }
        hasher.update(piece);
      }
      if (pending <= RECORD_BYTES) parts.push(piece);
      else parts = [];
      if (nl !== -1) {
        const location = { byte_offset: end, line_number: ++line, line_byte_length: pending };
        end = pos + next;
        if (end === pagingBase) sawBase = true;
        if (!priorVerified && prior && end >= prior.end) {
          if (end !== prior.end || hasher.copy().digest("hex") !== prior.digest) stale();
          priorVerified = true;
        }
        accept(parts, location);
        pending = 0;
        parts = [];
      }
      from = next;
    }
    pos += bytesRead;
  }
  if (!priorVerified) stale();
  if (!sawBase) badInput("Cursor base is not a recorded line boundary.");
  if (!sessionId) invalidSession("No complete Pi session header.");
  if (pending) diagnose("unterminated_tail", "Pending tail has no terminating newline.",
    { byte_offset: end, line_number: line + 1, line_byte_length: pending });
  return { sessionId, end, digest: hasher.digest("hex"), calls, results,
    byId, entries, diagnosticCount, diagnostics };
}
type Snapshot = Awaited<ReturnType<typeof readSnapshot>>;

function serialize(value: unknown): string {
  try { return JSON.stringify(value); }
  catch { return invalidSession("Recorded payload exceeds the supported JSON nesting depth."); }
}

async function prefixDigest(file: FileHandle, end: number): Promise<string> {
  const buffer = Buffer.allocUnsafe(READ_BYTES), hasher = createHash("sha256");
  for (let position = 0; position < end;) {
    const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, end - position), position);
    if (!bytesRead) stale();
    hasher.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hasher.digest("hex");
}

function joinResults(snapshot: Snapshot, q: Query, onResult?: (call: Call, result: Result, uncertain: boolean) => void) {
  let remaining = JOIN_STEPS;
  const step = () => { if (--remaining < 0) invalidSession("Activity association exceeds the inspection work limit."); };
  for (const result of snapshot.results) {
    if ((q.callId !== undefined && q.callId !== result.id) || (q.tool !== undefined && q.tool !== result.name)) continue;
    const group = snapshot.byId.get(result.id);
    if (!group) continue;
    const matches = (call: Call) => call.name === result.name && call.location.byte_offset < result.location.byte_offset;
    let assigned: Call | undefined;
    if (group.length === 1) {
      if (matches(group[0])) assigned = group[0];
      else continue;
    } else {
      // Duplicate IDs require recorded ancestry, not nearest-call heuristics.
      let child = result.location;
      while (typeof child.parent_id === "string") {
        step();
        const candidates = snapshot.entries.get(child.parent_id);
        const first = candidates?.[0];
        if (!first || first.location.byte_offset >= child.byte_offset
            || (candidates?.[1] && candidates[1].location.byte_offset < child.byte_offset)) break;
        let count = 0;
        for (const call of first.calls) {
          step();
          if (call.id === result.id && matches(call)) { assigned = call; count++; }
        }
        if (count > 1) { assigned = undefined; break; }
        if (count === 1) break;
        child = first.location;
      }
    }
    if (assigned) {
      assigned.results.push(result);
      onResult?.(assigned, result, false);
    } else {
      for (const call of group) {
        step();
        if (!matches(call)) continue;
        call.uncertain++;
        call.results.push(result);
        onResult?.(call, result, true);
      }
    }
  }
}

function diagnosticsFor(snapshot: Snapshot) {
  const { diagnosticCount, diagnostics } = snapshot;
  return diagnosticCount ? { inspection_complete: false as const, diagnostics, total_diagnostics_count: diagnosticCount,
    diagnostics_truncated: diagnosticCount > diagnostics.length } : {};
}

function missingResult(snapshot: Snapshot) { return snapshot.diagnosticCount ? "incomplete" : "not_observed"; }
function fits(response: ActivityResponse): boolean { return Buffer.byteLength(JSON.stringify(response)) <= RESPONSE_BYTES; }

async function savedSegment(file: FileHandle, call: Call, result: Result | undefined, q: Query): Promise<string> {
  const target = q.part === "args" ? call : result;
  if (!target?.recordDigest) stale();
  const { byte_offset, line_byte_length } = target.location;
  const buffer = Buffer.allocUnsafe(line_byte_length);
  for (let at = 0; at < buffer.length;) {
    const { bytesRead } = await file.read(buffer, at, buffer.length - at, byte_offset + at);
    if (!bytesRead) stale();
    at += bytesRead;
  }
  if (createHash("sha256").update(buffer).digest("hex") !== target.recordDigest) stale();
  const row = record(buffer);
  if (!("value" in row) || !object(row.value) || !object(row.value.message)) stale();
  const message = row.value.message;
  if (q.part === "result") return serialize(message);
  const block: unknown = Array.isArray(message.content) ? message.content[call.location.content_index] : undefined;
  if (!object(block) || !Object.hasOwn(block, "arguments")) stale();
  return serialize(block.arguments);
}

async function detail(file: FileHandle, snapshot: Snapshot, source: Source, q: Query): Promise<ActivityResponse> {
  const group = q.callId === undefined ? [] : snapshot.byId.get(q.callId) ?? [];
  const diagnostics = diagnosticsFor(snapshot);
  if (!group.length) {
    if (q.version) badInput("source_version does not match the selected call.");
    return { status: snapshot.diagnosticCount ? "partial" : "not_found", ...diagnostics,
      error: snapshot.diagnosticCount ? { code: "LARVA_SESSION_INVALID", message: "Call ID not observed; inspection was incomplete." }
        : { code: "LARVA_SESSION_NOT_FOUND", message: "Call ID not found in recorded session." } };
  }
  const matching = q.callIndex !== undefined ? group.slice(q.callIndex, q.callIndex + 1)
    : q.entryId !== undefined ? group.filter(call => call.location.entry_id === q.entryId) : group;
  if (!matching.length) badInput("Call selector is out of range or does not match.");
  if (matching.length > 1) {
    if (q.version) badInput("source_version requires an exact call selection.");
    return { status: "ambiguous", candidates: matching.slice(0, 5).map(c => ({ index: c.index, ...c.location,
      call_timestamp: c.timestamp })), total_candidates_count: matching.length, candidates_truncated: matching.length > 5,
      selection: "Use the zero-based disambiguation_index or an entry_id that selects one call.", ...diagnostics };
  }
  const call = matching[0], count = call.results.length;
  const result = q.resultIndex !== undefined ? call.results[q.resultIndex] : !call.uncertain && count === 1 ? call.results[0] : undefined;
  if (q.resultIndex !== undefined && !result) badInput("result_index is out of range for recorded candidates.");
  const response: ActivityResponse & { call: ActivityCallDetail } = { status: "success", session_id: snapshot.sessionId,
    ...diagnostics, call: {
      call_id: call.id, tool_name: call.name, call_location: call.location, call_timestamp: call.timestamp,
      call_message_timestamp: call.messageTime,
      result_state: call.uncertain || (count > 1 && !result) ? "ambiguous" : result ? undefined : missingResult(snapshot),
      result_association: call.uncertain ? "ambiguous" : undefined, unassociated_results_count: call.uncertain || undefined,
      result_location: result?.location, result_timestamp: result?.timestamp, result_message_timestamp: result?.messageTime,
      is_error: result?.preview.is_error, upstream_truncated: result?.preview.upstream_truncated,
      result_candidates_count: count > 1 || call.uncertain ? count : undefined,
      result_candidates: count > 1 || call.uncertain ? call.results.slice(0, 5).map((r, index) => ({ index, ...r.location,
        result_timestamp: r.timestamp, is_error: r.preview.is_error })) : undefined,
      selected_result_index: q.resultIndex,
    } };
  if (q.part === "result" && !result) {
    if (q.version) badInput("source_version does not match an available segment.");
    return response;
  }
  const selection = hash(JSON.stringify([call.location.byte_offset, call.location.content_index, q.part,
    q.part === "result" ? result?.location.byte_offset : null]));
  if (q.version && q.version.selection !== selection) badInput("source_version belongs to a different call, result or segment part.");
  const text = await savedSegment(file, call, result, q);
  if (q.offset > text.length) badInput("Offset exceeds saved data length.");
  const source_version = encode({ ...source, selection });
  const segment = (length: number): ActivitySegment => {
    const next = q.offset + length;
    return { part: q.part, encoding: "json", offset_units: "UTF-16 code units", text: text.slice(q.offset, next), offset: q.offset,
      length, total_chars: text.length, has_more: next < text.length, continuation_offset: next < text.length ? next : undefined,
      source_version, upstream_truncated: q.part === "result" ? result?.preview.upstream_truncated : undefined };
  };
  let length = Math.min(q.length, text.length - q.offset);
  response.call.segment = segment(length);
  while (!fits(response) && length > 1) {
    length = Math.max(1, Math.floor(length * 0.75));
    response.call.segment = segment(length);
  }
  return response;
}

function listing(snapshot: Snapshot, source: Source, q: Query): ActivityResponse {
  const base = q.page?.base ?? 0, after = q.page?.after;
  let eligible = 0, sawAfter = !after;
  const selected: { position: Position; item: ActivityCallItem }[] = [];
  const timeMatch = (time?: number) => (q.since === undefined && q.until === undefined)
    || (time !== undefined && (q.since === undefined || time >= q.since) && (q.until === undefined || time <= q.until));
  const offer = (call: Call, position: Position, result?: Result, lateUncertain?: boolean) => {
    if (q.tool !== undefined && q.tool !== call.name) return;
    if (after && compare(position, after) === 0) sawAfter = true;
    if (after && compare(position, after) <= 0) return;
    eligible++;
    if (selected.length === q.limit && compare(position, selected[q.page ? q.limit - 1 : 0].position) * (q.page ? 1 : -1) >= 0) return;
    const item: ActivityCallItem = { call_id: call.id, action: call.action.slice(0, 200), action_truncated: call.action.length > 200 || undefined,
      disambiguation_index: (snapshot.byId.get(call.id)?.length ?? 0) > 1 ? call.index : undefined };
    if (lateUncertain ?? (call.uncertain > 0)) {
      item.result_state = "ambiguous";
      item.result_association = "ambiguous";
      item.unassociated_results_count = lateUncertain ? undefined : call.uncertain;
    } else if (!result && call.results.length > 1) {
      item.result_state = "ambiguous";
      item.result_candidates_count = call.results.length;
      item.result_selection = "Use exact call lookup with result_index.";
    } else if (!result) item.result_state = missingResult(snapshot);
    else Object.assign(item, result.preview);
    selected.push({ position, item });
    selected.sort((a, b) => compare(a.position, b.position));
    if (selected.length > q.limit) q.page ? selected.pop() : selected.shift();
  };
  joinResults(snapshot, q, (call, result, uncertain) => {
    if (call.location.byte_offset < base && result.location.byte_offset >= base && (timeMatch(result.time) || timeMatch(call.time))) {
      offer(call, [result.location.byte_offset, call.location.byte_offset, call.location.content_index], result, uncertain);
    }
  });
  for (const call of snapshot.calls) {
    const start = call.location.byte_offset;
    if (start >= base && (timeMatch(call.time) || call.results.some(result => timeMatch(result.time)))) {
      offer(call, [start, start, call.location.content_index], call.results.length === 1 ? call.results[0] : undefined);
    }
  }
  if (!sawAfter) badInput("Cursor position does not identify a matching recorded event.");
  if (!q.page) eligible = selected.length; // Fresh reads select only the most recent window.
  const makeResponse = (): ActivityResponse => {
    const more = eligible > selected.length;
    return { status: "success", items: selected.map(x => x.item), has_more: more,
      cursor: encode({ ...source, filter: q.filter, base: more ? base : source.end,
        after: more ? selected.at(-1)?.position : undefined }), ...diagnosticsFor(snapshot) };
  };
  let response = makeResponse();
  while (!fits(response) && selected.length > 1) { selected.pop(); response = makeResponse(); }
  if (!fits(response) && selected.length) {
    const item = selected[0].item;
    if (item.result !== undefined) { delete item.result; item.result_state = "present_omitted"; item.result_truncated = true; }
    if (item.action.length > 50) { item.action = item.action.slice(0, 50); item.action_truncated = true; }
  }
  return response;
}

/** Read-only recorded evidence; does not consult or mutate live run state. */
export async function inspectSubagentActivity(larvaHome: string, input: unknown): Promise<ActivityResponse> {
  try {
    const q = parse(input);
    const target = await resolveCanonicalSessionPath(larvaHome, q.path);
    const file = await open(target, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const initial = await file.stat({ bigint: true });
      if (!initial.isFile()) invalidSession("Target is not a regular session file.");
      const checkTarget = async () => {
        const current = await resolveCanonicalSessionPath(larvaHome, target)
          .then(path => stat(path, { bigint: true })).catch(stale);
        if (current.dev !== initial.dev || current.ino !== initial.ino || current.size < initial.size) stale();
      };
      await checkTarget();
      const identity = hash(JSON.stringify([target, String(initial.dev), String(initial.ino)]));
      const prior = q.version ?? q.page;
      if (prior && (prior.file !== identity || BigInt(prior.end) > initial.size)) stale();
      const size = q.version?.end ?? (q.page?.after ? q.page.end : Number(initial.size));
      const snapshot = await readSnapshot(file, size, q, prior);
      const source = { file: identity, end: snapshot.end, digest: snapshot.digest };
      let response: ActivityResponse;
      if (q.callId !== undefined) {
        joinResults(snapshot, q);
        response = await detail(file, snapshot, source, q);
      } else response = listing(snapshot, source, q);
      if (await prefixDigest(file, snapshot.end) !== snapshot.digest) stale();
      await checkTarget();
      if (!fits(response)) invalidSession("Required activity metadata exceeds the 8192-byte response limit.");
      return response;
    } finally { await file.close(); }
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return { status: "failed", error: { code: "LARVA_SESSION_NOT_FOUND", message: "Session file not found." } };
    }
    if (isErrno(error, "ELOOP")) {
      return { status: "failed", error: { code: "LARVA_SESSION_INVALID", message: "Session path changed before opening." } };
    }
    return { status: "failed", error: toErrorEnvelope(error).error };
  }
}
