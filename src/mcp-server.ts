import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { toErrorEnvelope } from "./core/errors.ts";
import { SubagentSupervisor } from "./runtime/supervisor.ts";
import { PersonaStore } from "./store/persona-store.ts";
import { createMcpTools, isObject } from "./surfaces/mcp-tools.ts";
import { CODEX_INITIALIZE_INSTRUCTIONS, CODEX_PERSONA_URI_TEMPLATE, parsePersonaResourceUri, personaResourceUri } from "./ui/codex-mentions.ts";
import { CODEX_PANEL_DISPLAY_MODES, CODEX_PANEL_URI, renderCodexPanelHtml } from "./ui/codex-panel-html.ts";
import { CODEX_WIDGET_DISPLAY_MODES, CODEX_WIDGET_URI, renderCodexWidgetHtml } from "./ui/codex-widget-html.ts";

const versions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const maxMessageBytes = 8 * 1024 * 1024;
const maxHeaderBytes = 8192;
const maxConcurrentRequests = 128;
const rootsTimeoutMs = 5000;
const decoder = new TextDecoder("utf-8", { fatal: true });
const isId = (value: unknown): value is string | number | null =>
  value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
type Framing = "line" | "length";
type Id = string | number | null;
type Roots = { roots: { uri: string }[] };

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
  return (chunk: Buffer) => {
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
  };
}

async function packageVersion(): Promise<string> {
  if (typeof __LARVA_VERSION__ === "string") return __LARVA_VERSION__;
  const manifest: unknown = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  if (!isObject(manifest) || typeof manifest.version !== "string") throw new Error("Package version is unavailable.");
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
export async function runMcpServer(): Promise<0 | 1> {
  const { stdin, stdout } = process;
  // Bundles use the supervisor's sibling JS entrypoints. Direct Node execution
  // uses the equivalent source siblings, not paths relative to src/runtime/.
  const supervisor = new SubagentSupervisor(import.meta.url.endsWith(".ts") ? {
    extension: fileURLToPath(new URL("./pi-extension.ts", import.meta.url)),
    preload: fileURLToPath(new URL("./child-rpc-preload.ts", import.meta.url)),
  } : undefined);
  const personas = new PersonaStore(supervisor.home);
  const tools = createMcpTools(supervisor, personas);
  let rootsSupported = false, inFlight = 0, stopping = false;
  let version: Promise<string> | undefined;
  const stopped = Promise.withResolvers<0 | 1>();
  const pendingRoots = new Map<string, (value: unknown) => void>();

  function stop() {
    if (stopping) return;
    stopping = true;
    stdin.pause();
    for (const settle of pendingRoots.values()) settle(undefined);
    void supervisor.shutdown().then(({ settled }) => stopped.resolve(settled ? 0 : 1), stopped.reject);
  }
  function send(message: object, framing: Framing) {
    if (stopping) return;
    const body = JSON.stringify({ jsonrpc: "2.0", ...message });
    // Bound queued data if the peer sends requests without reading replies.
    if (stdout.writableLength > maxMessageBytes) { stop(); return; }
    stdout.write(framing === "length" ? `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}` : `${body}\n`);
  }
  function rpcError(id: Id, code: number, message: string, framing: Framing, data?: unknown) {
    send({ id, error: { code, message, data } }, framing);
  }
  function listRoots(framing: Framing): Promise<Roots> {
    if (stopping) return Promise.resolve({ roots: [] });
    const id = `roots:${randomUUID()}`;
    const reply = Promise.withResolvers<unknown>();
    const timeout = setTimeout(reply.resolve, rootsTimeoutMs, undefined);
    pendingRoots.set(id, reply.resolve);
    send({ id, method: "roots/list" }, framing);
    return reply.promise.then(value => {
      if (!isObject(value) || !Array.isArray(value.roots) || value.roots.length !== 1) return { roots: [] };
      const root: unknown = value.roots[0];
      return { roots: isObject(root) && typeof root.uri === "string" ? [{ uri: root.uri }] : [] };
    }).finally(() => { clearTimeout(timeout); pendingRoots.delete(id); });
  }

  async function dispatch(id: Id, method: string, params: Record<string, unknown>, framing: Framing) {
    const invalid = (message: string) => rpcError(id, -32602, message, framing);
    let result: unknown;
    switch (method) {
      case "initialize":
        rootsSupported = isObject(params.capabilities) && isObject(params.capabilities.roots);
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
          rootsSupported ? () => listRoots(framing) : undefined);
        break;
      }
      case "resources/templates/list":
        result = { resourceTemplates: [{ uriTemplate: CODEX_PERSONA_URI_TEMPLATE, name: "larva-persona", title: "Larva Persona", mimeType: "text/markdown" }] };
        break;
      case "resources/list":
        result = { resources: [...apps.map(app => app.resource), ...(await personas.list()).map(persona => ({
          uri: personaResourceUri(persona.id), name: persona.id, title: `@larva:${persona.id}`,
          mimeType: "text/markdown", description: persona.description,
        }))] };
        break;
      case "resources/read": {
        const uri = params.uri;
        if (typeof uri !== "string") return invalid("Expected a resource URI.");
        const app = apps.find(entry => entry.resource.uri === uri);
        if (app) {
          const { mimeType, _meta } = app.resource;
          result = { contents: [{ uri, mimeType, _meta, text: app.render() }] };
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
    send({ id, result }, framing);
  }

  const onData = stdioReader((body, framing) => {
    if (stopping) return;
    let message: unknown;
    try { message = JSON.parse(decoder.decode(body)); }
    catch { return rpcError(null, -32700, "Parse error", framing); }
    if (!isObject(message) || message.jsonrpc !== "2.0" || (Object.hasOwn(message, "id") && !isId(message.id))) {
      return rpcError(null, -32600, "Invalid Request", framing);
    }
    const { id, method, params } = message;
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
        rpcError(isId(id) ? id : null, -32600, "Invalid Request", framing);
      }
      return;
    }
    if (typeof method !== "string") return rpcError(isId(id) ? id : null, -32600, "Invalid Request", framing);
    if (!isId(id)) return; // Notification (including notifications/initialized).
    if (params !== undefined && !isObject(params)) return rpcError(id, -32602, "Expected named parameters", framing);
    if (inFlight >= maxConcurrentRequests) return rpcError(id, -32000, "Too many concurrent requests", framing);
    ++inFlight;
    void dispatch(id, method, params ?? {}, framing).catch(error => {
      const { error: info } = toErrorEnvelope(error);
      const code = info.code === "LARVA_PERSONA_NOT_FOUND" ? -32002 : -32603;
      rpcError(id, code, info.message, framing, info);
    }).finally(() => { --inFlight; });
  });
  const feed = (chunk: Buffer) => { if (!onData(chunk)) stop(); };
  const signals = ["SIGTERM", "SIGINT"] as const;
  for (const signal of signals) process.on(signal, stop);
  stdout.on("error", stop);
  stdin.on("end", stop).on("close", stop).on("error", stop).on("data", feed);
  if (stdin.readableEnded || stdin.destroyed) stop();
  try { return await stopped.promise; }
  finally {
    stdin.off("data", feed).off("end", stop).off("close", stop).off("error", stop);
    stdout.off("error", stop);
    for (const signal of signals) process.off(signal, stop);
  }
}

if (import.meta.main) {
  // An observer wait can outlive the transport. No observer owns child cleanup.
  process.exit(await runMcpServer());
}
