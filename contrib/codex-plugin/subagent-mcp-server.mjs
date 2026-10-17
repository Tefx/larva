#!/usr/bin/env node
// Stdio host for the Pi subagent runtime. Stdout is reserved for JSON-RPC.
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

// Native Pi keeps its static TUI import. Only this headless entry point supplies
// a fallback, and only when normal package resolution fails.
const headlessTui = `
const unavailable = () => { throw new Error("Terminal UI is unavailable in the MCP host"); };
export class Input { constructor() { unavailable(); } }
export class Markdown extends Input {}
export class SelectList extends Input {}
export const Key = {};
export const matchesKey = unavailable;
export const truncateToWidth = unavailable;
export const visibleWidth = unavailable;
export const wrapTextWithAnsi = unavailable;
`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (specifier !== '@earendil-works/pi-tui' || error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
      return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(headlessTui) };
    }
  },
});
let runtimePromise;
const getRuntime = () => (runtimePromise ??= import('./larva.ts'));

const string = { type: 'string', minLength: 1 };
const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const ids = { type: 'array', items: string, minItems: 1, maxItems: 25, uniqueItems: true };
const timeout = integer(0, 86400000);
const definitions = [
  ['larva_personas', 'List resolved persona candidates.', { query: { type: 'string' }, limit: integer(1, 25) }],
  ['larva_subagent', 'Spawn or resume an isolated Larva Pi child session when Larva-specific capabilities are requested: persona model-map routing, persistent .jsonl session resume, can_spawn policy, or larva_subagent_activity inspection. Hosts with built-in subagents should use those by default. Returns an exact .jsonl task_id handle for use only with larva_subagent_* tools. Default returns an accepted receipt; wait_for_completion returns terminal output.', { persona_id: string, task: string, task_id: string, no_progress_timeout_ms: integer(120000, 86400000), parent_persona_id: string, wait_for_completion: { type: 'boolean' } }, ['persona_id', 'task']],
  ['larva_subagent_wait', 'Wait only on exact .jsonl task_id handles returned by larva_subagent, never handles from other agent tools; return captured terminal output for ready tasks.', { task_ids: ids, return_when: { enum: ['all', 'any', 'first_error'] }, timeout_ms: timeout }, ['task_ids']],
  ['larva_subagent_select', 'Wait for any exact .jsonl task_id handle returned by larva_subagent, never handles from other agent tools; return captured terminal output.', { task_ids: ids, timeout_ms: timeout }, ['task_ids']],
  ['larva_subagent_status', 'Inspect process-local runs and startup failures.', { task_id: string, limit: integer(1, 25) }],
  ['larva_subagent_events', 'Inspect ordered process-local lifecycle events.', { since_sequence: integer(0, Number.MAX_SAFE_INTEGER), task_ids: ids, limit: integer(1, 100) }],
  ['larva_subagent_sessions', 'List recent process-local child sessions.', { limit: integer(1, 25) }],
  ['larva_subagent_cancel', 'Cancel only an exact .jsonl task_id handle returned by larva_subagent, never handles from other agent tools.', { task_id: string, reason: string }, ['task_id', 'reason']],
  ['larva_subagent_activity', 'Read recorded tool activity from an exact child session JSONL path.', { task_id: string, session_path: string, limit: integer(1, 20), cursor: string, tool_name: string, since_timestamp: string, until_timestamp: string, tool_call_id: string, disambiguation_index: integer(0, Number.MAX_SAFE_INTEGER), entry_id: string, segment_part: { enum: ['args', 'result'] }, result_index: integer(0, Number.MAX_SAFE_INTEGER), offset: integer(0, Number.MAX_SAFE_INTEGER), length: integer(1, 4000), source_version: string }],
];
const tools = definitions.map(([name, description, properties, required = []]) => ({ name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } }));
const shutdownController = new AbortController();
const disconnected = new Promise(resolve => shutdownController.signal.addEventListener('abort', resolve, { once: true }));
const home = process.env.HOME || homedir();
const pathEntries = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
for (const directory of [join(home, '.local/bin'), join(home, '.pi/agent/bin'), '/opt/homebrew/bin', '/usr/local/bin']) {
  if (existsSync(directory) && !pathEntries.includes(directory)) pathEntries.push(directory);
}
const ctx = { env: { ...process.env, PATH: pathEntries.join(delimiter) }, externalHostCanSpawn: true, abortSignal: shutdownController.signal };
// Bound retained output to the same recent-terminal window as the runtime.
const outbox = new Map();
function remember(taskId, slot) {
  outbox.delete(taskId);
  outbox.set(taskId, slot);
  const completed = [...outbox].filter(([, value]) => value.payload);
  for (const [id] of completed.slice(0, Math.max(0, completed.length - 25))) outbox.delete(id);
}
function badInput(message) {
  return { content: [{ type: 'text', text: `LARVA_BAD_INPUT: ${message}` }], isError: true, details: { status: 'failed', error: { code: 'LARVA_BAD_INPUT', message } } };
}
function validValue(value, schema) {
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === 'string') return typeof value === 'string' && value.length >= (schema.minLength ?? 0);
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'integer') return Number.isSafeInteger(value) && value >= schema.minimum && value <= schema.maximum;
  if (schema.type === 'array') return Array.isArray(value) && value.length >= schema.minItems && value.length <= schema.maxItems && new Set(value).size === value.length && value.every(item => validValue(item, schema.items));
  return true;
}
async function enrich(result) {
  const terminalOutputs = {};
  for (const taskId of result.details?.ready_task_ids ?? []) {
    const slot = outbox.get(taskId);
    const snapshot = result.details.snapshots?.[taskId];
    if (slot && !slot.payload && snapshot?.callback_delivery === 'pending') {
      await Promise.race([slot.delivered, disconnected]);
    }
    if (slot?.payload) terminalOutputs[taskId] = slot.payload;
  }
  return { ...result, details: { ...result.details, terminal_outputs: terminalOutputs }, content: [...result.content, ...Object.values(terminalOutputs).map(output => ({ type: 'text', text: output.message }))] };
}
async function callTool(name, args) {
  const tool = tools.find(tool => tool.name === name);
  if (!tool) throw Object.assign(new Error(`Unknown tool: ${name}`), { rpcCode: -32602 });
  if (!args || typeof args !== 'object' || Array.isArray(args)) return badInput('arguments must be an object.');
  const schema = tool.inputSchema;
  if (schema.required.some(key => !Object.hasOwn(args, key)) || Object.entries(args).some(([key, value]) => !Object.hasOwn(schema.properties, key) || !validValue(value, schema.properties[key]))) return badInput('Arguments do not match the tool input schema.');
  const runtime = await getRuntime();
  if (name === 'larva_subagent') {
    let release;
    const slot = { payload: null, delivered: new Promise(resolve => { release = resolve; }) };
    const callbackSurface = { sendMessage(message) {
      slot.payload = { ...message.details, full_output_artifact: message.details.full_output_artifact ?? null, message: message.content };
      remember(message.details.task_id, slot);
      release();
    } };
    const { wait_for_completion, ...input } = args;
    const result = await runtime.larva_subagent(input, { ...ctx, callbackSurface });
    if (result.status === 'accepted') remember(result.task_id, slot);
    if (result.status === 'accepted' && wait_for_completion) {
      let waited;
      do {
        waited = await runtime.larva_subagent_wait({ task_ids: [result.task_id], timeout_ms: 86400000 }, ctx);
      } while (!waited.isError && !waited.details.satisfied && !shutdownController.signal.aborted);
      return await enrich(waited);
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result, isError: result.status !== 'accepted' && result.status !== 'success' };
  }
  const result = await runtime[name](args, ctx);
  return name === 'larva_subagent_wait' || name === 'larva_subagent_select' ? await enrich(result) : result;
}

let stopping;
function shutdown() {
  if (!stopping) {
    shutdownController.abort();
    stopping = (runtimePromise
      ? runtimePromise.then(runtime => runtime.resetExtensionUI('mcp_shutdown'), () => {})
      : Promise.resolve()).then(() => { process.exitCode = 0; });
  }
  return stopping;
}
process.stdin.on('end', shutdown);
process.stdin.on('close', shutdown);
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { void shutdown().then(() => process.exit(0)); });
process.stdout.on('error', () => { void shutdown().then(() => process.exit(0)); });

function send(value, framed) {
  if (stopping) return;
  const body = JSON.stringify(value);
  process.stdout.write(framed ? `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}` : `${body}\n`);
}
async function dispatch(message, framed) {
  const id = typeof message?.id === 'string' || typeof message?.id === 'number' ? message.id : null;
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || (Object.hasOwn(message, 'id') && typeof message.id !== 'string' && typeof message.id !== 'number' && message.id !== null)) {
    send({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } }, framed);
    return;
  }
  if (!Object.hasOwn(message, 'id')) return;
  try {
    let result;
    switch (message.method) {
      case 'initialize': result = { protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'].includes(message.params?.protocolVersion) ? message.params.protocolVersion : '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'larva-pi-subagent', version: '0.8.8' } }; break;
      case 'ping': result = {}; break;
      case 'tools/list': result = { tools }; break;
      case 'tools/call': result = await callTool(message.params?.name, message.params?.arguments === undefined ? {} : message.params.arguments); break;
      default: throw Object.assign(new Error('Method not found'), { rpcCode: -32601 });
    }
    // MCP tool results expose runtime details as structuredContent as well as text.
    if (message.method === 'tools/call') result = { ...result, structuredContent: result.details ?? result, content: result.content ?? [{ type: 'text', text: JSON.stringify(result) }] };
    send({ jsonrpc: '2.0', id: message.id, result }, framed);
  } catch (error) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: error.rpcCode ?? -32603, message: error.message ?? String(error) } }, framed);
  }
}
// Buffer bytes (not UTF-16 code units) so split multibyte framed bodies work.
let buffer = Buffer.alloc(0);
const maxMessageBytes = 8 * 1024 * 1024;
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length && !stopping) {
    let body, framed = false;
    if (/^Content-Length:/i.test(buffer.toString('ascii', 0, 15))) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) break;
      const match = /^Content-Length:\s*(\d+)\s*$/im.exec(buffer.subarray(0, headerEnd).toString('ascii'));
      const length = match ? Number(match[1]) : -1;
      if (!Number.isSafeInteger(length) || length < 0 || length > maxMessageBytes) { void shutdown(); break; }
      if (buffer.length < headerEnd + 4 + length) break;
      body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8');
      buffer = buffer.subarray(headerEnd + 4 + length);
      framed = true;
    } else {
      const end = buffer.indexOf(10);
      if (end < 0) break;
      body = buffer.subarray(0, end).toString('utf8').trim();
      buffer = buffer.subarray(end + 1);
      if (!body) continue;
    }
    try { void dispatch(JSON.parse(body), framed); }
    catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, framed); }
  }
  if (buffer.length > maxMessageBytes) void shutdown();
});
