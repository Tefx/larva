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
  let inlineExpanded = false, mobileView = 'list', listFilter = 'All';
  const tabs = new Map(), expandedTools = new Set(), inspectedOutputs = new Map(), controlCounts = new Map();
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
    if (context?.safeAreaInsets) for (const side of ['top', 'right', 'bottom', 'left']) document.documentElement.style.setProperty(`--safe-${side}`, `${context.safeAreaInsets[side] ?? 0}px`);
    if (['light', 'dark'].includes(context?.theme)) document.documentElement.dataset.theme = context.theme;
    if (context?.displayMode) mode = context.displayMode;
    document.documentElement.dataset.mode = mode;
    render();
  }
  function accept(data) {
    if (data?.persona_id) personaHint = data.persona_id;
    if (data?.runs) {
      const outputs = { ...state.terminal_outputs, ...data.terminal_outputs };
      for (const run of data.runs) if (isActive(run)) delete outputs[run.task_id];
      state = { ...state, ...data, error: data.error, terminal_outputs: outputs };
    }
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
    const occurrence = controlCounts.get(text) ?? 0; controlCounts.set(text, occurrence + 1);
    node.dataset.focusKey = `${text}:${occurrence}`;
    node.onclick = async () => {
      node.disabled = true;
      try { await action(); } catch (error) { showError(error); }
      finally { node.disabled = false; }
    };
    return node;
  }
  function showError(error) { document.getElementById('error').textContent = error.message ?? String(error); }
  const isActive = run => ['accepted', 'running'].includes(run.status);
  const phase = run => ({ starting: 'Starting', session_ready: 'Session ready', prompt_sent: 'Prompt sent', waiting_for_child: 'Working', stall_suspected: 'Stall suspected', success: 'Completed', failed: 'Failed', cancelled: 'Cancelled' }[run.phase] ?? 'Starting');
  const model = run => `${(run.startup_model ?? 'Route pending').replace(/^openai\//, '')} · ${run.startup_thinking ?? 'default'}`;
  const resultText = run => state.terminal_outputs?.[run.task_id]?.result_text ?? run.result_preview ?? run.error?.message ?? 'No terminal output yet.';
  const preview = run => (isActive(run) ? run.active_tool ? `Active tool: ${run.active_tool.name}` : run.live_thinking ? 'Thinking…' : run.live_assistant_preview?.trim().split('\n').at(-1) || run.task_preview : state.terminal_outputs?.[run.task_id]?.result_text ?? run.result_preview ?? run.error?.message ?? run.task_preview) ?? '';
  function duration(ms) {
    const seconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    return `${Math.floor(seconds / 3600)}h ${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}m`;
  }
  function elapsed(run, parent) {
    const node = element('span', duration(run.elapsed_ms), parent); node.className = 'elapsed';
    node.dataset.started = run.started_at ?? ''; node.dataset.elapsed = String(run.elapsed_ms ?? 0); node.dataset.active = String(isActive(run));
  }
  function status(run, parent) {
    const node = element('span', undefined, parent);
    node.className = 'status'; node.dataset.status = run.status; node.title = phase(run);
    node.setAttribute('aria-label', phase(run));
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({ width: '14', height: '14', viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', run.status === 'success' ? 'M3 8l3 3 7-7' : run.status === 'failed' ? 'M4 4l8 8M12 4l-8 8' : 'M8 2a6 6 0 1 0 6 6');
    svg.append(path); node.append(svg);
  }
  function displayButton(parent) {
    button(mode === 'inline' ? 'Fullscreen' : 'Inline', async () => {
      const requested = mode === 'inline' ? 'fullscreen' : 'inline';
      const response = await rpc('ui/request-display-mode', { mode: requested });
      mode = response.mode ?? mode; render();
    }, parent).dataset.focusKey = 'display-mode';
  }
  function cancel(run, parent) {
    if (isActive(run)) button('Cancel', async () => {
      await tool('larva_subagent_cancel', { task_id: run.task_id, reason: 'Cancelled from activity panel' }); await refresh();
    }, parent).className = 'cancel';
  }
  function disclosure(parent) {
    const control = button(inlineExpanded ? 'Hide details' : 'Details', () => {
      inlineExpanded = !inlineExpanded; render();
      notify('ui/notifications/size-changed', { height: document.documentElement.scrollHeight });
    }, parent);
    control.dataset.focusKey = 'details';
    control.setAttribute('aria-expanded', String(inlineExpanded));
  }
  function copy(text, parent) {
    button('Copy', async () => {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable in this host.');
      await navigator.clipboard.writeText(text);
    }, parent);
  }
  function runCard(run, parent) {
    const card = button('', () => {
      selected = run.task_id; inlineExpanded = true; mobileView = 'detail'; render();
      if (mode === 'inline') notify('ui/notifications/size-changed', { height: document.documentElement.scrollHeight });
      else if (window.matchMedia('(max-width:619px)').matches) Array.from(document.querySelectorAll('button')).find(node => node.className === 'back')?.focus();
    }, parent);
    card.className = 'run-card'; card.dataset.focusKey = `run:${run.task_id}`; card.setAttribute('aria-pressed', String(selected === run.task_id));
    const top = element('div', undefined, card); top.className = 'row';
    status(run, top); element('strong', run.persona_id, top); elapsed(run, top);
    const meta = element('div', undefined, card); meta.className = 'row muted';
    element('span', model(run), meta); element('span', phase(run), meta);
    if (run.tool_snapshots?.length) element('span', `${run.tool_snapshots.length} tools`, meta).className = 'badge';
    element('div', preview(run).replace(/\s+/g, ' '), card).className = 'preview';
  }
  function inspector(run, parent) {
    const tab = tabs.get(run.task_id) ?? (isActive(run) || run.tool_snapshots?.length ? 'Timeline' : 'Result');
    const bar = element('div', undefined, parent); bar.className = 'tabs'; bar.setAttribute('aria-label', 'Run details');
    for (const name of ['Timeline', 'Result', 'Task & Session']) {
      const control = button(name, () => { tabs.set(run.task_id, name); render(); }, bar);
      control.setAttribute('aria-pressed', String(name === tab));
    }
    const body = element('div', undefined, parent); body.className = 'tab-body';
    if (tab === 'Timeline') {
      if (isActive(run)) element('p', run.active_tool ? `Active tool: ${run.active_tool.name}` : run.live_thinking ? 'Thinking…' : phase(run), body).className = 'activity';
      if (run.live_assistant_preview) {
        const stream = element('pre', run.live_assistant_preview, body); stream.className = 'stream'; stream.dataset.scrollKey = `stream:${run.task_id}`;
      }
      element('h3', 'Tool calls', body);
      if (!run.tool_snapshots?.length) element('p', 'No tool calls yet.', body).className = 'muted';
      const calls = element('ol', undefined, body);
      for (const call of run.tool_snapshots ?? []) {
        const key = run.task_id + ':' + call.toolCallId, open = expandedTools.has(key);
        const item = element('li', undefined, calls);
        const control = button('', () => { open ? expandedTools.delete(key) : expandedTools.add(key); render(); }, item);
        control.className = 'tool-row'; control.dataset.focusKey = `tool:${key}`; control.setAttribute('aria-expanded', String(open));
        element('strong', call.name ?? call.toolCallId, control);
        element('span', call.status, control).className = 'badge';
        element('span', call.args_preview ?? '', control).className = 'preview';
        if (!open) continue;
        const content = element('div', undefined, item); content.className = 'tool-content';
        for (const [label, text] of [['Arguments', call.args_preview], ['Output', call.output_preview], ['Error', call.error_preview]]) {
          if (text) { element('h4', label, content); element('pre', text, content); }
        }
        const inspected = element('pre', inspectedOutputs.get(key) ?? '', content); inspected.setAttribute('aria-live', 'polite');
        inspected.dataset.scrollKey = `inspection:${key}`;
        for (const part of ['args', 'result']) button(`Inspect ${part}`, async () => {
          const data = await tool('larva_subagent_activity', { task_id: run.task_id, tool_call_id: call.toolCallId, segment_part: part });
          inspectedOutputs.set(key, JSON.stringify(data, null, 2)); render();
        }, content);
      }
    } else if (tab === 'Result') {
      const text = resultText(run); copy(text, body);
      const output = element('pre', text, body); output.className = 'result'; output.dataset.scrollKey = `result:${run.task_id}`;
    } else {
      element('h3', 'Task', body); element('pre', run.task_preview ?? '', body);
      const grid = element('dl', undefined, body); grid.className = 'metadata';
      for (const [label, value] of [
        ['Persona', run.persona_id], ['Status', run.status], ['Phase', phase(run)], ['Model', run.startup_model],
        ['Requested Thinking', run.requested_thinking], [mode === 'inline' ? 'Thinking' : 'Effective Thinking', run.startup_thinking],
        ['Elapsed', duration(run.elapsed_ms)], ['Started', run.started_at], ['Updated', run.updated_at],
        [mode === 'inline' ? 'Session Path' : 'Session ID', run.task_id],
      ]) { element('dt', label, grid); element('dd', value ?? '—', grid); }
      copy(run.task_id, body);
    }
  }
  function render() {
    const focused = document.activeElement?.dataset?.focusKey;
    const scrollPositions = new Map(Array.from(document.querySelectorAll('[data-scroll-key]')).map(node => [node.dataset.scrollKey, node.scrollTop]));
    controlCounts.clear(); renderContent();
    for (const node of document.querySelectorAll('[data-scroll-key]')) if (scrollPositions.has(node.dataset.scrollKey)) node.scrollTop = scrollPositions.get(node.dataset.scrollKey);
    if (focused) Array.from(document.querySelectorAll('button')).find(node => node.dataset.focusKey === focused)?.focus({ preventScroll: true });
  }
  function renderContent() {
    root.replaceChildren(); document.documentElement.dataset.mode = mode; root.dataset.mobileView = mobileView;
    const runs = state.runs ?? [], active = runs.filter(isActive), done = runs.filter(run => !isActive(run));
    const run = runs.find(item => item.task_id === selected) ?? runs.find(item => item.persona_id === personaHint) ?? runs[0];
    if (run) selected = run.task_id;
    const focused = filter.task_id || runs.length === 1 || runs.some(item => item.persona_id === personaHint);
    const header = element('header'); header.className = 'toolbar';
    if (mode === 'inline' && focused && run) {
      status(run, header); element('strong', run.persona_id, header);
      element('span', model(run), header).className = 'model';
      if (run.tool_snapshots?.length) element('span', `${run.tool_snapshots.length} tools`, header).className = 'badge';
      elapsed(run, header); cancel(run, header); disclosure(header); displayButton(header);
      element('div', preview(run).replace(/\s+/g, ' ')).className = 'preview summary';
    } else {
      element('strong', mode === 'inline' ? `Larva Subagents · ${active.length} active · ${done.length} done` : 'Larva Subagents', header);
      if (mode !== 'inline') for (const [name, label] of [['All', 'All'], ['Active', `Active · ${active.length}`], ['Done', `Done · ${done.length}`]]) {
        const control = button(label, () => { listFilter = name; render(); }, header); control.setAttribute('aria-pressed', String(listFilter === name));
      }
      button('Refresh', refresh, header); displayButton(header);
      if (mode === 'inline' && inlineExpanded) disclosure(header);
    }
    const error = element('div', state.error?.message ?? ''); error.id = 'error'; error.setAttribute('role', 'alert');
    if (mode === 'inline') {
      if (!run) { element('p', personaHint ? `Waiting for ${personaHint}…` : 'No recent subagent runs.'); return; }
      if (!focused || (inlineExpanded && runs.length > 1)) {
        const list = element('nav'); list.className = inlineExpanded ? 'switcher' : 'compact-list'; list.setAttribute('aria-label', 'Subagent runs');
        for (const item of runs) runCard(item, list);
      }
      if (inlineExpanded) { const drawer = element('section'); drawer.className = 'drawer'; inspector(run, drawer); }
    } else {
      const layout = element('main'); layout.className = 'workbench';
      const list = element('nav', undefined, layout); list.className = 'run-list'; list.dataset.scrollKey = 'runs'; list.setAttribute('aria-label', 'Subagent runs');
      for (const [name, group] of [['Active', active], ['Done', done]]) {
        if (listFilter !== 'All' && listFilter !== name) continue;
        element('h3', `${name} · ${group.length}`, list);
        if (!group.length) element('p', name === 'Active' ? 'No active subagents' : 'No completed subagents', list).className = 'muted';
        for (const item of group) runCard(item, list);
      }
      const detail = element('section', undefined, layout); detail.className = 'inspector'; detail.dataset.scrollKey = `detail:${run?.task_id ?? ''}`;
      button('← Back to subagents', () => {
        mobileView = 'list'; render();
        Array.from(document.querySelectorAll('button')).find(node => node.dataset.focusKey === `run:${selected}`)?.focus();
      }, detail).className = 'back';
      if (!run) { element('p', 'Select a subagent to view activity.', detail); return; }
      const heading = element('div', undefined, detail); heading.className = 'row detail-header';
      element('h2', run.persona_id, heading); element('span', run.status, heading).className = 'badge';
      element('span', model(run), heading).className = 'muted'; element('span', phase(run), heading); elapsed(run, heading); cancel(run, heading);
      inspector(run, detail);
    }
    tick();
  }
  function tick() {
    for (const node of document.querySelectorAll('[data-started]')) {
      const live = node.dataset.active === 'true' && Number.isFinite(Date.parse(node.dataset.started));
      node.textContent = duration(live ? Date.now() - Date.parse(node.dataset.started) : node.dataset.elapsed);
    }
  }
  async function refresh() {
    if (stopped || polling || document.visibilityState === 'hidden') return;
    polling = true;
    try { accept(await tool('larva_subagent_panel', filter)); }
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
  :root{color-scheme:light dark;--background:var(--color-background-primary,light-dark(#ffffff,#181818));--foreground:var(--color-text-primary,light-dark(#1a1c1f,#ffffff));--secondary:var(--color-background-secondary,light-dark(rgba(255,255,255,.96),rgba(54,54,54,.96)));--tertiary:var(--color-background-tertiary,color-mix(in srgb,var(--foreground) 4%,var(--background)));--card:color-mix(in srgb,var(--foreground) 5%,var(--background));--muted:color-mix(in srgb,var(--foreground) 8%,transparent);--muted-foreground:var(--color-text-secondary,light-dark(rgba(26,28,31,.55),rgba(255,255,255,.55)));--border:var(--color-border-secondary,light-dark(rgba(26,28,31,.09),rgba(255,255,255,.09)));--input:var(--color-border-primary,light-dark(rgba(26,28,31,.13),rgba(255,255,255,.13)));--primary:var(--color-text-info,light-dark(#339cff,#83c3ff));--accent:var(--color-background-info,color-mix(in srgb,var(--primary) 14%,transparent));--success:var(--color-text-success,light-dark(#16a34a,#4ade80));--success-bg:var(--color-background-success,color-mix(in srgb,var(--success) 14%,transparent));--warning:var(--color-text-warning,light-dark(#d97706,#fbbf24));--warning-bg:var(--color-background-warning,color-mix(in srgb,var(--warning) 14%,transparent));--danger:var(--color-text-danger,light-dark(#dc2626,#f87171));--danger-bg:var(--color-background-danger,color-mix(in srgb,var(--danger) 14%,transparent));--ring:var(--color-ring-primary,var(--primary));--radius-sm:var(--border-radius-sm,6px);--radius-md:var(--border-radius-md,8px);--radius-lg:var(--border-radius-lg,12px);--app-font-sans:var(--font-sans,-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif);--app-font-mono:var(--font-mono,ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace);font:13px/1.5 var(--app-font-sans);color:var(--foreground);background:var(--background)}
  /* App font aliases preserve host tokens without self-referential custom properties. */
  .run-list{min-width:0}.run-card strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.toolbar>strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .status svg{display:block}.status[data-status=running]{animation:pulse 2s ease-in-out infinite}@keyframes pulse{50%{opacity:.45}}@media(prefers-reduced-motion:reduce){.status[data-status=running]{animation:none}}
  [data-theme=light]{color-scheme:light}[data-theme=dark]{color-scheme:dark}*{box-sizing:border-box}body{margin:0;padding:calc(12px + var(--safe-top,0px)) calc(12px + var(--safe-right,0px)) calc(12px + var(--safe-bottom,0px)) calc(12px + var(--safe-left,0px))}button{font:inherit;color:inherit;cursor:pointer;background:transparent;border:1px solid var(--border);border-radius:var(--radius-sm);padding:5px 9px;min-height:30px}button:hover{background:var(--muted)}button:focus-visible{outline:2px solid var(--ring);outline-offset:2px}button:disabled{opacity:.5;cursor:wait}button[aria-pressed=true]{background:var(--accent);border-color:var(--primary)}.toolbar,.row,.tabs{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.toolbar{padding-bottom:10px}.toolbar>strong{margin-right:auto}.model,.badge{border-radius:var(--radius-sm);background:var(--muted);padding:1px 6px;font-size:11px}.elapsed{font-variant-numeric:tabular-nums;white-space:nowrap;margin-left:auto;color:var(--muted-foreground)}.muted{color:var(--muted-foreground)}.preview{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.summary{color:var(--muted-foreground)}.status{color:var(--muted-foreground)}.status[data-status=running],.status[data-status=accepted]{color:var(--primary)}.status[data-status=success]{color:var(--success)}.status[data-status=failed],#error{color:var(--danger)}.status[data-status=cancelled]{color:var(--warning)}.cancel{color:var(--danger)}.workbench{display:grid;grid-template-columns:minmax(210px,32%) minmax(0,1fr);height:calc(100dvh - 90px - var(--safe-top,0px) - var(--safe-bottom,0px));min-height:280px;border-top:1px solid var(--border)}.run-list{overflow:auto;padding:12px 12px 12px 0;border-right:1px solid var(--border)}.run-card{display:block;width:100%;text-align:left;padding:10px;margin-bottom:6px;background:var(--tertiary);border-radius:var(--radius-md);overflow:hidden}.run-card .row{flex-wrap:nowrap}.run-card .row>span:not(.elapsed){overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.run-card .preview{color:var(--muted-foreground);margin-top:4px}.inspector{overflow:auto;padding:16px;min-width:0}.detail-header{margin-bottom:16px}h2{font-size:17px;margin:0}h3{font-size:12px;margin:14px 0 8px}h4{font-size:11px;color:var(--muted-foreground);margin:10px 0 4px}.tabs{border-bottom:1px solid var(--border);padding-bottom:8px;position:sticky;top:0;background:var(--background);z-index:1}.tabs button{flex:1;white-space:nowrap}.tab-body{padding-top:12px;min-width:0}pre{font:12px/1.6 var(--app-font-mono);white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto;margin:6px 0 12px}.stream,.result{padding:12px;border:1px solid var(--border);border-radius:var(--radius-md);background:var(--tertiary)}.stream{max-height:160px}.activity{color:var(--primary);background:var(--accent);border-radius:var(--radius-sm);padding:8px}.drawer{margin-top:12px;padding:12px;border:1px solid var(--border);border-radius:var(--radius-lg);background:var(--secondary)}[data-mode=inline] .result{max-height:220px}ol{list-style:none;padding:0;margin:0}li{border:1px solid var(--border);border-radius:var(--radius-md);margin:6px 0;overflow:hidden}.tool-row{display:flex;align-items:center;gap:8px;width:100%;text-align:left;border:0}.tool-row .preview{flex:1;color:var(--muted-foreground)}.tool-content{padding:0 12px 12px}.tool-content pre{max-height:260px}.metadata{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:8px 16px}.metadata dt{color:var(--muted-foreground)}.metadata dd{margin:0;overflow-wrap:anywhere}.back{display:none}.compact-list .run-card .row.muted{display:none}.compact-list .run-card{display:flex;gap:12px;padding:6px}.compact-list .run-card>.row{flex-shrink:0}.switcher{display:flex;gap:6px;overflow:auto;margin-top:8px}.switcher .run-card{min-width:180px}#error:empty{display:none}@media(max-width:619px){.workbench{grid-template-columns:1fr}.run-list{border-right:0}.back{display:block;margin-bottom:12px}[data-mobile-view=list] .inspector,[data-mobile-view=detail] .run-list{display:none}.toolbar{gap:6px}.metadata{grid-template-columns:1fr;gap:2px}.metadata dd{margin-bottom:8px}}
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
