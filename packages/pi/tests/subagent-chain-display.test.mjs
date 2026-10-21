import test from 'node:test';
import assert from 'node:assert/strict';
import { load, tui } from './helpers.mjs';
const { renderChainCards, formatSubagentUsage, paintCardBackground, subagentCallHeader, updateSubagentHeaderUsage } = await load('../../../../.pi/extensions/agent-team/chain-display');
const theme = { fg: (_color, text) => text, bg: (_color, text) => text };
const mdTheme = Object.fromEntries(['heading', 'link', 'linkUrl', 'code', 'codeBlock', 'codeBlockBorder', 'quote', 'quoteBorder', 'hr', 'listBullet', 'bold', 'italic', 'strikethrough', 'underline'].map(key => [key, text => text]));
const cards = [
  { agent: 'capture-init-fix', step: 1, task: '修复初始化', status: 'completed', output: '已完成最小修复。\n\n```python\nx.fill_(0)\n```', tools: ['read source.py', 'python -m pytest'], usage: '3000 词元' },
  { agent: 'capture-init-check', step: 2, task: '独立验收', status: 'failed', output: '', error: '模型请求超时', tools: ['read patch.diff'], usage: '2000 词元' },
];

test('collapsed chain separates steps into full-width cards with summaries, errors and no duplicate overview', () => {
  const lines = renderChainCards(cards, 2, '5 turns', false, theme, mdTheme).render(100);
  const text = lines.join('\n');
  assert.doesNotMatch(text, /串行任务|步完成/); assert.match(text, /步骤 1 · capture-init-fix/);
  assert.match(text, /步骤 2 · capture-init-check/); assert.match(text, /模型请求超时/);
  assert.match(text, /已完成最小修复/); assert.doesNotMatch(text, /python -m pytest|read patch.diff|x.fill_|earlier items/);
  assert.equal(lines.filter(line => line.startsWith('┌')).length, 2);
  const ends = lines.map((line, index) => line.startsWith('└') ? index : -1).filter(i => i >= 0);
  assert.equal(lines[ends[0] + 1].trim(), ''); assert.match(lines[ends[0] + 2], /^┌/);
  assert.doesNotMatch(text, /📊|总用量/);
  assert.match(text, /步骤 1 · capture-init-fix · 3000 词元/);
  assert.match(text, /步骤 2 · capture-init-check · 2000 词元/);
  for (const line of lines.filter(line => /^[╎┌└]/.test(line))) assert.equal(tui.visibleWidth(line), 100);
});

test('parallel results use compact separate cards and Chinese labels with space around the overview', () => {
  const parallel = [0, 1, 2].map(i => ({ ...cards[0], agent: `ui-${i}`, step: i + 1, output: '**模拟结果**\n\n1. **正确性**：检查边界条件。' }));
  const lines = renderChainCards(parallel, 3, '3 轮', false, theme, mdTheme, 'parallel').render(100);
  const text = lines.join('\n');
  assert.doesNotMatch(text, /并行任务|项完成/);
  assert.match(text, /┌╌+┐/); assert.match(text, /╎/);
  assert.equal(lines.filter(line => line.startsWith('┌')).length, 3);
  assert.equal(lines[0].trim(), '', 'call heading separated from cards');
  assert.match(text, /任务 1 · ui-0/); assert.match(text, /任务 3 · ui-2/);
  assert.doesNotMatch(text, /parallel|subagent|\*\*|─── ui-/);
  const start = lines.findIndex(line => line.startsWith('┌'));
  assert.match(lines[start + 1], /✅ 已完成/, 'no empty padding row before details');
  const end = lines.findIndex(line => line.startsWith('└'));
  assert.ok(lines[end - 1].replace(/[╎\s]/g, '').length > 0, 'no empty padding row after details');
  assert.match(lines[start + 1], /3000 词元/);
  assert.doesNotMatch(text, /📊|总用量/);
  assert.equal(lines[end + 1].trim(), '', 'cards separated by a blank line');
});

test('call header tracks the shared per-call cumulative usage, without a chart emoji', () => {
  const state = {}, other = {};
  const header = subagentCallHeader(() => `🤝 并行任务 · ${state.subagentProgress ?? '0/2 项完成'} [用户配置]`, theme, () => state.subagentUsage);
  assert.doesNotMatch(header.render(120).join('\n'), /词元/);
  updateSubagentHeaderUsage(state, [{ exitCode: 0, usage: { input: 4700, output: 91 } }, { exitCode: 0, usage: { input: 4700, output: 69 } }], { total: 2, unit: '项' });
  const text = header.render(120).join('\n');
  assert.match(text.split('\n')[0], /🤝 并行任务 · 2\/2 项完成 \[用户配置\] · 9560 词元/);
  assert.equal(header.render(120).length, 1);
  assert.doesNotMatch(text, /📊|总用量/);
  assert.equal(other.subagentUsage, undefined);
  updateSubagentHeaderUsage(state, [{ usage: { input: 10000 } }]);
  assert.match(header.render(120).join('\n'), /1.0万 词元/);
  for (const width of [1, 8, 40]) for (const line of header.render(width)) assert.ok(tui.visibleWidth(line) <= width);
  updateSubagentHeaderUsage(state, []);
  assert.doesNotMatch(header.render(120).join('\n'), /词元/);
});

test('unified header progress separates completed, failed and running results', () => {
  const state = {};
  updateSubagentHeaderUsage(state, [
    { exitCode: 0, usage: {} },
    { exitCode: 0, stopReason: 'error', usage: {} },
    { exitCode: -1, usage: {} },
  ], { total: 3, unit: '项' });
  assert.equal(state.subagentProgress, '1/3 项完成 · 1 失败 · 1 执行中');
});

test('usage shows only actual cumulative Chinese token totals, not context, cost or model', () => {
  assert.equal(formatSubagentUsage({ input: 4000, output: 64, cacheRead: 700, cacheWrite: 36, contextTokens: 999999, cost: 123 }), '4800 词元');
  assert.equal(formatSubagentUsage({ input: 17000000, output: 109000 }), '1710.9万 词元');
  assert.equal(formatSubagentUsage({ input: 199000000 }), '1.99亿 词元');
  assert.equal(formatSubagentUsage({}), '0 词元');
});

test('uniform background survives Markdown resets, code backgrounds and OSC links', () => {
  const bg = '\x1b[48;5;234m';
  const themed = { ...theme, bg: (_color, text) => bg + text + '\x1b[49m' };
  const line = '\x1b[31m标题\x1b[0m 普通 \x1b[44m代码\x1b[49m \x1b]8;;https://example.com\x07链接\x1b]8;;\x07';
  const painted = paintCardBackground(line, themed);
  for (const reset of ['\x1b[0m', '\x1b[44m', '\x1b[31m']) assert.ok(painted.includes(reset + bg));
  assert.equal(tui.visibleWidth(painted), tui.visibleWidth(line));
  assert.ok(painted.includes('\x1b]8;;https://example.com\x07'));
  const rendered = renderChainCards(cards, 2, '4800 词元', false, themed, mdTheme).render(100);
  for (const row of rendered) {
    assert.ok(row.startsWith(bg));
    assert.equal(tui.visibleWidth(row), 100, 'headers, cards and blank separators share a full-width background');
  }
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
  assert.doesNotMatch(view.render(100).join('\n'), /步未执行/);
  assert.match(view.render(100).join('\n'), /不能据此认定代码或测试失败/);
  for (const width of [1, 5, 12, 40, 100]) for (const line of view.render(width)) assert.ok(tui.visibleWidth(line) <= width);
  const running = renderChainCards([{ ...cards[0], status: 'running', output: '' }], 2, '', false, theme, mdTheme).render(100).join('\n');
  assert.doesNotMatch(running, /步完成/); assert.match(running, /执行中/); assert.doesNotMatch(running, /❌/);
});
