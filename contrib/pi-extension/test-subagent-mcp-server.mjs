// purpose: exercise the external stdio host through real runtime admission, RPC, and cleanup
// usage: node contrib/pi-extension/test-subagent-mcp-server.mjs
// effects: isolated fixture processes, sessions and capsules; removed in finally
// requires: Node with native TypeScript support and locked extension dependencies
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const packageDir = dirname(fileURLToPath(import.meta.url));
const root = realpathSync(await mkdtemp(join(tmpdir(), 'larva-mcp-')));
const clients = [];
const env = { ...process.env, HOME: root, PI_CODING_AGENT_DIR: join(root, 'base-agent'), LARVA_PI_CHILD_SESSION_DIR: join(root, 'sessions'), LARVA_PI_CHILD_RPC_LEGACY_FALLBACK: '1', LARVA_PI_CHILD_RPC_TRACE_FILE: join(root, 'trace.jsonl') };
for (const key of Object.keys(env)) if (key.startsWith('LARVA_') && !['LARVA_PI_CHILD_SESSION_DIR', 'LARVA_PI_CHILD_RPC_LEGACY_FALLBACK', 'LARVA_PI_CHILD_RPC_TRACE_FILE'].includes(key)) delete env[key];
function client(overrides = {}) {
  const child = spawn(process.execPath, [join(packageDir, 'subagent-mcp-server.mjs')], { env: { ...env, ...overrides }, stdio: ['pipe', 'pipe', 'pipe'] });
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
    request(method, params = {}, framed = false) {
      const id = ++sequence;
      const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      const result = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}; ${stderr}`)); }, 30000);
        pending.set(id, { resolve(value) { clearTimeout(timer); resolve(value); }, reject(error) { clearTimeout(timer); reject(error); } });
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
async function assertReaped() {
  const files = await readdir(root);
  for (const file of files.filter(file => file.startsWith('pid-'))) {
    const entry = JSON.parse(await readFile(join(root, file), 'utf8'));
    assert.throws(() => process.kill(entry.pid, 0), { code: 'ESRCH' });
    assert.equal(existsSync(entry.capsule), false, entry.capsule);
  }
}
try {
  await mkdir(env.PI_CODING_AGENT_DIR, { recursive: true });
  const cli = join(root, 'larva-cli.mjs');
  await writeFile(cli, `
const command = process.argv[2], id = process.argv[3];
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
    const malformedParent = await runtime.larva_subagent({persona_id:'child',task:'invalid',parent_persona_id:null}, {env,externalHostCanSpawn:true});
    assert.equal(malformedParent.error.code,'LARVA_BAD_INPUT');
    const nativeHeadless = await runtime.larva_subagent({persona_id:'child',task:'no native parent'}, {env});
    assert.equal(nativeHeadless.error.code,'LARVA_NO_ACTIVE_PERSONA');
  } finally { await runtime.resetExtensionUI('test_cleanup'); }
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
  assert.equal((await c.tool('larva_subagent', {persona_id:'child',task:'run',unknown:true})).isError, true);
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
  const allowed = await c.tool('larva_subagent', {persona_id:'child', task:'allowed', parent_persona_id:'parent', wait_for_completion:true});
  assert.equal(Object.values(allowed.details.terminal_outputs)[0].result_text, 'output parent=parent');
  const unrestricted = await c.tool('larva_subagent', {persona_id:'other',task:'allowed boolean',parent_persona_id:'child',wait_for_completion:true});
  assert.equal(Object.values(unrestricted.details.terminal_outputs)[0].result_text, 'output parent=child');
  const configuredParent = client({LARVA_MCP_PARENT_PERSONA:'parent'});
  const configuredDenied = await configuredParent.tool('larva_subagent',{persona_id:'other',task:'deny env parent'});
  assert.equal(configuredDenied.details.error.code, 'LARVA_SPAWN_NOT_ALLOWED');
  await configuredParent.close();
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
  assert.ok((await c.tool('larva_subagent_sessions')).details.sessions.length > 0);
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
  const discovered = client({ LARVA_PI_CLI_SCRIPT: undefined, LARVA_PI_REAL_BIN: undefined, PATH: pathDir });
  const found = await discovered.tool('larva_subagent',{persona_id:'child',task:'discovered',wait_for_completion:true});
  assert.equal(Object.values(found.details.terminal_outputs)[0].status,'success');
  await discovered.close();
  console.log('explicit CLI identity rejection and PATH discovery validation: PASS');
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
  for (const file of (await readdir(root)).filter(file => file.startsWith('pid-'))) {
    const entry = JSON.parse(await readFile(join(root,file),'utf8'));
    try { process.kill(entry.pid,'SIGKILL'); } catch {}
    if (entry.capsule) await rm(entry.capsule,{recursive:true,force:true});
  }
  await rm(root,{recursive:true,force:true});
}
