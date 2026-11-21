import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as flush } from 'node:timers/promises';
import { load } from './helpers.mjs';

const { registerRelay } = await load('../magic-relay/index');
function fixture(deadline = 30_000) {
  const calls = [], messages = [], notices = [], events = new Map(), statuses = [];
  let command, tool, renderer;
  const ctx = { cwd: '/project', mode: 'tui', hasUI: true, isProjectTrusted: () => true, ui: {
    notify: (text, level) => notices.push({text, level}), setStatus: (_, value) => statuses.push(value),
    custom: async () => ({ allow: true }),
  } };
  const run = (task, cwd, signal, settings) => new Promise((resolve, reject) => calls.push({task, cwd, signal, settings, resolve, reject}));
  registerRelay({ on: (name, fn) => events.set(name, fn), registerTool: t => { tool = t; },
    registerCommand: (name, c) => { assert.equal(name, 'relay'); command = c; },
    registerMessageRenderer: (_, fn) => { renderer = fn; },
    sendMessage: (msg, options) => messages.push({msg, options}),
  }, run, deadline);
  return { ctx, calls, messages, notices, statuses, cmd: args => command.handler(args, ctx),
    exec: (task = 'check', signal, settings = {}) => tool.execute('id', {task, ...settings}, signal, undefined, ctx),
    render: (msg, expanded) => renderer(msg, { expanded, keyText: () => 'Ctrl+O' }, { fg: (_c, s) => s }),
    event: name => events.get(name)({}, ctx) };
}

test('dispatch returns a receipt without polling; one final wake uses followUp, not steering', async () => {
  const f = fixture();
  const settings = { model: 'gemini-4-neon', thoughtLevel: 'xhigh' };
  const receipt = await f.exec('设计测试', undefined, settings);
  assert.deepEqual(f.calls[0].settings, settings);
  assert.equal(receipt.terminate, true);
  assert.equal(f.calls[0].task, '设计测试'); assert.equal(f.calls[0].cwd, '/project');
  assert.equal(f.messages.length, 0);
  await f.cmd('status'); assert.ok(f.notices.at(-1).text.includes(receipt.details.id));
  await assert.rejects(f.exec('duplicate'), /已有/);
  f.calls[0].resolve('\x1b[31mevidence\x1b[0m'); await flush();
  assert.equal(f.calls.length, 1); assert.equal(f.messages.length, 1);
  const {msg, options} = f.messages[0];
  assert.deepEqual(options, { deliverAs: 'followUp', triggerTurn: true });
  assert.equal(msg.details.id, receipt.details.id); assert.equal(msg.display, true);
  assert.match(msg.content, /设计测试/); assert.match(msg.content, /evidence/); assert.ok(!msg.content.includes('\x1b'));
  const compact = f.render(msg, false).render(48);
  assert.ok(compact.length <= 5); assert.match(compact.join('\n'), /evidence/);
  assert.doesNotMatch(compact.join('\n'), /设计测试/);
  assert.equal(f.render(msg, true), undefined); // Native renderer keeps full message.content.
  assert.equal(f.statuses.at(-1), undefined);
});

test('manual command starts directly; runner failure wakes once without retry', async () => {
  const f = fixture(); f.ctx.ui.custom = () => assert.fail('slash command is already explicit');
  await f.cmd('agy a\nmultiline task'); assert.equal(f.calls[0].task, 'a\nmultiline task');
  f.calls[0].reject(new Error('could not start')); await flush();
  assert.equal(f.messages.length, 1); assert.match(f.messages[0].msg.content, /失败[\s\S]*could not start/);
  assert.equal(f.calls.length, 1);
});

for (const action of ['cancel', 'session_tree', 'session_shutdown']) test(`${action}: late completion cannot reach a replacement job`, async () => {
  const f = fixture(); await f.cmd('agy old');
  if (action === 'cancel') await f.cmd('cancel'); else f.event(action);
  assert.ok(f.calls[0].signal.aborted);
  await f.cmd('agy new'); f.calls[0].resolve('stale'); await flush();
  assert.equal(f.messages.length, 0); assert.match(f.statuses.at(-1), /Relay/);
  f.calls[1].resolve('fresh'); await flush();
  assert.equal(f.messages.length, 1); assert.match(f.messages[0].msg.content, /fresh/);
});

test('deadline aborts and reports failure without treating partial output as a result', async () => {
  const f = fixture(5); await f.cmd('agy check'); const call = f.calls[0];
  await new Promise((resolve, reject) => {
    const guard = setTimeout(() => reject(new Error('deadline was not enforced')), 1000);
    call.signal.addEventListener('abort', () => {clearTimeout(guard); call.resolve('partial response'); resolve();}, {once:true});
  });
  await flush(); assert.match(f.messages[0].msg.content, /超时/); assert.doesNotMatch(f.messages[0].msg.content, /partial response/);
});

test('no dispatch without trusted interactive context, valid task, and explicit tool consent', async () => {
  const f = fixture(); await f.cmd('other hello'); await f.cmd('status');
  f.ctx.mode = 'json'; await assert.rejects(f.exec(), /交互/);
  f.ctx.mode = 'tui'; f.ctx.isProjectTrusted = () => false; await f.cmd('agy hello');
  f.ctx.isProjectTrusted = () => true; await assert.rejects(f.exec('   '), /任务/);
  f.ctx.ui.custom = async () => ({allow:false}); await assert.rejects(f.exec(), /未派发/);
  f.ctx.ui.custom = async () => { f.event('session_tree'); return {allow:true}; };
  await assert.rejects(f.exec(), /未派发/);
  assert.equal(f.calls.length, 0); assert.equal(f.messages.length, 0);
});
