import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load, tui, root } from './helpers.mjs';
const { initTheme } = await import(`${root}/dist/modes/interactive/theme/theme.js`);
initTheme('dark', false);
const { default: register, IDLE_MS, workTranscript, redact, summaryMarkdown } = await load('../idle-summary');

function harness(t, mode = 'tui') {
  const timers = new Map(); let id = 0;
  t.mock.method(globalThis, 'setTimeout', (fn, delay) => { timers.set(++id, { fn, delay }); return id; });
  t.mock.method(globalThis, 'clearTimeout', id => timers.delete(id));
  const events = {}, entries = [], renderers = {}, calls = [], commands = {}, notices = [];
  register({
    on(name, fn) { events[name] = fn; },
    registerCommand(name, command) { commands[name] = command; },
    registerEntryRenderer(name, renderer) { renderers[name] = renderer; },
    appendEntry(name, data) { entries.push({ customType: name, data }); },
  });
  const ctx = { mode, isIdle: () => true, model: { id: 'test' },
    ui: { notify: text => notices.push(text) },
    sessionManager: { getBranch: () => [{ type: 'message', message: { role: 'user', content: '实现空闲总结插件' } }] },
    modelRegistry: { async complete(...args) { calls.push(args); return { content: [{ type: 'text', text: '下一步：验证插件。' }], stopReason: 'stop' }; } } };
  const emit = name => events[name]?.({}, ctx);
  const fire = async () => { const entry = [...timers].find(([, v]) => v.delay === IDLE_MS); if (entry) { timers.delete(entry[0]); entry[1].fn(); } await new Promise(resolve => setImmediate(resolve)); };
  return { timers, ctx, emit, fire, entries, renderers, calls, notices, command: (args = '') => commands['idle-summary'].handler(args, ctx) };
}
test('only settled work starts a five-minute one-shot, display is not a message', async t => {
  const h = harness(t); h.emit('session_start'); assert.equal(h.timers.size, 0);
  h.emit('before_agent_start'); assert.equal(h.timers.size, 0);
  h.emit('agent_settled'); assert.equal([...h.timers.values()][0].delay, 300000);
  await h.fire(); assert.equal(h.calls.length, 1); assert.match(h.entries.at(-1).data.text, /下一步/);
  h.emit('input'); assert.equal(h.entries.length, 1); // Historical summaries stay in the transcript.
  h.emit('agent_settled'); await h.fire(); assert.equal(h.calls.length, 1);
  h.emit('before_agent_start'); h.emit('agent_settled'); await h.fire(); assert.equal(h.calls.length, 2);
});
test('input, session lifecycle and shutdown cancel pending summaries', async t => {
  const h = harness(t);
  for (const event of ['input', 'session_before_switch', 'session_before_fork', 'session_before_tree', 'session_before_compact', 'session_shutdown']) {
    h.emit('before_agent_start'); h.emit('agent_settled'); h.emit(event); await h.fire();
  }
  assert.equal(h.calls.length, 0);
});
test('no background requests in non-TUI, busy state or active dialogs', async t => {
  const h = harness(t, 'rpc'); h.emit('before_agent_start'); h.emit('agent_settled'); await h.fire();
  h.ctx.mode = 'tui'; h.ctx.isIdle = () => false; h.emit('agent_settled'); await h.fire();
  h.ctx.isIdle = () => true; h.emit('ui_prompt_start'); h.emit('agent_settled'); await h.fire();
  assert.equal(h.calls.length, 0);
  h.emit('ui_prompt_end'); await h.fire(); assert.equal(h.calls.length, 1);
});
test('resuming work aborts generation and rejects stale responses', async t => {
  const h = harness(t); let resolve, signal;
  h.ctx.modelRegistry.complete = (_m, _c, options) => { signal = options.signal; return new Promise(r => resolve = r); };
  h.emit('before_agent_start'); h.emit('agent_settled'); await h.fire();
  h.emit('before_agent_start'); assert.equal(signal.aborted, true);
  resolve({ content: [{ type: 'text', text: 'stale' }] }); await new Promise(r => setImmediate(r));
  assert.equal(h.entries.length, 0);
});
test('provider failure is silent and not retried repeatedly', async t => {
  const h = harness(t); let calls = 0;
  h.ctx.modelRegistry.complete = async () => { calls++; throw Error('private provider error'); };
  h.emit('before_agent_start'); h.emit('agent_settled'); await h.fire(); h.emit('agent_settled'); await h.fire();
  assert.equal(calls, 1); assert.equal(h.entries.length, 0);
});
test('status shows timer and manual test displays summary without waiting', async t => {
  const h = harness(t);
  await h.command(); assert.match(h.notices.at(-1), /已加载/); assert.equal(h.calls.length, 0);
  h.emit('before_agent_start'); h.emit('agent_settled');
  await h.command(); assert.match(h.notices.at(-1), /倒计时/); assert.equal(h.timers.size, 1);
  await h.command('now'); assert.equal(h.calls.length, 1); assert.match(h.notices.at(-1), /已显示总结/);
  await h.fire(); assert.equal(h.calls.length, 1);
});
test('manual test reports empty output and errors without exposing bodies', async t => {
  const h = harness(t);
  h.ctx.modelRegistry.complete = async () => ({ content: [], stopReason: 'length' });
  await h.command('now'); assert.match(h.notices.at(-1), /未返回可显示文本/);
  h.ctx.modelRegistry.complete = async () => { throw Error('private secret'); };
  await h.command('now'); assert.match(h.notices.at(-1), /请求异常/); assert.doesNotMatch(h.notices.at(-1), /private secret/);
  h.ctx.mode = 'rpc'; await h.command('now'); assert.match(h.notices.at(-1), /不是/);
});
test('transcript renderer uses emoji labels and background without extra separator', t => {
  const h = harness(t);
  const text = '任务：核查 TP 交叉熵\n进展：已完成源码审查，尚未多卡实测。\n注意：long_function_name_' + 'x'.repeat(100) + '\n下一步：已完成，无待办';
  const md = summaryMarkdown(text);
  assert.ok(md.startsWith('**📝 上下文总结**'));
  assert.doesNotMatch(md, /^---$/m);
  assert.match(md, /🎯 \*\*任务：\*\*/);
  assert.match(md, /✅ \*\*进展：\*\*/);
  assert.match(md, /💡 \*\*注意：\*\*/);
  assert.match(md, /➡️ \*\*下一步：\*\*/);
  assert.doesNotMatch(md, /[╭╰│]/);
  const colors = [];
  const component = h.renderers['idle-work-summary']({ data: { text } }, {}, {
    bg: (color, s) => { colors.push(color); return `\x1b[48;5;236m${s}\x1b[0m`; },
  });
  for (const width of [16, 24, 40, 80, 120]) {
    const lines = component.render(width);
    assert.ok(lines.every(line => tui.visibleWidth(line) <= width), `width ${width}`);
    assert.ok(lines.some(line => line.includes('\x1b[48;5;236m')));
  }
  assert.ok(colors.every(color => color === 'customMessageBg'));
});
test('bounded text only, secrets and terminal control sequences redacted', () => {
  const text = workTranscript([
    { type: 'message', message: { role: 'toolResult', content: 'private tool output' } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'private thought' }, { type: 'text', text: 'api_key="very-secret-key"\nhttps://example.com/private' }] } },
  ]);
  assert.doesNotMatch(text, /private|very-secret/);
  assert.ok(workTranscript(Array.from({ length: 100 }, () => ({ type: 'message', message: { role: 'user', content: 'x'.repeat(5000) } }))).length <= 24000);
  assert.equal(redact('\x1b[31mhello\x1b[0m'), 'hello');
});
