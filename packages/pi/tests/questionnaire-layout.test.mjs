import test from 'node:test';
import assert from 'node:assert/strict';
import {load, tui} from './helpers.mjs';
const {default: register} = await load('questionnaire');
let tool;
register({registerTool(value) {tool = value;}, events: {emit() {}}});
const theme = {fg: (_c, text) => text, bg: (_c, text) => text, bold: text => text};
const down = '\x1b[B';
function open(questions, rows = 18) {
  let view;
  const terminal = {rows};
  const pending = tool.execute('layout', {title: '确认选项', questions}, undefined, undefined,
    {mode: 'tui', ui: {custom: factory => new Promise(resolve => {
      view = factory({terminal, requestRender() {}}, theme, {}, resolve);
    })}});
  return {view, terminal, pending};
}

test('questionnaire keeps actions visible while options scroll within terminal height', async () => {
  const options = Array.from({length: 30}, (_, i) => ({value: String(i), label: `选项-${i}`}));
  const {view, pending} = open([{id: 'choice', prompt: '请选择', type: 'single', options}]);
  for (let i = 0; i <= 31; i++) {
    for (const width of [24, 40, 100]) {
      const lines = view.render(width), text = lines.join('\n');
      assert.ok(lines.length <= 14);
      for (const line of lines) assert.ok(tui.visibleWidth(line) <= width);
      assert.match(text, /确认提交/); assert.match(text, /取消/);
      const footer = lines.find(line => line.includes('确认提交'));
      assert.match(footer, /取消/);
      if (width === 100) {
        assert.match(footer, /Enter/);
        assert.equal(lines.filter(line => line.includes('Enter') || line.includes('↵')).length, 1);
      }
      assert.equal(lines.indexOf(footer), lines.length - 2);
    }
    if (i < 31) view.handleInput(down);
  }
  assert.match(view.render(100).join('\n'), /› 取消/);
  view.handleInput('\r');
  assert.deepEqual((await pending).details, {cancelled: true, answers: {}, reason: '用户取消'});
});

test('many question groups and long validation warnings cannot push actions off screen', async () => {
  const questions = Array.from({length: 12}, (_, i) => ({id: `q${i}`, prompt: '很长的问题'.repeat(12), type: 'single', options: [{value: 'yes', label: '选择'}]}));
  const {view, pending} = open(questions, 18);
  view.render(40); view.handleInput('\r');
  const lines = view.render(40);
  assert.ok(lines.length <= 14); assert.match(lines.join('\n'), /请选择/);
  assert.match(lines.join('\n'), /确认提交/);
  view.handleInput('\x1b'); await pending;
});

test('tiny terminal cannot accidentally submit and resizing restores normal controls', async () => {
  const {view, terminal, pending} = open([{id: 'ok', prompt: '同意', type: 'confirm', default: true}], 8);
  assert.match(view.render(40).join('\n'), /窗口过小/);
  view.handleInput('\r');
  terminal.rows = 24; assert.match(view.render(80).join('\n'), /确认提交/);
  view.handleInput('\x1b');
  assert.deepEqual((await pending).details.answers, {});
});
