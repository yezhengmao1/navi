import test from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { load, tui, root } from './helpers.mjs';
const { initTheme } = await import(`${root}/dist/modes/interactive/theme/theme.js`);
initTheme('dark', false);
const { default: register } = await load('../../../../.pi/extensions/agent-team/index');
let tool;
register({ registerTool(value) { if (value.name === 'subagent') tool = value; }, registerCommand() {}, on() {}, events: { emit() {} } });
const background = '\x1b[48;5;234m';
const theme = { fg: (_color, value) => value, bold: value => value, bg: (_color, value) => background + value + '\x1b[49m' };
const member = {
  agent: 'implement', agentSource: 'user', task: 'Implement workspace discovery.', exitCode: 0,
  messages: [
    {role: 'assistant', content: [{type: 'toolCall', name: 'read', arguments: {path: 'plugins/example/package.json'}}]},
    {role: 'assistant', content: [{type: 'text', text: 'Implemented workspace discovery.\n\n- Added operations.\n\n```ts\nconst verified = true;\n```'}]},
  ],
  usage: {input: 100000, output: 1000, cacheRead: 78000, cacheWrite: 0, turns: 1, cost: 0},
};
const render = (result = member, expanded = false, width = 100) => {
  const state = {};
  const view = tool.renderResult({content: [], details: {mode: 'single', results: [result]}}, {expanded}, theme, {state});
  const lines = view.render(width);
  return {lines, text: stripVTControlCharacters(lines.join('\n')), state, view};
};

test('registered single renderer uses the shared dashed card, usage and collapsed summary', () => {
  const {lines, text, state} = render();
  assert.match(text, /┌╌+┐/); assert.match(text, /✅ 已完成 · implement · 17.9万 词元/);
  assert.match(text, /Implemented workspace discovery/); assert.match(text, /Ctrl\+O 展开/);
  assert.doesNotMatch(text, /earlier items|\(user\)|→ read|package.json|任务 1|步骤 1|const verified|─── Task/);
  assert.equal(state.subagentUsage, '17.9万 词元');
  for (const line of lines) { assert.ok(line.startsWith(background)); assert.equal(tui.visibleWidth(line), 100); }
});

test('expanded single renderer keeps original task section, tool trace and full Markdown result', () => {
  const {text} = render(member, true);
  assert.match(text, /🎯 任务/); assert.match(text, /Implement workspace discovery\./);
  assert.match(text, /🛠️ 执行记录 · 1 次/); assert.match(text, /plugins\/example\/package.json/);
  assert.match(text, /const verified = true/); assert.match(text, /Ctrl\+O 收起/);
  assert.ok(text.indexOf('🎯 任务') < text.indexOf('🛠️ 执行记录'));
  assert.ok(text.indexOf('🛠️ 执行记录') < text.indexOf('📋 结果'));
});

test('single running, failed and empty results use Chinese states and fit narrow terminals', () => {
  const running = render({...member, exitCode: -1, messages: []});
  assert.match(running.text, /执行中/); assert.match(running.text, /等待成员输出/);
  const failed = render({...member, exitCode: 1, errorMessage: 'Request failed', messages: []});
  assert.match(failed.text, /失败原因/); assert.match(failed.text, /Request failed/);
  assert.match(render({...member, messages: []}).text, /暂无文字结果/);
  for (const width of [0, 1, 5, 12, 40]) for (const line of failed.view.render(width)) assert.ok(tui.visibleWidth(line) <= width);
});
