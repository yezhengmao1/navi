import test from 'node:test';
import assert from 'node:assert/strict';
import { load, tui } from './helpers.mjs';
const { renderChainCards } = await load('../../../../.pi/extensions/agent-team/chain-display');
const theme = { fg: (_color, text) => text, bg: (_color, text) => text };
const mdTheme = Object.fromEntries(['heading', 'link', 'linkUrl', 'code', 'codeBlock', 'codeBlockBorder', 'quote', 'quoteBorder', 'hr', 'listBullet', 'bold', 'italic', 'strikethrough', 'underline'].map(key => [key, text => text]));
const cards = [
  { agent: 'capture-init-fix', step: 1, task: '修复初始化', status: 'completed', output: '已完成最小修复。\n\n```python\nx.fill_(0)\n```', tools: ['read source.py', 'python -m pytest'], usage: '3 turns' },
  { agent: 'capture-init-check', step: 2, task: '独立验收', status: 'failed', output: '', error: '模型请求超时', tools: ['read patch.diff'], usage: '2 turns' },
];

test('collapsed chain separates steps into full-width cards with summaries, errors and a separate total', () => {
  const lines = renderChainCards(cards, 2, '5 turns', false, theme, mdTheme).render(100);
  const text = lines.join('\n');
  assert.match(text, /1\/2 步完成/); assert.match(text, /步骤 1 · capture-init-fix/);
  assert.match(text, /步骤 2 · capture-init-check/); assert.match(text, /模型请求超时/);
  assert.match(text, /已完成最小修复/); assert.doesNotMatch(text, /python -m pytest|read patch.diff|x.fill_|earlier items/);
  assert.equal(lines.filter(line => line.startsWith('┌')).length, 2);
  const ends = lines.map((line, index) => line.startsWith('└') ? index : -1).filter(i => i >= 0);
  assert.equal(lines[ends[0] + 1].trim(), ''); assert.match(lines[ends[0] + 2], /^┌/);
  assert.ok(text.indexOf('📊 总用量') > text.lastIndexOf('└'));
  for (const line of lines.filter(line => /^[│┌└]/.test(line))) assert.equal(tui.visibleWidth(line), 100);
});

test('expanded chain sections distinguish task, execution trace, output and usage', () => {
  const text = renderChainCards(cards, 2, '5 turns', true, theme, mdTheme).render(100).join('\n');
  assert.match(text, /🎯 任务/); assert.match(text, /🛠️ 执行记录/); assert.match(text, /📋 结果/);
  assert.match(text, /python -m pytest/); assert.match(text, /x.fill_\(0\)/);
  assert.ok(text.indexOf('🎯 任务') < text.indexOf('🛠️ 执行记录'));
  assert.ok(text.indexOf('🛠️ 执行记录') < text.indexOf('📋 结果'));
});

test('chain cards fit narrow Unicode widths and do not imply tests failed without evidence', () => {
  const failed = { ...cards[1], error: undefined };
  const view = renderChainCards([failed], 3, '', false, theme, mdTheme);
  assert.match(view.render(100).join('\n'), /2 步未执行/);
  assert.match(view.render(100).join('\n'), /不能据此认定代码或测试失败/);
  for (const width of [1, 5, 12, 40, 100]) for (const line of view.render(width)) assert.ok(tui.visibleWidth(line) <= width);
  const running = renderChainCards([{ ...cards[0], status: 'running', output: '' }], 2, '', false, theme, mdTheme).render(100).join('\n');
  assert.match(running, /0\/2 步完成/); assert.match(running, /执行中/); assert.doesNotMatch(running, /❌/);
});
