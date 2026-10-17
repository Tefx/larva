// purpose: exercise the external stdio host through real runtime admission, RPC, and cleanup
// usage: node contrib/pi-extension/test-subagent-mcp-server.mjs
// effects: isolated fixture processes, sessions and capsules; removed in finally
// requires: Node with native TypeScript support and locked extension dependencies
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { existsSync, realpathSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { runInNewContext } from 'node:vm';

const packageDir = dirname(fileURLToPath(import.meta.url));
const root = realpathSync(await mkdtemp(join(tmpdir(), 'larva-mcp-')));
const clients = [];
const env = { ...process.env, HOME: root, PI_CODING_AGENT_DIR: join(root, 'base-agent'), LARVA_PI_CHILD_SESSION_DIR: join(root, 'sessions'), LARVA_PI_CHILD_RPC_LEGACY_FALLBACK: '1', LARVA_PI_CHILD_RPC_TRACE_FILE: join(root, 'trace.jsonl') };
for (const key of Object.keys(env)) if (key.startsWith('LARVA_') && !['LARVA_PI_CHILD_SESSION_DIR', 'LARVA_PI_CHILD_RPC_LEGACY_FALLBACK', 'LARVA_PI_CHILD_RPC_TRACE_FILE'].includes(key)) delete env[key];
function client(overrides = {}, runtimeDir = packageDir) {
  const child = spawn(process.execPath, [join(runtimeDir, 'subagent-mcp-server.mjs')], { env: { ...env, ...overrides }, stdio: ['pipe', 'pipe', 'pipe'] });
  let sequence = 0, buffer = Buffer.alloc(0), stderr = '';
  const pending = new Map();
  child.stderr.on('data', data => { stderr += data; });
  child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length) {
      let body;
      if (buffer.toString('ascii', 0, 15).startsWith('Content-Length:')) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const length = Number(/Content-Length: (\d+)/.exec(buffer.subarray(0, end).toString())[1]);
        if (buffer.length < end + 4 + length) return;
        body = buffer.subarray(end + 4, end + 4 + length).toString();
        buffer = buffer.subarray(end + 4 + length);
      } else {
        const end = buffer.indexOf(10);
        if (end < 0) return;
        body = buffer.subarray(0, end).toString(); buffer = buffer.subarray(end + 1);
      }
      const message = JSON.parse(body);
      const waiter = pending.get(message.id);
      if (waiter) { pending.delete(message.id); waiter.resolve(message); }
    }
  });
  child.on('exit', () => { for (const waiter of pending.values()) waiter.reject(new Error(`server exited: ${stderr}`)); pending.clear(); });
  const api = {
    child,
    get stderr() { return stderr; },
    request(method, params = {}, framed = false, id = ++sequence) {
      const responseId = typeof id === 'string' || typeof id === 'number' ? id : null;
      const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      const result = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(responseId); reject(new Error(`Timed out: ${method}; ${stderr}`)); }, 30000);
        pending.set(responseId, { resolve(value) { clearTimeout(timer); resolve(value); }, reject(error) { clearTimeout(timer); reject(error); } });
      });
      const data = framed ? `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}` : body + '\n';
      child.stdin.write(data);
      return result;
    },
    async tool(name, args = {}) {
      const response = await this.request('tools/call', { name, arguments: args });
      assert.equal(response.error, undefined, JSON.stringify(response));
      return response.result;
    },
    async close(signal) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      if (signal) child.kill(signal); else child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
      try { const [code] = await exited; assert.equal(code, 0, stderr); }
      finally { clearTimeout(timer); }
    },
  };
  clients.push(api);
  return api;
}
// Execute the shipped resource script against a controlled parent bridge and
// minimal DOM, without replacing any of the app's request or rendering logic.
async function exercisePanelBridge(html, surface, multiple = false) {
  const sent = [], listeners = {}, timers = new Map(), variables = {};
  let timerId = 0, disconnected = false, narrow = false;
  const node = tag => {
    const value = { tag, dataset: {}, children: [], textContent: '', attributes: {}, scrollTop: 0,
      setAttribute(key, value) { this.attributes[key] = value; },
      getAttribute(key) { return this.attributes[key]; },
      focus() { document.activeElement = this; },
      append(child) { this.children.push(child); },
      replaceChildren() { this.children = []; },
    };
    return value;
  };
  const app = node('div'); app.id = 'app';
  const visibleNodes = () => {
    const result = [];
    const walk = parent => { result.push(parent); for (const child of parent.children) walk(child); };
    walk(app); return result;
  };
  const document = {
    visibilityState: 'visible',
    documentElement: { dataset: {}, scrollHeight: 320, style: { setProperty(key, value) { variables[key] = value; } } },
    createElement: node,
    createElementNS: (_, tag) => node(tag),
    getElementById: id => visibleNodes().find(value => value.id === id),
    querySelectorAll: selector => visibleNodes().filter(value => selector === 'button' ? value.tag === 'button' : selector === '[data-scroll-key]' ? value.dataset.scrollKey !== undefined : value.dataset.started !== undefined),
    addEventListener(name, callback) { listeners[name] = callback; },
  };
  const run = { task_id: '/fixture/child.jsonl', persona_id: 'child', status: 'running', phase: 'waiting_for_child', result_pending: true, started_at: new Date().toISOString(), elapsed_ms: 100, startup_model: 'fixture/model', startup_thinking: 'high', task_preview: 'fixture task', live_assistant_preview: '<script>literal text</script>', active_tool: { name: 'read' }, tool_snapshots: [{ toolCallId: 'call-1', name: 'read', status: 'running', args_preview: 'fixture' }] };
  const deliver = message => listeners.message({ source: window.parent, data: { jsonrpc: '2.0', ...message } });
  const window = { matchMedia() { return { matches: narrow }; }, addEventListener(name, callback) { listeners[name] = callback; }, parent: {
    postMessage(message) {
      sent.push(JSON.parse(JSON.stringify(message)));
      if (!message.id || message.method === undefined) return;
      let result = {};
      if (message.method === 'ui/initialize') result = { hostContext: { theme: 'dark', safeAreaInsets: { top: 8, bottom: 12 }, styles: { variables: { '--color-text-primary': 'red' } } } };
      if (message.method === 'ui/request-display-mode') result = { mode: message.params.mode };
      if (message.method === 'tools/call') result = { structuredContent: message.params.name === 'larva_subagent_panel' ? { runs: multiple && !message.params.arguments.task_id ? [run, { ...run, task_id: '/fixture/done.jsonl', persona_id: 'finished-child', status: 'success', phase: 'success', result_pending: false }] : [run], terminal_outputs: {} } : { expanded: 'fixture segment' } };
      queueMicrotask(() => deliver({ id: message.id, result }));
    },
  } };
  const schedule = callback => { const id = ++timerId; timers.set(id, callback); return id; };
  let resize, copied;
  runInNewContext(html.match(/<script>([\s\S]*)<\/script>/)[1], {
    window, document, navigator: { clipboard: { async writeText(text) { copied = text; } } }, setTimeout: schedule, clearTimeout: id => timers.delete(id),
    setInterval: schedule, clearInterval: id => timers.delete(id),
    ResizeObserver: class { constructor(callback) { resize = callback; } observe() {} disconnect() { disconnected = true; } },
  });
  const flush = async () => { for (let index = 0; index < 15; index++) await Promise.resolve(); };
  await flush();
  assert.equal(sent[0].method, 'ui/initialize');
  assert.equal(sent[0].params.protocolVersion, '2026-01-26');
  assert.deepEqual(sent[0].params.appInfo, { name: 'Larva Subagents', version: '0.8.9' });
  assert.ok(sent.some(message => message.method === 'ui/notifications/initialized'));
  assert.equal(variables['--color-text-primary'], 'red');
  assert.equal(document.documentElement.dataset.theme, 'dark');
  const hasText = text => visibleNodes().some(value => value.textContent === text);
  const click = async text => { const target = visibleNodes().find(value => value.tag === 'button' && value.textContent === text); assert.ok(target, text); target.focus(); await target.onclick(); await flush(); };
  assert.equal(variables['--safe-top'], '8px');
  assert.equal(document.documentElement.dataset.mode, surface === 'widget' ? 'inline' : 'fullscreen');
  if (surface === 'widget') {
    assert.ok(hasText('child'));
    assert.ok(hasText('fixture/model · high'));
    assert.ok(hasText('Active tool: read'));
    assert.ok(!hasText('Timeline'));
    assert.ok(!hasText('Inspect args'));
    assert.ok(!hasText(run.live_assistant_preview));
    assert.ok(!visibleNodes().some(value => ['result', 'tool-row', 'drawer'].includes(value.className)));
    if (multiple) {
      assert.ok(hasText('Larva Subagents · 1 active · 1 done'));
      const card = visibleNodes().find(value => value.className === 'run-card');
      await card.onclick(); await flush();
    } else {
      assert.equal(visibleNodes().find(value => value.textContent === 'Details').getAttribute('aria-expanded'), 'false');
      await click('Details');
      assert.equal(document.activeElement.textContent, 'Hide details');
    }
    assert.ok(sent.some(message => message.method === 'ui/notifications/size-changed'));
  } else {
    assert.ok(hasText('Active · 1')); assert.ok(hasText('Done · 0'));
    assert.ok(!hasText('Details'));
  }
  for (const tab of ['Timeline', 'Result', 'Task & Session']) assert.ok(hasText(tab));
  assert.ok(hasText(run.live_assistant_preview));
  assert.ok(!hasText('Inspect args'));
  const expandTool = async () => { const target = visibleNodes().find(value => value.className === 'tool-row'); assert.ok(target); await target.onclick(); await flush(); };
  await expandTool();
  assert.ok(hasText('Inspect args'));
  deliver({ method: 'ui/notifications/host-context-changed', params: { theme: 'light' } });
  assert.equal(document.documentElement.dataset.theme, 'light');
  deliver({ method: 'ui/notifications/tool-input', params: { arguments: { task_id: run.task_id, persona_id: 'child' } } });
  await flush();
  assert.deepEqual(sent.filter(message => message.params?.name === 'larva_subagent_panel').at(-1).params.arguments, { task_id: run.task_id });
  await click('Inspect args');
  assert.deepEqual(sent.filter(message => message.params?.name === 'larva_subagent_activity').at(-1).params.arguments, { task_id: run.task_id, tool_call_id: 'call-1', segment_part: 'args' });
  assert.ok(visibleNodes().some(value => value.textContent.includes('fixture segment')));
  await click('Inspect result');
  assert.equal(sent.filter(message => message.params?.name === 'larva_subagent_activity').at(-1).params.arguments.segment_part, 'result');
  await click('Cancel');
  assert.equal(sent.filter(message => message.params?.name === 'larva_subagent_cancel').at(-1).params.arguments.task_id, run.task_id);
  assert.ok(visibleNodes().some(value => value.textContent.includes('fixture segment')), 'inspection survives polling rerenders');
  if (surface === 'widget') {
    resize();
    assert.equal(sent.at(-1).method, 'ui/notifications/size-changed');
    await click('Fullscreen');
    assert.deepEqual(sent.find(message => message.method === 'ui/request-display-mode').params, { mode: 'fullscreen' });
  }
  assert.ok(hasText('Active · 1')); assert.ok(hasText('Done · 0'));
  await click('Done · 0');
  assert.ok(!visibleNodes().some(value => value.tag === 'h3' && value.textContent === 'Active · 1'));
  assert.ok(hasText('No completed subagents'));
  await click('All');
  narrow = true;
  const selectedCard = visibleNodes().find(value => value.className === 'run-card');
  selectedCard.focus(); await selectedCard.onclick(); await flush();
  assert.equal(app.dataset.mobileView, 'detail'); assert.equal(document.activeElement.className, 'back');
  await click('← Back to subagents');
  assert.equal(app.dataset.mobileView, 'list'); assert.equal(document.activeElement.dataset.focusKey, `run:${run.task_id}`);
  narrow = false;
  visibleNodes().find(value => value.className === 'inspector').scrollTop = 48;
  await click('Refresh');
  assert.equal(visibleNodes().find(value => value.className === 'inspector').scrollTop, 48);
  const before = sent.length;
  document.visibilityState = 'hidden'; await click('Refresh');
  assert.equal(sent.length, before);
  document.visibilityState = 'visible';
  await click('Result');
  run.result_pending = false; run.status = 'success'; run.result_preview = 'finished';
  deliver({ method: 'ui/notifications/tool-result', params: { structuredContent: { runs: [run], terminal_outputs: { [run.task_id]: { result_text: 'terminal output' } } } } });
  assert.ok(hasText('terminal output'));
  await flush();
  assert.ok(hasText('terminal output'), 'terminal output survives refresh without cached output');
  await click('Copy'); assert.equal(copied, 'terminal output');
  await click('Task & Session'); assert.ok(hasText('/fixture/child.jsonl')); assert.ok(hasText('fixture/model'));
  assert.equal(document.activeElement.textContent, 'Task & Session');
  assert.ok(visibleNodes().includes(document.activeElement), 'rerenders preserve keyboard focus');
  for (const [ms, formatted] of [[14000, '14s'], [84000, '1m 24s'], [3720000, '1h 02m']]) {
    run.elapsed_ms = ms;
    deliver({ method: 'ui/notifications/tool-result', params: { structuredContent: { runs: [run] } } });
    assert.ok(hasText(formatted)); await flush();
  }
  run.status = 'running'; run.result_pending = true; run.result_preview = null; run.startup_model = 'openai/gpt-6.1-sol';
  deliver({ method: 'ui/notifications/tool-result', params: { structuredContent: { runs: [run] } } });
  await flush();
  assert.ok(hasText('gpt-6.1-sol · high')); assert.ok(hasText('openai/gpt-6.1-sol'));
  await click('Result');
  assert.ok(!hasText('terminal output'), 'resumed run drops prior terminal output');
  assert.ok(hasText('No terminal output yet.'));
  await click('Inline');
  if (surface === 'widget') { await click('Hide details'); assert.ok(!hasText('Timeline')); assert.ok(!hasText('Inspect args')); }
  document.visibilityState = 'hidden';
  deliver({ method: 'ui/notifications/tool-result', params: { structuredContent: { runs: [] } } });
  assert.ok(hasText('Waiting for child…'));
  await click('Fullscreen');
  assert.ok(hasText('Active · 0')); assert.ok(hasText('Done · 0')); assert.ok(hasText('No active subagents'));
  deliver({ id: 999, method: 'ui/resource-teardown', params: {} });
  assert.deepEqual(sent.at(-1), { jsonrpc: '2.0', id: 999, result: {} });
  assert.equal(disconnected, true);
  assert.equal(timers.size, 0);
}
async function pidEntries() {
  const files = (await readdir(root)).filter(file => file.startsWith('pid-'));
  return await Promise.all(files.map(async file => JSON.parse(await readFile(join(root, file), 'utf8'))));
}
async function assertReaped() {
  for (const entry of await pidEntries()) {
    assert.throws(() => process.kill(entry.pid, 0), { code: 'ESRCH' });
    assert.equal(existsSync(entry.capsule), false, entry.capsule);
  }
}
try {
  // Discovery and rejected calls must work even without the runtime or dependencies.
  const idleDir = join(root, 'server-only');
  await mkdir(idleDir);
  await cp(join(packageDir, 'subagent-mcp-server.mjs'), join(idleDir, 'subagent-mcp-server.mjs'));
  assert.deepEqual(await readdir(idleDir), ['subagent-mcp-server.mjs']);
  const idle = client({}, idleDir);
  const initialized = (await idle.request('initialize')).result;
  assert.deepEqual(initialized.serverInfo, { name: 'larva-pi-subagent', title: 'Larva Subagents', version: '0.8.9' });
  assert.deepEqual(initialized.capabilities, {
    tools: {}, resources: {},
    extensions: { 'openai/mentions': { searchTool: 'search_mentions' } },
    experimental: { 'openai/mentions': { searchTool: 'search_mentions' } },
  });
  assert.equal(initialized.instructions, 'When the user mentions @larva:<persona_id>, @persona:<persona_id>, or a larva://personas/<persona_id> resource (including [@larva:<persona_id>](mcp-resource://...)), delegate the requested task to larva_subagent with persona_id="<persona_id>" and wait_for_completion=true (or false for parallel fan-out). When @Larva Subagents is mentioned without an exact persona_id, call larva_personas first.');
  assert.ok(initialized.instructions.length < 512);
  for (const protocolVersion of ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25', '2026-07-28', 'unsupported']) {
    assert.equal((await idle.request('initialize', { protocolVersion })).result.protocolVersion, protocolVersion === 'unsupported' ? '2024-11-05' : protocolVersion);
  }
  assert.deepEqual((await idle.request('resources/templates/list')).result, {
    resourceTemplates: [{ uriTemplate: 'larva://personas/{persona_id}', name: 'larva-persona', title: 'Larva Persona', description: 'Resolved Larva persona metadata and delegation guidance.', mimeType: 'text/markdown' }],
  });
  for (const uri of [undefined, 42, 'https://example.com/child', 'larva://personas/', 'larva://personas/child?x', 'larva://personas/%ZZ']) {
    assert.deepEqual((await idle.request('resources/read', { uri })).error, { code: -32602, message: 'Invalid persona resource URI.' });
  }
  idle.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  assert.deepEqual((await idle.request('ping')).result, {});
  const listedTools = (await idle.request('tools/list')).result.tools;
  assert.equal(listedTools.length, 11);
  const panelTool = listedTools.find(tool => tool.name === 'larva_subagent_panel');
  assert.deepEqual(panelTool._meta, { ui: { resourceUri: 'ui://larva-pi-subagent/panel', visibility: ['app'] }, 'openai/ui': { entrypoints: [{ type: 'thread' }] } });
  for (const surface of ['panel', 'widget']) {
    const uri = 'ui://larva-pi-subagent/' + surface;
    const resource = (await idle.request('resources/read', { uri })).result.contents[0];
    assert.equal(resource.mimeType, 'text/html;profile=mcp-app');
    assert.equal(resource._meta.ui.prefersBorder, true);
    assert.deepEqual(resource._meta['openai/ui'], {
      preferredDisplayMode: surface === 'panel' ? 'fullscreen' : 'inline',
      availableDisplayModes: surface === 'panel' ? ['fullscreen', 'inline'] : ['inline', 'fullscreen'],
    });
    for (const method of ['ui/initialize', 'ui/notifications/initialized', 'larva_subagent_panel', 'larva_subagent_activity', 'larva_subagent_cancel']) assert.ok(resource.text.includes(method));
    await exercisePanelBridge(resource.text, surface);
    if (surface === 'widget') await exercisePanelBridge(resource.text, surface, true);
    assert.ok(resource.text.includes("connect-src 'none'"));
    assert.ok(!/<(?:script|link|img)[^>]+(?:src|href)=/i.test(resource.text));
  }
  const mentionsTool = listedTools[9];
  assert.equal(mentionsTool.name, 'search_mentions');
  assert.deepEqual(mentionsTool.annotations, { readOnlyHint: true, destructiveHint: false, openWorldHint: false });
  assert.deepEqual(mentionsTool._meta, { 'openai/extensions': { 'mentions/search': {} }, ui: { visibility: ['app'] } });
  for (const args of [{}, { query: 1 }, { query: '', extra: true }]) {
    assert.equal((await idle.tool('search_mentions', args)).isError, true);
  }
  for (const [id, framed] of [[{}, false], [[], true]]) {
    assert.deepEqual(await idle.request('ping', {}, framed, id), {
      jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' },
    });
  }
  const nullArguments = await idle.request('tools/call', { name: 'larva_subagent_sessions', arguments: null });
  assert.equal(nullArguments.result.isError, true);
  assert.deepEqual(nullArguments.result.details.error, { code: 'LARVA_BAD_INPUT', message: 'arguments must be an object.' });
  assert.equal(nullArguments.result.content[0].text, 'LARVA_BAD_INPUT: arguments must be an object.');
  const unknown = await idle.request('tools/call', { name: 'unknown', arguments: {} });
  assert.equal(unknown.error.code, -32602);
  for (const args of [[], { task: 'missing persona' }, { persona_id: 'child', task: 'run', unknown: true }, { persona_id: 'child', task: 1 }]) {
    const invalid = await idle.tool('larva_subagent', args);
    assert.equal(invalid.isError, true);
    assert.equal(invalid.details.error.code, 'LARVA_BAD_INPUT');
  }
  const missingRuntime = await idle.request('tools/call', { name: 'larva_subagent_sessions' });
  assert.equal(missingRuntime.error.code, -32603);
  await idle.close();
  assert.equal(idle.stderr, '');
  console.log('server-only initialize, notification, ping, tools/list, rejected calls and idle EOF: PASS');

  // Observe import and reset at the actual module boundary. Real child/capsule
  // cleanup is exercised separately below with the production runtime.
  const lifecycleFile = join(idleDir, 'lifecycle.jsonl');
  await writeFile(join(idleDir, 'larva.ts'), `
import { appendFile } from 'node:fs/promises';
const record = value => appendFile(${JSON.stringify(lifecycleFile)}, JSON.stringify(value)+'\\n');
await record('loaded');
export function larva_subagent_sessions() { return { content: [], details: { sessions: [] } }; }
export async function resetExtensionUI(reason) { await record(reason); }
`);
  const lazy = client({}, idleDir);
  await lazy.request('initialize');
  assert.equal(existsSync(lifecycleFile), false);
  const omittedArguments = await lazy.request('tools/call', { name: 'larva_subagent_sessions' });
  assert.equal(omittedArguments.error, undefined, JSON.stringify(omittedArguments));
  assert.deepEqual(omittedArguments.result.details.sessions, []);
  await Promise.all([lazy.tool('larva_subagent_sessions'), lazy.tool('larva_subagent_sessions')]);
  assert.deepEqual((await readFile(lifecycleFile, 'utf8')).trim().split('\n').map(JSON.parse), ['loaded']);
  await lazy.close();
  assert.deepEqual((await readFile(lifecycleFile, 'utf8')).trim().split('\n').map(JSON.parse), ['loaded', 'mcp_shutdown']);
  console.log('first validated call imports once; EOF awaits resetExtensionUI(mcp_shutdown): PASS');

  await mkdir(env.PI_CODING_AGENT_DIR, { recursive: true });
  await symlink(join(root, 'absent-target'), join(env.PI_CODING_AGENT_DIR, 'dangling'));
  const cli = join(root, 'larva-cli.mjs');
  await writeFile(cli, `
const command = process.argv[2], id = process.argv[3];
if (command === 'resolve' && process.env.FIXTURE_RESOLVE_GATE) {
 const {writeFile, access} = await import('node:fs/promises');
 const gate = process.env.FIXTURE_RESOLVE_GATE;
 await writeFile(gate + '.entered', '');
 while (true) {
  try { await access(gate + '.release'); break; } catch {}
  await new Promise(resolve => setTimeout(resolve, 10));
 }
}
if (id !== undefined && id !== id.trim()) throw new Error('Persona resolution received untrimmed id');
const spec = id => ({id, description: 'Fixture '+id, prompt: 'Fixture prompt', model: 'fixture/model', capabilities: {}, spec_version: '0.1.0', spec_digest: 'sha256:fixture', can_spawn: id === 'parent' ? ['child'] : id === 'deny' ? false : true});
process.stdout.write(JSON.stringify({data: command === 'list' ? [spec('child'), spec('other')] : spec(id)}));
`);
  env.LARVA_CLI_ARGV_JSON = JSON.stringify([process.execPath, cli]);
  const pkg = join(root, 'pi-package');
  await mkdir(pkg);
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', type: 'module', version: 'fixture', bin: { pi: 'cli.mjs' } }));
  const piScript = join(pkg, 'cli.mjs');
  await writeFile(piScript, `
import {createInterface} from 'node:readline';
import {writeFile, mkdir} from 'node:fs/promises';
import {join} from 'node:path';
const root = process.env.HOME;
await writeFile(join(root,'pid-'+process.pid), JSON.stringify({pid:process.pid,capsule:process.env.LARVA_PI_CAPSULE_ROOT}));
const sessionDir = process.argv[process.argv.indexOf('--session-dir')+1];
let sessionFile = join(sessionDir, 'child-'+process.pid+'.jsonl');
let large = false;
const send = message => process.stdout.write(JSON.stringify(message)+'\\n');
createInterface({input:process.stdin}).on('line', async line => {
 const m=JSON.parse(line);
 if(m.type==='get_state') {
  if (m.id === 'state-1') {
   if (process.env.FIXTURE_RPC_STARTUP === 'never') return;
   if (process.env.FIXTURE_RPC_STARTUP === 'exit') process.exit(23);
   if (process.env.FIXTURE_RPC_STARTUP === 'delayed') await new Promise(resolve => setTimeout(resolve, 10500));
  }
  await mkdir(sessionDir,{recursive:true});
  await writeFile(sessionFile, JSON.stringify({type:'session',version:3,id:'fixture-'+process.pid,cwd:root})+'\\n'+JSON.stringify({type:'message',id:'call-entry',timestamp:'2026-01-01T00:00:00Z',message:{role:'assistant',content:[{type:'toolCall',id:'call-1',name:'read',arguments:{path:'fixture'}}]}})+'\\n'+JSON.stringify({type:'message',id:'result-entry',timestamp:'2026-01-01T00:00:01Z',message:{role:'toolResult',toolCallId:'call-1',toolName:'read',content:[{type:'text',text:'fixture content'}]}})+'\\n');
  send({id:m.id,success:true,data:{sessionFile}});
 } else if(m.type==='prompt') {
  large = m.message.includes('large output');
  send({id:m.id,success:true,data:{}});
  send({type:'message_update',assistantMessageEvent:{type:'thinking_delta',delta:'hidden thought'}});
  send({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'live fixture assistant'}});
  send({type:'message_update',assistantMessageEvent:{type:'toolcall_delta',delta:'ignore tool args'}});
  send({type:'tool_execution_start',toolCallId:'call-1',toolName:'read',args:{path:'fixture'}});
  if (!m.message.includes('telemetry hang')) setTimeout(()=>send({type:'tool_execution_end',toolCallId:'call-1',toolName:'read',isError:false,result:{content:[{type:'text',text:'fixture content'}]}}),20);
  if (m.message.includes('telemetry hang')) {
   for (let i=0;i<30;i++) {
    send({type:'tool_execution_start',toolCallId:'bounded-'+i,toolName:'read',args:{index:i}});
    send({type:'tool_execution_update',toolCallId:'bounded-'+i,partialResult:{content:[{type:'text',text:'partial '+i}]}});
    send({type:'tool_execution_end',toolCallId:'bounded-'+i,isError:false,result:{content:[{type:'text',text:'done '+i}]}});
   }
   send({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'boundary assistant'}]}});
   send({type:'tool_execution_start',toolCallId:'active',toolName:'read',args:{path:'active'}});
   send({type:'message_update',assistantMessageEvent:{type:'thinking_delta',delta:'hidden'}});
  }
  if (!m.message.includes('hang')) setTimeout(()=>send({type:'agent_end'}),m.message.includes('slow')?400:50);
 } else if(m.type==='get_last_assistant_text') send({id:m.id,success:true,data:{text:large ? 'large-result-'.repeat(2000) : 'output parent='+process.env.LARVA_PI_PARENT_PERSONA_ID}});
 else if(m.type==='abort') send({id:m.id,success:true,data:{}});
 else if(m.type==='switch_session') {sessionFile=m.sessionPath;send({id:m.id,success:true,data:{}});}
});
`);
  env.LARVA_PI_CLI_SCRIPT = piScript;
  const runtime = await import('./larva.ts');
  try {
    const disabled = await runtime.larva_subagent({persona_id:'child',task:'disabled'}, {env,externalHostCanSpawn:false});
    assert.equal(disabled.error.code,'LARVA_SPAWN_NOT_ALLOWED');
    for (const parent_persona_id of [null, '', '   ', 42]) {
      const malformedParent = await runtime.larva_subagent({persona_id:'child',task:'invalid',parent_persona_id}, {env,externalHostCanSpawn:true});
      assert.deepEqual(malformedParent.error, {code:'LARVA_BAD_INPUT',message:'parent_persona_id must be a non-empty string.'});
    }
    assert.deepEqual(runtime.subagentPresentationLogForTests(), []);
    let delivered;
    const completion = new Promise(resolve => { delivered = resolve; });
    const external = await runtime.larva_subagent({persona_id:'child',task:'headless capsule'}, {
      env, externalHostCanSpawn:true, callbackSurface:{sendMessage:delivered},
    });
    assert.equal(external.status, 'accepted', JSON.stringify(external));
    const terminal = await completion;
    assert.equal(terminal.details.status, 'success');
    const telemetry = (await runtime.larva_subagent_status({task_id:external.task_id}, {env,externalHostCanSpawn:true})).details.runs[0];
    assert.equal(telemetry.task_preview, 'headless capsule');
    assert.equal(telemetry.startup_model, 'fixture/model');
    assert.equal(telemetry.live_assistant_preview, 'live fixture assistant');
    assert.equal(telemetry.live_thinking, false);
    assert.equal(telemetry.active_tool, null);
    assert.equal(telemetry.tool_snapshots[0].name, 'read');
    assert.equal(telemetry.tool_snapshots[0].args_preview, '{"path":"fixture"}');
    assert.equal(telemetry.tool_snapshots[0].status, 'success');
    assert.equal(telemetry.tool_snapshots[0].output_preview, 'fixture content');
    assert.equal(telemetry.result_preview, 'output parent=');
    telemetry.tool_snapshots[0].name = 'mutated';
    telemetry.last_child_activity.category = 'mutated';
    const unchanged = (await runtime.larva_subagent_status({task_id:external.task_id}, {env})).details.runs[0];
    assert.equal(unchanged.tool_snapshots[0].name, 'read');
    assert.notEqual(unchanged.last_child_activity.category, 'mutated');
    assert.deepEqual(runtime.subagentPresentationLogForTests(), []);
    const recent = runtime.larva_subagent_sessions({}, {externalHostCanSpawn:true});
    assert.equal(recent.details.sessions[0].task_id, external.task_id);
    assert.equal(recent.details.sessions[0].persona_id, 'child');
    assert.equal(recent.details.sessions[0].last_status, 'success');
    assert.ok(!JSON.stringify(recent.content).includes('undefined'));
    const resumedExternal = await runtime.larva_subagent({persona_id:'child',task:'headless resume',task_id:external.task_id}, {
      env, externalHostCanSpawn:true,
    });
    assert.equal(resumedExternal.status, 'accepted');
    await runtime.larva_subagent_wait({task_ids:[external.task_id],timeout_ms:10000});
    assert.deepEqual(runtime.subagentPresentationLogForTests(), []);
    const streaming = await runtime.larva_subagent({persona_id:'child',task:'telemetry hang'}, {env,externalHostCanSpawn:true});
    let live;
    const streamDeadline = Date.now() + 5000;
    do {
      live = (await runtime.larva_subagent_status({task_id:streaming.task_id}, {env})).details.runs[0];
      if (live.active_tool?.toolCallId === 'active') break;
      assert.ok(Date.now() < streamDeadline, 'live telemetry frames not received');
      await new Promise(resolve => setTimeout(resolve, 5));
    } while (true);
    assert.equal(live.result_preview, null);
    assert.equal(live.live_thinking, true);
    assert.equal(live.live_assistant_preview, 'boundary assistant');
    assert.equal(live.tool_snapshots.length, 25);
    assert.equal(live.tool_snapshots[0].toolCallId, 'bounded-6');
    assert.equal(live.tool_snapshots[0].name, 'read');
    assert.equal(live.tool_snapshots[0].args_preview, '{"index":6}');
    assert.equal(live.tool_snapshots[0].output_preview, 'done 6');
    live.active_tool.name = 'mutated';
    const liveWait = await runtime.larva_subagent_wait({task_ids:[streaming.task_id],timeout_ms:0}, {env});
    assert.equal(liveWait.details.snapshots[streaming.task_id].active_tool.name, 'read');
    liveWait.details.snapshots[streaming.task_id].tool_snapshots[0].name = 'mutated';
    const liveSelect = await runtime.larva_subagent_select({task_ids:[streaming.task_id],timeout_ms:0}, {env});
    assert.equal(liveSelect.details.snapshots[streaming.task_id].tool_snapshots[0].name, 'read');
    await runtime.larva_subagent_cancel({task_id:streaming.task_id,reason:'telemetry assertions complete'}, {env});
    await runtime.larva_subagent_wait({task_ids:[streaming.task_id],timeout_ms:10000}, {env});
    const cancelledStream = (await runtime.larva_subagent_status({task_id:streaming.task_id}, {env})).details.runs[0];
    assert.equal(cancelledStream.status, 'cancelled');
    assert.equal(cancelledStream.active_tool, null);
    assert.equal(cancelledStream.live_thinking, false);
    assert.deepEqual(runtime.subagentPresentationLogForTests(), []);
    const nativeHeadless = await runtime.larva_subagent({persona_id:'child',task:'no native parent'}, {env});
    assert.equal(nativeHeadless.error.code,'LARVA_NO_ACTIVE_PERSONA');
  } finally { await runtime.resetExtensionUI('test_cleanup'); }
  const gate = join(root, 'resolve-gate');
  const resolving = client({FIXTURE_RESOLVE_GATE:gate});
  const pidCount = (await pidEntries()).length;
  const unresolvedCall = resolving.tool('larva_subagent', {persona_id:'child',task:'disconnect while resolving'}).catch(() => {});
  const deadline = Date.now() + 10000;
  while (!existsSync(gate + '.entered')) {
    assert.ok(Date.now() < deadline, 'resolve gate was not reached');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const closing = resolving.close();
  // Let EOF teardown run while resolution remains gated in the CLI process.
  await new Promise(resolve => setTimeout(resolve, 100));
  await writeFile(gate + '.release', '');
  await closing;
  await unresolvedCall;
  assert.equal((await pidEntries()).length, pidCount, 'disconnect during resolve must not spawn a child');
  assert.deepEqual(await readdir(join(root, '.pi/larva/runtime')), []);
  await assertReaped();
  console.log('disconnect during model resolution prevents child spawn and capsule creation: PASS');
  const delayed = client({FIXTURE_RPC_STARTUP:'delayed'});
  const delayedRun = await delayed.tool('larva_subagent', {persona_id:'child',task:'delayed readiness',wait_for_completion:true});
  assert.equal(delayedRun.isError, false, JSON.stringify(delayedRun));
  const delayedOutput = Object.values(delayedRun.details.terminal_outputs)[0];
  assert.equal(delayedOutput.status, 'success');
  assert.equal(delayedOutput.result_text, 'output parent=');
  await delayed.close();
  await assertReaped();
  console.log('initial readiness delayed 10,500 ms exceeds ordinary RPC timeout and succeeds: PASS');

  try {
    runtime.setChildRpcStartupReadyTimeoutForTests(200);
    const timedOut = await runtime.larva_subagent({persona_id:'child',task:'no readiness response'}, {
      env:{...env,FIXTURE_RPC_STARTUP:'never'},externalHostCanSpawn:true,
    });
    assert.equal(timedOut.error?.code, 'LARVA_CHILD_PROTOCOL_FAILED', JSON.stringify(timedOut));
    for (const field of ['id=state-1','type=get_state','stage=startup_readiness','first_frame_received=false','child_state=running','elapsed_ms=']) {
      assert.ok(timedOut.error.message.includes(field), timedOut.error.message);
    }
    const trace = (await readFile(env.LARVA_PI_CHILD_RPC_TRACE_FILE,'utf8')).trim().split('\n').map(JSON.parse);
    const timeout = trace.find(entry => entry.event === 'rpc_timeout' && entry.id === 'state-1');
    assert.ok(timeout, 'startup timeout trace missing');
    assert.equal(timeout.command_type, 'get_state');
    assert.equal(timeout.stage, 'startup_readiness');
    assert.equal(timeout.timeout_ms, 200);
    assert.equal(timeout.first_frame_received, false);
    assert.equal(timeout.frame_sequence, 0);
    assert.equal(timeout.rpc_ready, false);
    assert.equal(timeout.child_state, 'running');
    assert.equal(timeout.exit_code, null);
    assert.equal(timeout.signal, null);
    assert.ok(Number.isInteger(timeout.pid) && timeout.pid > 0);
    assert.ok(timeout.elapsed_ms >= 200);
    await assertReaped();
  } finally { await runtime.resetExtensionUI('test_cleanup'); }
  console.log('bounded startup timeout reports command, stage and child state; trace and capsule cleanup: PASS');

  try {
    const exited = await runtime.larva_subagent({persona_id:'child',task:'exit before readiness'}, {
      env:{...env,FIXTURE_RPC_STARTUP:'exit'},externalHostCanSpawn:true,
    });
    assert.equal(exited.error?.code, 'LARVA_CHILD_START_FAILED', JSON.stringify(exited));
    await assertReaped();
  } finally { await runtime.resetExtensionUI('test_cleanup'); }
  console.log('pre-readiness child exit fails closed and reaps capsule: PASS');

  // Codex copies regular files and directories, omitting symlinks. No sibling
  // extension or node_modules can satisfy imports in this isolated cache.
  const cachedPlugin = join(root, 'cache', 'larva-subagent');
  await cp(join(packageDir, '../codex-plugin'), cachedPlugin, {
    recursive:true, filter:source => !lstatSync(source).isSymbolicLink(),
  });
  assert.equal(existsSync(join(cachedPlugin, 'node_modules')), false);
  assert.equal(existsSync(join(cachedPlugin, '../pi-extension')), false);
  const cached = client({}, cachedPlugin);
  assert.equal((await cached.request('initialize')).result.serverInfo.name, 'larva-pi-subagent');
  assert.equal((await cached.request('tools/list')).result.tools.length, 11);
  const cachedRun = await cached.tool('larva_subagent', {persona_id:'child',task:'cached plugin',wait_for_completion:true});
  assert.equal(cachedRun.isError, false, JSON.stringify(cachedRun));
  assert.equal(Object.values(cachedRun.details.terminal_outputs)[0].result_text, 'output parent=');
  await cached.close();
  console.log('regular-file-only plugin cache without node_modules or sibling extension, dangling capsule symlink, headless presentation: PASS');
  const c = client();
  assert.equal((await c.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {name:'fixture',version:'1'} })).result.serverInfo.name, 'larva-pi-subagent');
  c.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  assert.deepEqual((await c.request('ping', {}, true)).result, {});
  const listed = (await c.request('tools/list')).result.tools;
  const expected = ['larva_personas','larva_subagent','larva_subagent_wait','larva_subagent_select','larva_subagent_status','larva_subagent_events','larva_subagent_sessions','larva_subagent_cancel','larva_subagent_activity'];
  assert.deepEqual(listed.map(tool => tool.name), [...expected, 'search_mentions', 'larva_subagent_panel']);
  const childResource = { uri: 'larva://personas/child', name: 'child', title: '@larva:child', description: 'Fixture child', mimeType: 'text/markdown' };
  const otherResource = { ...childResource, uri: 'larva://personas/other', name: 'other', title: '@larva:other', description: 'Fixture other' };
  const allMentions = await c.tool('search_mentions', { query: '' });
  assert.equal(allMentions.isError, false);
  assert.deepEqual(allMentions.content, []);
  assert.deepEqual(allMentions.structuredContent, { items: [childResource, otherResource].map(resource => ({ type: 'resource_link', ...resource })) });
  for (const query of ['child', '@larva:child', ' @LARVA:child ', '@persona:child', 'larva:child', 'persona:child', '@child']) {
    assert.deepEqual((await c.tool('search_mentions', { query })).structuredContent.items, [{ type: 'resource_link', ...childResource }]);
  }
  assert.deepEqual((await c.tool('search_mentions', { query: 'no-match' })).structuredContent.items, []);
  assert.deepEqual((await c.request('resources/list')).result, { resources: [childResource, otherResource] });
  for (const uri of ['larva://personas/child', 'larva://personas/%63hild']) {
    assert.deepEqual((await c.request('resources/read', { uri })).result, { contents: [{
      uri, mimeType: 'text/markdown',
      text: '# @larva:child\n\nFixture child\n\n- **persona_id**: `child`\n- **model**: `fixture/model`\n- **delegation**: Call `larva_subagent` with `persona_id: "child"`.\n',
    }] });
  }
  const registrySource = await readFile(join(packageDir, '../../src/larva/shell/mcp_contract.py'), 'utf8');
  const registryNames = [...registrySource.matchAll(/"name"\s*:\s*"([^"]+)"/g)].map(match => match[1]);
  assert.ok(registryNames.length > 0);
  assert.deepEqual(expected.filter(name => registryNames.includes(name)), []);
  console.log('stdio initialize, framed ping, tools/list and registry separation: PASS');
  const personas = await c.tool('larva_personas', {query:'child'});
  assert.equal(personas.details.personas[0].id, 'child');
  const single = await c.tool('larva_subagent', {persona_id:'child', task:'single', wait_for_completion:true});
  assert.equal(single.isError, false, JSON.stringify(single));
  const output = Object.values(single.details.terminal_outputs)[0];
  assert.equal(output.result_text, 'output parent=');
  assert.equal(output.child_output_truncated, false);
  assert.equal(output.full_output_artifact, null);
  assert.equal(output.callback_delivery, 'delivered');
  assert.ok(output.callback_id && output.completed_at && output.message);
  const taskId = output.task_id;
  const panel = (await c.tool('larva_subagent_panel', {task_id:taskId})).structuredContent;
  assert.equal(panel.status, 'success');
  assert.deepEqual(panel.sessions, []);
  assert.equal(panel.runs[0].task_preview, 'single');
  assert.equal(panel.runs[0].startup_model, 'fixture/model');
  assert.equal(panel.runs[0].live_assistant_preview, 'live fixture assistant');
  assert.equal(panel.runs[0].tool_snapshots[0].status, 'success');
  assert.equal(panel.runs[0].result_preview, 'output parent=');
  assert.equal(panel.terminal_outputs[taskId].result_text, 'output parent=');
  assert.ok((await c.tool('larva_subagent_panel')).structuredContent.sessions.length > 0);
  assert.equal((await c.tool('larva_subagent_panel', {limit:26})).isError, true);
  console.log('external-host default admission and single-call completion outbox: PASS');
  for (const [parent, target] of [['parent','other'],['deny','child']]) {
    const denied = await c.tool('larva_subagent', {persona_id:target,task:'deny',parent_persona_id:parent});
    assert.equal(denied.details.error.code, 'LARVA_SPAWN_NOT_ALLOWED');
  }
  const allowed = await c.tool('larva_subagent', {persona_id:'child', task:'allowed', parent_persona_id:'  parent  ', wait_for_completion:true});
  assert.equal(allowed.isError, false, JSON.stringify(allowed));
  assert.equal(Object.values(allowed.details.terminal_outputs)[0].result_text, 'output parent=parent');
  const unrestricted = await c.tool('larva_subagent', {persona_id:'other',task:'allowed boolean',parent_persona_id:'child',wait_for_completion:true});
  assert.equal(Object.values(unrestricted.details.terminal_outputs)[0].result_text, 'output parent=child');
  const configuredParent = client({LARVA_MCP_PARENT_PERSONA:'parent'});
  const configuredDenied = await configuredParent.tool('larva_subagent',{persona_id:'other',task:'deny env parent'});
  assert.equal(configuredDenied.details.error.code, 'LARVA_SPAWN_NOT_ALLOWED');
  await configuredParent.close();
  for (const parent of ['   ', '']) {
    const unsetParent = client({LARVA_MCP_PARENT_PERSONA:parent, LARVA_PI_PARENT_PERSONA_ID:'stale'});
    const unsetRun = await unsetParent.tool('larva_subagent', {persona_id:'child',task:'unset env parent',wait_for_completion:true});
    assert.equal(unsetRun.isError, false, JSON.stringify(unsetRun));
    assert.equal(Object.values(unsetRun.details.terminal_outputs)[0].result_text, 'output parent=');
    await unsetParent.close();
  }
  console.log('parent whitelist, boolean authority, configured parent and child environment propagation: PASS');
  const accepted = await Promise.all(['slow one','two'].map(task => c.tool('larva_subagent', {persona_id:'child',task,wait_for_completion:false})));
  for (const result of accepted) assert.equal(result.details.status, 'accepted');
  const taskIds = accepted.map(result => result.details.task_id);
  const livePanel = (await c.tool('larva_subagent_panel', {task_id:taskIds[0]})).structuredContent;
  assert.equal(livePanel.runs[0].result_pending, true);
  assert.equal(livePanel.runs[0].result_preview, null);
  assert.equal(livePanel.runs[0].startup_model, 'fixture/model');
  const selected = await c.tool('larva_subagent_select', {task_ids:taskIds,timeout_ms:10000});
  assert.ok(Object.keys(selected.details.terminal_outputs).length >= 1);
  const waited = await c.tool('larva_subagent_wait', {task_ids:taskIds,timeout_ms:10000});
  assert.deepEqual(Object.keys(waited.details.terminal_outputs).sort(), taskIds.sort());
  assert.ok(Object.values(waited.details.terminal_outputs).every(output => output.result_text === 'output parent='));
  assert.equal((await c.tool('larva_subagent_status',{task_id:taskId})).details.runs[0].callback_delivery, 'delivered');
  assert.ok((await c.tool('larva_subagent_events')).details.events.length > 0);
  const recent = await c.tool('larva_subagent_sessions');
  assert.ok(recent.details.sessions.length > 0);
  for (const taskId of taskIds) {
    const session = recent.details.sessions.find(session => session.task_id === taskId);
    assert.ok(session, `missing session: ${taskId}`);
    assert.equal(session.persona_id, 'child');
    assert.equal(session.last_status, 'success');
  }
  assert.ok(!JSON.stringify(recent.content).includes('undefined'));
  console.log('parallel fan-out, wait/select captured output, status/events/sessions: PASS');
  const activity = await c.tool('larva_subagent_activity', {task_id:taskId});
  assert.equal(activity.isError, false, JSON.stringify(activity));
  assert.match(JSON.stringify(activity), /call-1/);
  const exact = await c.tool('larva_subagent_activity',{session_path:taskId,tool_call_id:'call-1',segment_part:'args'});
  assert.match(JSON.stringify(exact), /fixture/);
  console.log('recorded tool activity and exact call inspection: PASS');
  const resumed = await c.tool('larva_subagent',{persona_id:'child',task:'resume',task_id:taskId,parent_persona_id:'parent',wait_for_completion:true});
  assert.equal(resumed.details.terminal_outputs[taskId].result_text,'output parent=parent');
  assert.notEqual(resumed.details.terminal_outputs[taskId].callback_id,output.callback_id);
  console.log('resume replaces the prior outbox output for the exact handle: PASS');
  const large = await c.tool('larva_subagent',{persona_id:'child',task:'large output',wait_for_completion:true});
  const largeOutput = Object.values(large.details.terminal_outputs)[0];
  assert.equal(largeOutput.child_output_truncated,true);
  assert.equal(largeOutput.child_output_preview,largeOutput.result_text);
  assert.equal(await readFile(largeOutput.full_output_artifact.path,'utf8'),'large-result-'.repeat(2000));
  assert.match(largeOutput.message,/full_output_artifact/);
  console.log('truncated callback preserves preview and full-output artifact: PASS');
  const hanging = await c.tool('larva_subagent',{persona_id:'child',task:'hang for cancellation'});
  const cancelled = await c.tool('larva_subagent_cancel',{task_id:hanging.details.task_id,reason:'fixture finished'});
  assert.equal(cancelled.isError, false, JSON.stringify(cancelled));
  const cancellation = await c.tool('larva_subagent_wait',{task_ids:[hanging.details.task_id],timeout_ms:10000});
  assert.equal(cancellation.details.runs[0].status, 'cancelled');
  assert.equal(cancellation.details.terminal_outputs[hanging.details.task_id].status, 'cancelled');
  console.log('exact-handle cancellation: PASS');
  await c.tool('larva_subagent',{persona_id:'child',task:'hang until disconnect'});
  await c.close();
  await assertReaped();
  console.log('stdin disconnect reaps active children and capsules: PASS');
  const invalid = client({ LARVA_PI_CLI_SCRIPT: cli });
  const rejected = await invalid.tool('larva_subagent',{persona_id:'child',task:'invalid cli'});
  assert.equal(rejected.details.error.code, 'LARVA_CHILD_START_FAILED', JSON.stringify(rejected));
  await invalid.close();
  const binMismatch = client({ LARVA_PI_CLI_SCRIPT: join(pkg,'other.mjs') });
  await writeFile(join(pkg,'other.mjs'), 'throw new Error("must not launch");');
  const mismatch = await binMismatch.tool('larva_subagent',{persona_id:'child',task:'invalid bin'});
  assert.equal(mismatch.details.error.code, 'LARVA_CHILD_START_FAILED');
  await binMismatch.close();
  const pathDir = join(root,'bin'); await mkdir(pathDir); await symlink(piScript,join(pathDir,'pi'));
  const fallbackBin = join(root, '.local', 'bin');
  await mkdir(fallbackBin, {recursive:true});
  // A bad fallback pi must not shadow a valid explicit PATH prefix.
  await symlink(cli, join(fallbackBin, 'pi'));
  const discovered = client({ LARVA_PI_CLI_SCRIPT: undefined, LARVA_PI_REAL_BIN: undefined, PATH: pathDir });
  const found = await discovered.tool('larva_subagent',{persona_id:'child',task:'discovered',wait_for_completion:true});
  assert.equal(Object.values(found.details.terminal_outputs)[0].status,'success');
  await discovered.close();
  await rm(join(fallbackBin, 'pi'));
  await symlink(piScript, join(fallbackBin, 'pi'));
  const fallback = client({LARVA_PI_CLI_SCRIPT:undefined, LARVA_PI_REAL_BIN:undefined, PATH:join(root,'absent-bin')});
  const fallbackFound = await fallback.tool('larva_subagent',{persona_id:'child',task:'GUI PATH fallback',wait_for_completion:true});
  assert.equal(Object.values(fallbackFound.details.terminal_outputs)[0].status,'success');
  await fallback.close();
  console.log('explicit CLI identity rejection and PATH discovery validation: PASS');
  await rm(join(fallbackBin, 'pi'));

  // A managed launcher is a shell wrapper, not the package's bin.pi entry.
  const agent = join(root, '.pi', 'agent');
  const managedLauncher = join(agent, 'bin', 'pi');
  const currentVersion = join(agent, 'install', 'current-version');
  const release = join(agent, 'install', 'releases', '1.2.0', 'node_modules');
  const managedPath = join(root, 'managed-path');
  await mkdir(join(agent, 'bin'), {recursive:true});
  await mkdir(join(release, '.bin'), {recursive:true});
  await mkdir(managedPath);
  await writeFile(managedLauncher, '#!/bin/sh\nexit 99\n');
  await writeFile(currentVersion, '1.2.0\n');
  const releasePackage = join(release, '@earendil-works', 'pi-coding-agent');
  await cp(pkg, releasePackage, {recursive:true});
  await symlink(join(releasePackage, 'cli.mjs'), join(release, '.bin', 'pi'));
  await symlink(managedLauncher, join(managedPath, 'pi'));
  const managed = client({LARVA_PI_CLI_SCRIPT:undefined, LARVA_PI_REAL_BIN:undefined, PATH:managedPath});
  const managedRun = await managed.tool('larva_subagent', {persona_id:'child',task:'managed release',wait_for_completion:true});
  assert.equal(managedRun.isError, false, JSON.stringify(managedRun));
  assert.equal(Object.values(managedRun.details.terminal_outputs)[0].status, 'success');
  await managed.close();

  // Exercise the additional agent/bin GUI fallback without the local/bin alias.
  const managedFallback = client({LARVA_PI_CLI_SCRIPT:undefined, LARVA_PI_REAL_BIN:undefined, PATH:join(root,'absent-bin')});
  const managedFallbackRun = await managedFallback.tool('larva_subagent', {persona_id:'child',task:'managed fallback',wait_for_completion:true});
  assert.equal(Object.values(managedFallbackRun.details.terminal_outputs)[0].status, 'success');
  await managedFallback.close();

  // Direct runtime admission keeps rejection tests independent of machine PATH
  // fallbacks. A valid PATH must never rescue an invalid explicit override.
  const managedEnv = {...env, LARVA_PI_CLI_SCRIPT:undefined, LARVA_PI_REAL_BIN:undefined, PATH:managedPath};
  async function rejectManaged(overrides = {}) {
    try {
      const result = await runtime.larva_subagent(
        {persona_id:'child',task:'must not launch'},
        {env:{...managedEnv,...overrides}, externalHostCanSpawn:true},
      );
      assert.equal(result.error?.code, 'LARVA_CHILD_START_FAILED', JSON.stringify(result));
    } finally { await runtime.resetExtensionUI('test_cleanup'); }
  }
  await rejectManaged({LARVA_PI_CLI_SCRIPT:managedLauncher});
  await rejectManaged({LARVA_PI_REAL_BIN:managedLauncher});
  await rejectManaged({LARVA_PI_CLI_SCRIPT:cli, LARVA_PI_REAL_BIN:piScript});
  // Dot and traversal tokens would reach a valid bin without token validation.
  await symlink(release, join(agent, 'install', 'releases', 'node_modules'));
  await symlink(release, join(agent, 'install', 'node_modules'));
  for (const version of ['', '.', '..', '../releases/1.2.0', '1.2.0/extra', '1.2.0 missing', 'absent']) {
    await writeFile(currentVersion, version);
    await rejectManaged();
  }
  await writeFile(currentVersion, '1.2.0');
  const releaseManifest = join(releasePackage, 'package.json');
  const validManifest = JSON.parse(await readFile(releaseManifest, 'utf8'));
  await writeFile(releaseManifest, JSON.stringify({...validManifest, name:'impostor'}));
  await rejectManaged();
  await writeFile(releaseManifest, JSON.stringify({...validManifest, bin:{pi:'other.mjs'}}));
  await rejectManaged();
  await writeFile(releaseManifest, JSON.stringify(validManifest));
  await rm(currentVersion);
  await rejectManaged();
  console.log('managed installer PATH and agent/bin fallback discovery; strict explicit overrides, invalid versions and release identities: PASS');
  for (const signal of ['SIGTERM','SIGINT']) {
    const c = client();
    await c.tool('larva_subagent',{persona_id:'child',task:'hang until signal'});
    await c.close(signal);
    await assertReaped();
  }
  console.log('signal cleanup: PASS');
} finally {
  for (const c of clients) await c.close().catch(() => { c.child.kill('SIGKILL'); });
  // Reconcile fixture child PIDs even if an assertion or protocol operation failed.
  for (const entry of await pidEntries()) {
    try { process.kill(entry.pid,'SIGKILL'); } catch {}
    if (entry.capsule) await rm(entry.capsule,{recursive:true,force:true});
  }
  await rm(root,{recursive:true,force:true});
}
