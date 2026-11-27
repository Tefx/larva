import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toErrorEnvelope } from "./core/errors.ts";
import { isRecord } from "./core/predicates.ts";
import { SubagentSupervisor } from "./runtime/supervisor.ts";
import { PersonaStore } from "./store/persona-store.ts";
import { createMcpTools } from "./surfaces/mcp-tools.ts";
import { CODEX_INITIALIZE_INSTRUCTIONS, CODEX_PERSONA_URI_TEMPLATE, parsePersonaResourceUri, personaResourceUri } from "./ui/codex-mentions.ts";
import { CODEX_PANEL_DISPLAY_MODES, CODEX_PANEL_URI, renderCodexPanelHtml } from "./ui/codex-panel-html.ts";
import { CODEX_WIDGET_DISPLAY_MODES, CODEX_WIDGET_URI, renderCodexWidgetHtml } from "./ui/codex-widget-html.ts";

const versions = ["2026-07-28", "2025-11-25"];
const resourcePageSize = 50;
const maxMessageBytes = 8 * 1024 * 1024;
const maxIdBytes = 1024;
const maxHeaderBytes = 8192;
const maxConcurrentRequests = 128;
const rootsTimeoutMs = 5000;
const decoder = new TextDecoder("utf-8", { fatal: true });
const isId = (value: unknown): value is string | number | null =>
  value === null || (typeof value === "string" && Buffer.byteLength(JSON.stringify(value)) <= maxIdBytes)
  || (typeof value === "number" && Number.isFinite(value));
type Framing = "line" | "length";
type Id = string | number | null;
type Roots = { roots: { uri: string }[] };

function encodeFrame(message: object, framing: Framing) {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message });
  const bodyBytes = Buffer.byteLength(body);
  if (framing === "line") return { frame: `${body}\n`, bytes: bodyBytes + 1 };
  const header = `Content-Length: ${bodyBytes}\r\n\r\n`;
  return { frame: header + body, bytes: header.length + bodyBytes };
}

function stdioReader(message: (body: Buffer, framing: Framing) => void) {
  let buffer = Buffer.alloc(0), used = 0;
  let length: number | undefined, headerBytes = 0, readingBody = false;
  function append(bytes: Buffer, max: number) {
    const next = used + bytes.length;
    if (next > max) return false;
    if (next > buffer.length) {
      const grown = Buffer.allocUnsafe(Math.min(max, Math.max(next, 1024, buffer.length * 2)));
      buffer.copy(grown, 0, 0, used);
      buffer = grown;
    }
    bytes.copy(buffer, used);
    used = next;
    return true;
  }
  function emit(framing: Framing) {
    const body = buffer.subarray(0, used);
    used = 0;
    message(body, framing);
    if (buffer.length > 65536) buffer = Buffer.alloc(0);
  }
  function feed(chunk: Buffer) {
    let at = 0;
    while (at < chunk.length) {
      if (readingBody) {
        const end = Math.min(chunk.length, at + length! - used);
        if (!append(chunk.subarray(at, end), maxMessageBytes)) return false;
        at = end;
        if (used === length) {
          emit("length");
          length = undefined;
          headerBytes = 0;
          readingBody = false;
        }
        continue;
      }
      const newline = chunk.indexOf(10, at);
      const end = newline < 0 ? chunk.length : newline;
      if (!append(chunk.subarray(at, end), length === undefined ? maxMessageBytes : maxHeaderBytes - headerBytes)) return false;
      if (newline < 0) break;
      at = newline + 1;
      const line = buffer.subarray(0, used);
      if (length === undefined && !/^content-length:/i.test(line.toString("latin1", 0, 15))) {
        if (used === 0 || (used === 1 && line[0] === 13)) used = 0;
        else emit("line");
        continue;
      }
      headerBytes += used + 1;
      used = 0;
      if (headerBytes > maxHeaderBytes) return false;
      if (length === undefined) {
        const match = /^content-length:[ \t]*(\d+)[ \t]*\r$/i.exec(line.toString("latin1"));
        if (!match || Number(match[1]) > maxMessageBytes) return false;
        length = Number(match[1]);
      } else if (line.length === 1 && line[0] === 13) {
        // Zero-length frames still dispatch a parse error, even with no bytes following.
        if (length === 0) { emit("length"); length = undefined; headerBytes = 0; }
        else readingBody = true;
      } else if (!/^(?!content-length:)[a-z0-9-]+:[\t\x20-\x7e]*\r$/i.test(line.toString("latin1"))) return false;
    }
    return true;
  }
  return { feed, complete: () => used === 0 && length === undefined };
}

async function packageVersion(): Promise<string> {
  if (typeof __LARVA_VERSION__ === "string") return __LARVA_VERSION__;
  const manifest: unknown = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  if (!isRecord(manifest) || typeof manifest.version !== "string") throw new Error("Package version is unavailable.");
  return manifest.version;
}

const appMime = "text/html;profile=mcp-app";
const apps = [
  { uri: CODEX_PANEL_URI, name: "Larva Subagents Panel", modes: CODEX_PANEL_DISPLAY_MODES, render: renderCodexPanelHtml },
  { uri: CODEX_WIDGET_URI, name: "Larva Subagents Widget", modes: CODEX_WIDGET_DISPLAY_MODES, render: renderCodexWidgetHtml },
].map(({ uri, name, modes, render }) => ({
  resource: { uri, name, mimeType: appMime,
    _meta: { ui: { prefersBorder: true }, "openai/ui": { preferredDisplayMode: modes[0], availableDisplayModes: modes } } },
  render,
}));

/** Run one headless MCP host. Exit status belongs to the executable, not a tool call. */
export async function runMcpServer(env: NodeJS.ProcessEnv = process.env): Promise<0 | 1> {
  const { stdin, stdout } = process;
  const home = env.HOME || homedir();
  const path = env.PATH ? env.PATH.split(delimiter) : [];
  for (const dir of [join(home, ".local", "bin"), join(home, ".pi", "agent", "bin"), "/opt/homebrew/bin", "/usr/local/bin"]) {
    if (!path.includes(dir) && (await stat(dir).catch(() => undefined))?.isDirectory()) path.push(dir);
  }
  // Bundles use the supervisor's sibling JS entrypoints. Direct Node execution
  // uses the equivalent source siblings, not paths relative to src/runtime/.
  const supervisor = new SubagentSupervisor({
    env: { ...env, PATH: path.join(delimiter) },
    ...(import.meta.url.endsWith(".ts") && {
      extension: fileURLToPath(new URL("./pi-extension.ts", import.meta.url)),
      preload: fileURLToPath(new URL("./child-rpc-preload.ts", import.meta.url)),
    }),
  });
  const personas = new PersonaStore(supervisor.home);
  const tools = createMcpTools(supervisor, personas, maxMessageBytes);
  let rootsSupported = false, closed = false, eof = false, failed = false, running = 0;
  let version: Promise<string> | undefined;
  const stopped = Promise.withResolvers<0 | 1>();
  const pendingRoots = new Map<string, (value: unknown) => void>();
  const requests = new Map<Id, { controller: AbortController; work: Promise<void>; detachOnEof: boolean }>();
  let shutdown: Promise<void> | undefined;
  const brokenOutput = Promise.withResolvers<void>();

  function stop(mode: "eof" | "signal" | "fault" | "output") {
    if (mode === "fault" || mode === "output") failed = true;
    if (mode === "output") brokenOutput.resolve();
    if (mode !== "eof") closed = true;
    stdin.pause();
    const pending = Array.from(requests.values());
    for (const request of pending) if (closed || request.detachOnEof) request.controller.abort();
    shutdown ??= (async () => {
      const [{ settled }] = await Promise.all([supervisor.shutdown(), ...pending.map(({ work }) => work)]);
      if (!stdout.destroyed && stdout.writableLength) {
        // Wait for a write callback behind all queued replies, not for process.exit().
        await Promise.race([brokenOutput.promise, new Promise<void>(resolve => stdout.write("", () => resolve()))]);
      }
      closed = true;
      stopped.resolve(settled && !failed ? 0 : 1);
    })().catch(stopped.reject);
  }
  function send(message: { id: Id } & Record<string, unknown>, framing: Framing) {
    if (closed) return;
    let output = encodeFrame(message, framing);
    if (output.bytes > maxMessageBytes) {
      const error = { code: -32603, message: "Response exceeds the transport limit." };
      output = encodeFrame({ id: message.id, error }, framing);
    }
    if (stdout.writableLength > 0 && stdout.writableLength + output.bytes > maxMessageBytes) {
      stop("fault");
      return;
    }
    stdout.write(output.frame);
  }
  function rpcError(id: Id, code: number, message: string, framing: Framing, data?: unknown) {
    send({ id, error: { code, message, data } }, framing);
  }
  function listRoots(framing: Framing, signal: AbortSignal): Promise<Roots> {
    signal.throwIfAborted();
    if (closed || eof) return Promise.resolve({ roots: [] });
    const id = `roots:${randomUUID()}`;
    const reply = Promise.withResolvers<unknown>();
    const timeout = setTimeout(reply.resolve, rootsTimeoutMs, undefined);
    const abort = () => reply.resolve(undefined);
    signal.addEventListener("abort", abort, { once: true });
    pendingRoots.set(id, reply.resolve);
    send({ id, method: "roots/list" }, framing);
    return reply.promise.then(value => {
      signal.throwIfAborted();
      if (!isRecord(value) || !Array.isArray(value.roots) || value.roots.length !== 1) return { roots: [] };
      const root: unknown = value.roots[0];
      return { roots: isRecord(root) && typeof root.uri === "string" ? [{ uri: root.uri }] : [] };
    }).finally(() => { clearTimeout(timeout); pendingRoots.delete(id); signal.removeEventListener("abort", abort); });
  }

  async function dispatch(id: Id, method: string, params: Record<string, unknown>, framing: Framing, signal: AbortSignal) {
    const invalid = (message: string) => rpcError(id, -32602, message, framing);
    let result: unknown;
    switch (method) {
      case "initialize":
        rootsSupported = isRecord(params.capabilities) && isRecord(params.capabilities.roots);
        result = {
          protocolVersion: typeof params.protocolVersion === "string" && versions.includes(params.protocolVersion) ? params.protocolVersion : versions[0],
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: "larva-pi-subagent", title: "Larva Subagents", version: await (version ??= packageVersion()) },
          instructions: CODEX_INITIALIZE_INSTRUCTIONS,
        };
        break;
      case "ping": result = {}; break;
      case "tools/list": result = { tools: tools.definitions }; break;
      case "tools/call": {
        if (typeof params.name !== "string") return invalid("Expected a tool name.");
        result = await tools.call(params.name, params.arguments === undefined ? {} : params.arguments,
          rootsSupported ? () => listRoots(framing, signal) : undefined, signal);
        break;
      }
      case "resources/templates/list":
        result = { resourceTemplates: [{ uriTemplate: CODEX_PERSONA_URI_TEMPLATE, name: "larva-persona", title: "Larva Persona", mimeType: "text/markdown" }] };
        break;
      case "resources/list": {
        const { cursor } = params;
        if (cursor !== undefined && (typeof cursor !== "string" || !/^r:[1-9]\d*$/.test(cursor))) return invalid("Invalid resource cursor.");
        const start = typeof cursor === "string" ? Number(cursor.slice(2)) : 0;
        const catalog = await personas.list();
        const total = apps.length + catalog.length;
        if (!Number.isSafeInteger(start) || start > total) return invalid("Invalid resource cursor.");
        const resources = [];
        let bytes = 0, index = start;
        for (; index < total && resources.length < resourcePageSize; index++) {
          const persona = catalog[index - apps.length];
          const row = index < apps.length ? apps[index].resource : {
            uri: personaResourceUri(persona.id), name: persona.id, title: `@larva:${persona.id}`,
            mimeType: "text/markdown", description: persona.description,
          };
          bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
          if (bytes > maxMessageBytes / 2 && resources.length) break;
          resources.push(row);
        }
        result = { resources, ...(index < total && { nextCursor: `r:${index}` }) };
        break;
      }
      case "resources/read": {
        const uri = params.uri;
        if (typeof uri !== "string") return invalid("Expected a resource URI.");
        const app = apps.find(entry => entry.resource.uri === uri);
        if (app) {
          const { mimeType, _meta } = app.resource;
          result = { contents: [{ uri, mimeType, _meta, text: app.render(await (version ??= packageVersion())) }] };
          break;
        }
        const personaId = parsePersonaResourceUri(uri);
        if (!personaId) return invalid("Unknown or invalid resource URI.");
        const spec = await personas.get(personaId);
        result = { contents: [{ uri, mimeType: "text/markdown",
          text: `# @larva:${spec.id}\n\n${spec.description}\n\n- **persona_id**: \`${spec.id}\`\n- **model**: \`${spec.model}\`\n- **delegation**: Call \`larva_subagent\` with \`persona_id: "${spec.id}"\`.\n`,
        }] };
        break;
      }
      default: return rpcError(id, -32601, "Method not found", framing);
    }
    if (!signal.aborted) send({ id, result }, framing);
  }

  const reader = stdioReader((body, framing) => {
    if (closed || eof) return;
    let message: unknown;
    try { message = JSON.parse(decoder.decode(body)); }
    catch { return rpcError(null, -32700, "Parse error", framing); }
    if (!isRecord(message) || message.jsonrpc !== "2.0") {
      return rpcError(null, -32600, "Invalid Request", framing);
    }
    const { id, method, params } = message;
    if (id !== undefined && !isId(id)) return rpcError(null, -32600, "Invalid Request", framing);
    if (!Object.hasOwn(message, "method")) {
      if (typeof id === "string") {
        const settle = pendingRoots.get(id);
        if (settle) {
          const hasResult = Object.hasOwn(message, "result"), hasError = Object.hasOwn(message, "error");
          pendingRoots.delete(id);
          settle(hasResult && !hasError ? message.result : undefined);
          return;
        }
      }
      if (!Object.hasOwn(message, "result") && !Object.hasOwn(message, "error")) {
        rpcError(id ?? null, -32600, "Invalid Request", framing);
      }
      return;
    }
    if (typeof method !== "string") return rpcError(id ?? null, -32600, "Invalid Request", framing);
    if (id === undefined) {
      if (method === "notifications/cancelled" && isRecord(params) && isId(params.requestId)) {
        requests.get(params.requestId)?.controller.abort();
      }
      return;
    }
    if (params !== undefined && !isRecord(params)) return rpcError(id, -32602, "Expected named parameters", framing);
    if (requests.has(id)) return rpcError(null, -32600, "Request ID is already in use", framing);
    if (running >= maxConcurrentRequests) return rpcError(id, -32000, "Too many concurrent requests", framing);
    const controller = new AbortController(), { signal } = controller;
    const detachOnEof = method === "tools/call" && (params?.name === "larva_subagent" || params?.name === "larva_subagent_wait");
    const cancelled = Promise.withResolvers<void>();
    const abort = () => cancelled.resolve();
    signal.addEventListener("abort", abort, { once: true });
    ++running;
    const dispatched = Promise.resolve().then(() => {
      if (!signal.aborted) return dispatch(id, method, params ?? {}, framing, signal);
    }).catch(error => {
      if (signal.aborted) return;
      const { error: info } = toErrorEnvelope(error);
      const code = info.code === "LARVA_PERSONA_NOT_FOUND" ? -32002 : -32603;
      rpcError(id, code, info.message, framing, info);
    }).finally(() => { --running; });
    const work = Promise.race([dispatched, cancelled.promise]).finally(() => {
      signal.removeEventListener("abort", abort);
      requests.delete(id);
    });
    requests.set(id, { controller, work, detachOnEof });
  });
  const feed = (chunk: Buffer) => { if (!reader.feed(chunk)) stop("fault"); };
  const onEnd = () => { eof = true; stop(reader.complete() ? "eof" : "fault"); };
  const onFault = () => stop("fault");
  const onClose = () => { if (!eof) onFault(); };
  const onOutputError = () => stop("output");
  const onSignal = () => stop("signal");
  const signals = ["SIGTERM", "SIGINT"] as const;
  for (const signal of signals) process.on(signal, onSignal);
  stdout.on("error", onOutputError);
  stdin.on("end", onEnd).on("close", onClose).on("error", onFault).on("data", feed);
  if (stdin.readableEnded) onEnd();
  else if (stdin.destroyed) onClose();
  try { return await stopped.promise; }
  finally {
    stdin.off("data", feed).off("end", onEnd).off("close", onClose).off("error", onFault);
    stdout.off("error", onOutputError);
    for (const signal of signals) process.off(signal, onSignal);
  }
}

if (import.meta.main) {
  // An observer wait can outlive the transport. No observer owns child cleanup.
  process.exit(await runMcpServer());
}
