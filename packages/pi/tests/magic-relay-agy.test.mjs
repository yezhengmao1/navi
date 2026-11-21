import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { runAgy } from '../extensions/magic-relay/agy.ts';

// Real pipes, but never a real agy, network call, or model. Log each incoming
// message so the parent test can check both the wire contract and non-replay.
const agent = `#!${process.execPath}
const fs = require('node:fs');
const mode = fs.readFileSync('mode', 'utf8');
fs.appendFileSync('pids', process.pid + '\\n');
fs.writeFileSync('args', JSON.stringify(process.argv.slice(2)));
const send = msg => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\\n');
const reply = (id, result) => send({ id, result });
const update = (kind, text, extra = {}, sessionId = 'fresh') => send({method:'session/update', params:{sessionId, update:{sessionUpdate:kind, content:{type:'text', text}, ...extra}}});
let promptId;
require('node:readline').createInterface({input: process.stdin}).on('line', line => {
  fs.appendFileSync('wire', line + '\\n');
  const { method, id } = JSON.parse(line);
  if (method === 'initialize') return reply(id, {protocolVersion: mode === 'version' ? 2 : 1});
  if (method === 'session/new') return reply(id, {sessionId:'fresh'});
  if (method === 'session/prompt') {
    promptId = id;
    update('agent_message_chunk', 'pre-tool commentary');
    update('tool_call', 'tool details');
    update('agent_message_chunk', 'partial', {messageId: 'first'});
    if (mode === 'error') return send({ id, error:{code:-32000, message:'fake RPC failure'} });
    if (mode === 'exit') return process.exit(3);
    if (mode === 'invalid') return process.stdout.write('not JSON\\n');
    if (mode === 'bad-id') return reply(id + 99, {stopReason:'end_turn'});
    if (mode === 'stopped') return reply(id, {stopReason:'max_tokens'});
    if (mode === 'long-answer') return update('agent_message_chunk', '界'.repeat(17 * 1024));
    if (mode === 'long-frame') return process.stdout.write('x'.repeat(257 * 1024));
    if (mode === 'flood') { for (let i = 0; i < 40; i++) update('agent_thought_chunk', 'x'.repeat(120 * 1024)); return; }
    if (mode === 'hang') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); return; }
    if (mode === 'permission') return send({ id:'perm', method:'session/request_permission', params:{sessionId:'fresh', options:[{optionId:'yes',kind:'allow_always'}]} });
    update('agent_message_chunk', ' final: ', {messageId:'final'});
    update('agent_thought_chunk', 'thought'); update('user_message_chunk', 'user');
    update('agent_message_chunk', 'other session', {}, 'other');
    process.stderr.write('stderr, not part of the answer');
    // Split inside a multibyte character, then coalesce with the end response.
    const frame = Buffer.from(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'fresh',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'界\\n'}}}}) + '\\n');
    const cut = frame.indexOf('界') + 1; process.stdout.write(frame.subarray(0, cut));
    setTimeout(() => { process.stdout.write(frame.subarray(cut)); reply(id, {stopReason:'end_turn'}); }, 10);
  } else if (id === 'perm') send({id:5, method:'fs/read_text_file', params:{path:'/not-for-client'}});
  else if (id === 5) { update('agent_message_chunk', 'denied', {messageId:'last'}); reply(promptId, {stopReason:'end_turn'}); }
});
`;

async function fixture(t, mode, fallback = false) {
  const root = await mkdtemp(join(tmpdir(), 'relay-agy-'));
  const cwd = join(root, 'workspace'), home = join(root, 'home');
  const bin = fallback ? join(home, '.local', 'bin') : join(root, 'bin');
  const { PATH, HOME } = process.env;
  t.after(async () => {
    for (const [key, val] of Object.entries({ PATH, HOME })) {
      if (val === undefined) delete process.env[key]; else process.env[key] = val;
    }
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(bin, { recursive: true }); await mkdir(cwd);
  await writeFile(join(bin, 'agy'), agent, { mode: 0o755 });
  await writeFile(join(cwd, 'agy'), `#!${process.execPath}\nrequire('fs').writeFileSync('unsafe','ran');`, { mode: 0o755 });
  await writeFile(join(cwd, 'mode'), mode);
  process.env.HOME = home;
  process.env.PATH = fallback ? '.:' : `.:${bin}`;
  return { cwd, read: name => readFile(join(cwd, name), 'utf8') };
}
const bounded = () => AbortSignal.timeout(5000);

test('negotiates one sandboxed fresh turn; returns only final text (including split UTF-8)', async t => {
  const f = await fixture(t, 'ok', true);
  const task = 'quote "\n; $(this is text)';
  assert.equal(await runAgy(task, f.cwd, bounded()), ' final: 界\n');
  assert.deepEqual(JSON.parse(await f.read('args')), ['acp', '--stdio', '--sandbox']);
  const wire = (await f.read('wire')).trim().split('\n').map(s => JSON.parse(s));
  assert.deepEqual(wire, [
    {jsonrpc:'2.0', id:1, method:'initialize', params:{protocolVersion:1, clientCapabilities:{}}},
    {jsonrpc:'2.0', id:2, method:'session/new', params:{cwd:f.cwd, mcpServers:[]}},
    {jsonrpc:'2.0', id:3, method:'session/prompt', params:{sessionId:'fresh', prompt:[{type:'text', text:task}]}},
  ]);
  await assert.rejects(f.read('unsafe'), {code:'ENOENT'});
});

test('cancels permission requests even when only allow is offered; refuses client tools', async t => {
  const f = await fixture(t, 'permission');
  assert.equal(await runAgy('test', f.cwd, bounded()), 'denied');
  const replies = (await f.read('wire')).trim().split('\n').slice(3).map(s => JSON.parse(s));
  assert.deepEqual(replies[0], {jsonrpc:'2.0', id:'perm', result:{outcome:{outcome:'cancelled'}}});
  assert.equal(replies[1].id, 5); assert.equal(replies[1].error.code, -32601);
});

for (const [mode, error] of Object.entries({
  error: /fake RPC failure/, exit: /before completing/, invalid: /invalid ACP JSON/, 'bad-id': /response ID/,
  version: /ACP v1/, stopped: /max_tokens/, 'long-answer': /refusing truncated output/, 'long-frame': /frame exceeds/, flood: /stdout exceeds/,
})) {
  test(`rejects ${mode} without returning partial text or replaying`, async t => {
    const f = await fixture(t, mode);
    await assert.rejects(runAgy('test', f.cwd, bounded()), error);
    assert.equal((await f.read('pids')).trim().split('\n').length, 1);
    const wire = (await f.read('wire')).trim().split('\n').map(s => JSON.parse(s));
    assert.equal(wire.filter(m => m.method === 'session/prompt').length, mode === 'version' ? 0 : 1);
  });
}

test('caller deadline during a prompt rejects and kills an uncooperative peer', async t => {
  const f = await fixture(t, 'hang');
  const controller = new AbortController();
  const result = assert.rejects(runAgy('wait', f.cwd, AbortSignal.any([controller.signal, bounded()])), /caller deadline/);
  try {
    for (let i = 0; !(await f.read('wire').catch(() => '')).includes('session/prompt'); i++) {
      assert.ok(i < 200, 'fake agent did not receive prompt'); await delay(10);
    }
  } finally { controller.abort(new Error('caller deadline')); }
  await result;
  const pid = Number((await f.read('pids')).trim());
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch (err) { assert.equal(err.code, 'ESRCH'); return; }
    await delay(10);
  }
  assert.fail('fake agy is still alive');
});

test('already-aborted or oversized task never starts agy', async t => {
  const f = await fixture(t, 'ok');
  await assert.rejects(runAgy('test', f.cwd, AbortSignal.abort()), {name:'AbortError'});
  await assert.rejects(runAgy('界'.repeat(22 * 1024), f.cwd, bounded()), /task exceeds/);
  await assert.rejects(f.read('pids'), {code:'ENOENT'});
});
