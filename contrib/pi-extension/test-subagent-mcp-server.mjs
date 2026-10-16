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
  assert.equal((await idle.request('initialize')).result.serverInfo.name, 'larva-pi-subagent');
  idle.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  assert.deepEqual((await idle.request('ping')).result, {});
  assert.equal((await idle.request('tools/list')).result.tools.length, 9);
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
  assert.equal((await cached.request('tools/list')).result.tools.length, 9);
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
  assert.deepEqual(listed.map(tool => tool.name), expected);
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
