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
tools.push({
  name: 'search_mentions',
  title: 'Search Larva personas',
  description: 'Search registered Larva personas for composer @-mention completion.',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  _meta: { 'openai/extensions': { 'mentions/search': {} }, ui: { visibility: ['app'] } },
});
tools.push({
  name: 'larva_subagent_panel', title: 'Larva Subagents',
  description: 'Open the Larva subagent live activity panel and inspect active or recent Pi child sessions.',
  inputSchema: { type: 'object', properties: { task_id: string, limit: integer(1, 25) }, required: [], additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  _meta: { ui: { resourceUri: 'ui://larva-pi-subagent/panel', visibility: ['app'] }, 'openai/ui': { entrypoints: [{ type: 'thread' }] } },
});
for (const tool of tools) {
  if (['larva_subagent', 'larva_subagent_wait', 'larva_subagent_select', 'larva_subagent_status'].includes(tool.name)) {
    tool._meta = { ui: { resourceUri: 'ui://larva-pi-subagent/widget', visibility: ['model', 'app'] }, 'openai/ui': { preferredModelDisplayMode: 'inline' } };
  }
}
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
  if (name === 'larva_subagent_panel') {
    const status = await runtime.larva_subagent_status(args, ctx);
    const sessions = args.task_id ? [] : (await runtime.larva_subagent_sessions(args.limit === undefined ? {} : { limit: args.limit }, ctx)).details.sessions;
    const runs = status.details.runs;
    const terminal_outputs = Object.fromEntries(runs.filter(run => !run.result_pending && outbox.get(run.task_id)?.payload).map(run => [run.task_id, outbox.get(run.task_id).payload]));
    return { content: [{ type: 'text', text: `${runs.length} recent subagent run(s); ${runs.filter(run => run.result_pending).length} active.` }], details: { ...status.details, sessions, terminal_outputs }, isError: status.isError };
  }
  if (name === 'search_mentions') {
    const normalizedQuery = args.query.trim().replace(/^(?:@?(?:larva|persona):|@)/i, '').trim();
    const items = runtime.rankPersonasForSelector(await runtime.listPersonas(ctx), normalizedQuery).slice(0, 30).map(persona => ({
      type: 'resource_link',
      uri: `larva://personas/${encodeURIComponent(persona.id)}`,
      name: persona.id,
      title: `@larva:${persona.id}`,
      ...(persona.description || persona.model ? { description: persona.description ?? persona.model } : {}),
      mimeType: 'text/markdown',
    }));
    return { content: [], details: { items }, isError: false };
  }
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

// Serialized into both UI resources; all data stays on the host postMessage bridge.
function subagentPanelApp(surface) {
  let sequence = 0, selected = null, personaHint = null, filter = {}, state = { runs: [], terminal_outputs: {} }, mode = surface === 'panel' ? 'fullscreen' : 'inline', stopped = false, polling = false;
  const pending = new Map();
  const root = document.getElementById('app');
  const notify = (method, params) => window.parent.postMessage({ jsonrpc: '2.0', method, params }, '*');
  function rpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Host request timed out')); }, 15000);
      pending.set(id, { resolve, reject, timer });
      window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
    });
  }
  async function tool(name, args) {
    const result = await rpc('tools/call', { name, arguments: args });
    const data = result.structuredContent ?? result.details;
    if (result.isError) throw new Error(data?.error?.message ?? 'Tool failed');
    return data ?? result;
  }
  function hostContext(context) {
    for (const [key, value] of Object.entries(context?.styles?.variables ?? {})) {
      if (key.startsWith('--')) document.documentElement.style.setProperty(key, String(value));
    }
    if (context?.theme) document.documentElement.dataset.theme = context.theme;
    if (context?.displayMode) mode = context.displayMode;
  }
  function accept(data) {
    if (data?.persona_id) personaHint = data.persona_id;
    if (data?.runs) state = { ...state, ...data };
    if (data?.snapshots) state.runs = Object.values(data.snapshots).flat();
    if (data?.task_id) { selected = data.task_id; filter = { task_id: data.task_id }; }
    render();
  }
  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.data?.jsonrpc !== '2.0') return;
    const message = event.data;
    const waiter = pending.get(message.id);
    if (waiter && !message.method) {
      pending.delete(message.id); clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result);
      return;
    }
    if (message.method === 'ui/notifications/host-context-changed') hostContext(message.params?.hostContext ?? message.params);
    if (message.method === 'ui/notifications/tool-input') { accept(message.params?.arguments); void refresh(); }
    if (message.method === 'ui/notifications/tool-result') { accept(message.params?.structuredContent); void refresh(); }
    if (message.method === 'ui/resource-teardown') {
      stopped = true; clearTimeout(pollTimer); clearInterval(clock);
      observer.disconnect();
      for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Panel closed')); }
      pending.clear();
      window.parent.postMessage({ jsonrpc: '2.0', id: message.id, result: {} }, '*');
    }
  });
  function element(tag, text, parent = root) {
    const node = document.createElement(tag); if (text !== undefined) node.textContent = text; parent.append(node); return node;
  }
  function button(text, action, parent) {
    const node = element('button', text, parent);
    node.onclick = () => Promise.resolve().then(action).catch(showError);
    return node;
  }
  function showError(error) { document.getElementById('error').textContent = error.message ?? JSON.stringify(error); }
  function render() {
    root.replaceChildren();
    const runs = state.runs ?? [];
    const active = runs.filter(run => run.result_pending).length;
    const header = element('header');
    element('strong', `Larva Subagents · ${active} active / ${runs.length - active} completed`, header);
    button('Refresh', refresh, header);
    button(mode === 'inline' ? 'Fullscreen' : 'Inline', async () => {
      const result = await rpc('ui/request-display-mode', { mode: mode === 'inline' ? 'fullscreen' : 'inline' });
      mode = result.mode ?? mode; render();
    }, header);
    element('div', state.error?.message ?? '', root).id = 'error';
    const layout = element('main'); const list = element('nav', undefined, layout);
    for (const run of runs) {
      const card = button(`${run.persona_id}\n${run.phase} · ${run.startup_model ?? 'route pending'} / ${run.startup_thinking ?? '-'}\n${run.task_preview}\n${run.active_tool?.name ?? (run.live_thinking ? 'Thinking…' : '')}`, () => { selected = run.task_id; render(); }, list);
      card.dataset.status = run.status;
      element('span', run.status, card).className = 'badge';
      const elapsed = element('small', '', card); elapsed.dataset.started = run.started_at; elapsed.dataset.elapsed = String(run.elapsed_ms); elapsed.dataset.active = String(run.result_pending);
    }
    const detail = element('section', undefined, layout);
    const run = runs.find(run => run.task_id === selected) ?? runs.find(run => run.persona_id === personaHint) ?? runs[0];
    if (!run) { element('p', personaHint ? `Waiting for ${personaHint}…` : 'No recent subagent runs.', detail); return; }
    selected = run.task_id;
    element('h2', run.persona_id, detail);
    element('pre', JSON.stringify(Object.fromEntries(['task_id', 'persona_id', 'startup_model', 'startup_thinking', 'phase', 'elapsed_ms'].map(key => [key, run[key]])), null, 2), detail);
    if (['accepted', 'running'].includes(run.status)) button('Cancel', async () => { await tool('larva_subagent_cancel', { task_id: run.task_id, reason: 'Cancelled from activity panel' }); await refresh(); }, detail);
    element('h3', run.live_thinking ? 'Thinking…' : 'Assistant stream', detail);
    element('pre', run.live_assistant_preview ?? '', detail);
    element('h3', 'Result', detail);
    element('pre', state.terminal_outputs?.[run.task_id]?.result_text ?? run.result_preview ?? run.error?.message ?? '', detail);
    if (run.active_tool) element('strong', `Active tool: ${run.active_tool.name ?? run.active_tool.toolCallId}`, detail);
    const calls = element('ol', undefined, detail);
    for (const call of run.tool_snapshots ?? []) {
      const item = element('li', undefined, calls);
      element('strong', `${call.name ?? call.toolCallId} · ${call.status}`, item);
      element('pre', [call.args_preview, call.output_preview, call.error_preview].filter(Boolean).join('\n'), item);
      const expanded = element('pre', '', item);
      for (const part of ['args', 'result']) button(`Inspect ${part}`, async () => {
        const result = await tool('larva_subagent_activity', { task_id: run.task_id, tool_call_id: call.toolCallId, segment_part: part });
        expanded.textContent = JSON.stringify(result, null, 2);
      }, item);
    }
    tick();
  }
  function tick() {
    for (const node of document.querySelectorAll('[data-started]')) node.textContent = `${Math.floor((node.dataset.active === 'true' ? Date.now() - Date.parse(node.dataset.started) : Number(node.dataset.elapsed)) / 1000)}s`;
  }
  async function refresh() {
    if (stopped || polling || document.visibilityState === 'hidden') return;
    polling = true;
    try { state = await tool('larva_subagent_panel', filter); render(); }
    catch (error) { showError(error); }
    finally { polling = false; }
  }
  let pollTimer;
  async function poll() {
    await refresh();
    if (!stopped) pollTimer = setTimeout(poll, state.runs?.some(run => run.result_pending || run.status === 'running') ? 1000 : 2500);
  }
  const observer = new ResizeObserver(() => { if (mode === 'inline' && !stopped) notify('ui/notifications/size-changed', { height: document.documentElement.scrollHeight }); });
  observer.observe(root);
  const clock = setInterval(tick, 1000);
  document.addEventListener('visibilitychange', () => { if (!stopped && document.visibilityState !== 'hidden') void refresh(); });
  render();
  rpc('ui/initialize', { protocolVersion: '2026-01-26', appInfo: { name: 'Larva Subagents', version: '0.8.9' }, appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] } }).then(result => {
    if (stopped) return;
    hostContext(result.hostContext); notify('ui/notifications/initialized', {}); void poll();
  }).catch(showError);
}
function renderSubagentPanelHtml(surface) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'"><style>
  :root{color-scheme:light dark;font:14px system-ui;color:var(--color-text-primary,inherit);background:var(--color-background-primary,transparent)}[data-theme=light]{color-scheme:light}[data-theme=dark]{color-scheme:dark}body{margin:12px}header{display:flex;gap:10px;align-items:center;flex-wrap:wrap}main{display:grid;grid-template-columns:minmax(180px,30%) 1fr;gap:16px}nav{display:flex;flex-direction:column;gap:8px}button{cursor:pointer;padding:8px;text-align:left;white-space:pre-wrap;border:1px solid #8886;border-radius:6px;background:transparent;color:inherit}button:hover{background:#8882}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:360px;overflow:auto}section{min-width:0}small{display:block}.badge{display:inline-block;border:1px solid #8888;border-radius:10px;padding:1px 6px;margin:4px}[data-status=running] .badge{color:#69c}[data-status=success] .badge{color:#5a7}[data-status=failed] .badge{color:#d66}#error{color:#d55}li{margin-bottom:12px}@media(max-width:600px){main{grid-template-columns:1fr}}
  </style></head><body><div id="app"></div><script>(${subagentPanelApp.toString()})(${JSON.stringify(surface)})</script></body></html>`;
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
      case 'initialize':
        result = {
          protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25', '2026-07-28'].includes(message.params?.protocolVersion) ? message.params.protocolVersion : '2024-11-05',
          capabilities: {
            tools: {}, resources: {},
            extensions: { 'openai/mentions': { searchTool: 'search_mentions' } },
            experimental: { 'openai/mentions': { searchTool: 'search_mentions' } },
          },
          serverInfo: { name: 'larva-pi-subagent', title: 'Larva Subagents', version: '0.8.9' },
          instructions: 'When the user mentions @larva:<persona_id>, @persona:<persona_id>, or a larva://personas/<persona_id> resource (including [@larva:<persona_id>](mcp-resource://...)), delegate the requested task to larva_subagent with persona_id="<persona_id>" and wait_for_completion=true (or false for parallel fan-out). When @Larva Subagents is mentioned without an exact persona_id, call larva_personas first.',
        };
        break;
      case 'ping': result = {}; break;
      case 'resources/templates/list':
        result = {
          resourceTemplates: [{
            uriTemplate: 'larva://personas/{persona_id}',
            name: 'larva-persona', title: 'Larva Persona',
            description: 'Resolved Larva persona metadata and delegation guidance.',
            mimeType: 'text/markdown',
          }],
        };
        break;
      case 'resources/list': {
        const runtime = await getRuntime();
        const personas = await runtime.listPersonas(ctx);
        result = { resources: personas.map(persona => ({
          uri: `larva://personas/${encodeURIComponent(persona.id)}`,
          name: persona.id, title: `@larva:${persona.id}`,
          ...(persona.description || persona.model ? { description: persona.description ?? persona.model } : {}),
          mimeType: 'text/markdown',
        })) };
        break;
      }
      case 'resources/read': {
        const uri = message.params?.uri;
        if (uri === 'ui://larva-pi-subagent/panel' || uri === 'ui://larva-pi-subagent/widget') {
          const surface = uri.endsWith('/panel') ? 'panel' : 'widget';
          const modes = surface === 'panel' ? ['fullscreen', 'inline'] : ['inline', 'fullscreen'];
          result = { contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: renderSubagentPanelHtml(surface), _meta: { 'openai/ui': { preferredDisplayMode: modes[0], availableDisplayModes: modes }, ui: { prefersBorder: true } } }] };
          break;
        }
        const match = typeof uri === 'string' && /^larva:\/\/personas\/([^/?#]+)$/.exec(uri);
        if (!match) throw { rpcCode: -32602, message: 'Invalid persona resource URI.' };
        let personaId;
        try { personaId = decodeURIComponent(match[1]); }
        catch { throw { rpcCode: -32602, message: 'Invalid persona resource URI.' }; }
        const runtime = await getRuntime();
        let spec;
        try { spec = await runtime.resolvePersona(personaId, ctx); }
        catch (error) { throw { rpcCode: -32602, message: error.message ?? String(error) }; }
        result = { contents: [{
          uri, mimeType: 'text/markdown',
          text: `# @larva:${spec.id}\n\n${spec.description ?? ''}\n\n- **persona_id**: \`${spec.id}\`\n- **model**: \`${spec.model}\`\n- **delegation**: Call \`larva_subagent\` with \`persona_id: "${spec.id}"\`.\n`,
        }] };
        break;
      }
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
