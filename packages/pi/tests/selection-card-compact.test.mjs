import test from 'node:test';
import assert from 'node:assert/strict';
import { load, tui } from './helpers.mjs';
const { renderSelectionCard } = await load('editor-footer');
const theme = {
  fg: (_c, text) => `\x1b[36m${text}\x1b[39m`,
  bg: (_c, text) => text,
  bold: text => `\x1b[1m${text}\x1b[22m`,
};
const plain = text => text.replace(/\x1b\[[0-9;]*m/g, '');
const card = {
  theme, title: '来源', items: [], cursor: -1, compact: true,
  actions: [{label: '查看详情'}, {label: '取消', active: true}],
  hints: ['↑↓ 移动 · 空格选择 · Enter 取消 · Esc 取消', '↑↓ / 空格 · ↵ 取消'],
};

test('compact actions stay left and the longest fitting hint is right-aligned on the same row', () => {
  for (const [width, hint] of [[100, card.hints[0]], [44, card.hints[1]]]) {
    const lines = renderSelectionCard({...card, width}).map(plain);
    const footer = lines.find(line => line.includes('查看详情'));
    assert.ok(footer.includes('› 取消'));
    assert.ok(footer.endsWith(`${hint} │`));
    assert.equal(lines.filter(line => line.includes('↑↓')).length, 1);
    assert.equal(lines.indexOf(footer), lines.length - 2);
    assert.equal(tui.visibleWidth(footer), width);
  }
});

test('compact footer reserves button columns across narrow widths and ANSI/wide labels', () => {
  for (let width = 1; width <= 120; width++) {
    const lines = renderSelectionCard({...card, width});
    assert.ok(lines.every(line => tui.visibleWidth(line) <= width), `width ${width}`);
    if (width >= 23) {
      const footer = lines.map(plain).find(line => line.includes('查看详情'));
      assert.match(footer, /查看详情\s+› 取消/);
      assert.equal(lines.indexOf(lines.find(line => plain(line) === footer)), lines.length - 2);
    }
  }
});

test('empty actions retain compact hints; noncompact actions retain separate hint rows', () => {
  for (const actions of [undefined, []]) {
    assert.ok(renderSelectionCard({...card, width: 100, actions}).map(plain).some(line => line.includes(card.hints[0])));
  }
  const lines = renderSelectionCard({...card, width: 100, compact: false}).map(plain);
  assert.ok(!lines.find(line => line.includes('查看详情')).includes('↑↓'));
  assert.ok(lines.some(line => line.includes(card.hints[0])));
});
