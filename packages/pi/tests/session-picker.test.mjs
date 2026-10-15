import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load, tui } from './helpers.mjs';
const { createSessionPicker } = await load('herdr-fork/picker');
const theme = { bold: text => text, fg: (_color, text) => text, bg: (_color, text) => text };
const host = () => ({ terminal: { rows: 24 }, requestRender() {} });

test('session card has no input and fits narrow widths', () => {
  const picker = createSessionPicker(host(), theme, () => {}, ['中文会话', 'other']);
  for (const width of [1, 6, 20, 80]) {
    const lines = picker.render(width);
    assert.equal(lines[0], '');
    for (const line of lines) assert.ok(tui.visibleWidth(line) <= width);
    assert.ok(!lines.join('\n').includes('搜索'));
    if (width >= 6) {
      assert.ok(lines[1].startsWith('┌'));
      assert.ok(lines.at(-1).startsWith('└'));
      for (const line of lines.slice(1)) assert.equal(tui.visibleWidth(line), width);
    }
  }
});

test('arrows navigate without submitting; typing ignored; Enter submits only once', () => {
  const results = [];
  const picker = createSessionPicker(host(), theme, value => results.push(value), ['first', 'second', 'third']);
  picker.handleInput('\x1b[D'); // left clamps at beginning
  picker.handleInput('\x1b[C'); // right
  picker.handleInput('\x1b[B'); // down
  picker.handleInput('\x1b[C'); // right clamps at end
  picker.handleInput('\x1b[D'); // left
  picker.handleInput('\x1b[A'); // up
  picker.handleInput('third'); // no search input
  assert.deepEqual(results, []);
  picker.handleInput('\r');
  picker.handleInput('\r');
  assert.deepEqual(results, ['first']);
});

test('viewport follows selection and Esc cancels', () => {
  const results = [];
  const picker = createSessionPicker(host(), theme, value => results.push(value), Array.from({ length: 60 }, (_, i) => `session-${i + 1}`));
  picker.handleInput('\x1b[C');
  assert.ok(picker.render(76).join('\n').includes('11/60'));
  picker.handleInput('\x1b[B');
  assert.ok(picker.render(76).join('\n').includes('12/60'));
  picker.handleInput('\x1b[D');
  assert.ok(picker.render(76).join('\n').includes('2/60'));
  picker.handleInput('\x1b[D');
  assert.ok(picker.render(76).join('\n').includes('1/60'));
  for (let i = 0; i < 6; i++) picker.handleInput('\x1b[C');
  const lines = picker.render(76).join('\n');
  assert.ok(lines.includes('60/60'));
  assert.ok(lines.includes('session-60'));
  assert.ok(!lines.includes('session-1 '));
  picker.handleInput('\x1b');
  assert.deepEqual(results, [undefined]);
});

test('empty list cannot submit', () => {
  const results = [];
  const picker = createSessionPicker(host(), theme, value => results.push(value), []);
  picker.handleInput('\x1b[C');
  picker.handleInput('\r');
  assert.deepEqual(results, []);
  assert.ok(picker.render(76).join('\n').includes('0/0'));
  picker.handleInput('\x1b');
  assert.deepEqual(results, [undefined]);
});
