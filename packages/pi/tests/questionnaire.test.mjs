import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load, tui } from './helpers.mjs';
const { default: register, validateQuestions } = await load('questionnaire');
let tool;
let renderer;
register({ registerTool(t) { tool = t; }, events: { emit(_name, card) { renderer?.(card); } } });
const multi = { id: 'colors', prompt: '颜色', type: 'multiple', min: 1,
  options: [{ value: 'red', label: '红' }, { value: 'blue', label: '蓝' }], default: ['red'] };
const down = '\x1b[B', enter = '\r';
async function run(questions, keys, { mode = 'tui', abort = false, preAbort = false } = {}) {
  const controller = new AbortController();
  if (preAbort) controller.abort();
  let frame;
  const ctx = { mode, ui: { custom: factory => new Promise((resolve, reject) => {
    let finished = false;
    const component = factory({ requestRender() {} }, { fg: (_c, s) => s }, {}, v => { finished = true; resolve(v); });
    for (const width of [0, 1, 12, 40, 100]) {
      for (const line of component.render(width)) assert.ok(tui.visibleWidth(line) <= width);
    }
    for (const key of keys) component.handleInput(key);
    if (abort) controller.abort();
    frame = component.render(60).join('\n');
    component.dispose?.();
    if (!finished) reject(new Error(`Test did not complete: ${frame}`));
  }) } };
  const r = await tool.execute('test', { title: '通用问卷', questions }, controller.signal, undefined, ctx);
  assert.deepEqual(JSON.parse(r.content[0].text), r.details);
  return r.details;
}

test('generic multiple + confirm defaults, explicit submit', async () => {
  assert.equal(tool.exposure, 'model-only');
  assert.deepEqual(await run([multi, { id: 'save', prompt: '保存', type: 'confirm' }], [enter]),
    { cancelled: false, answers: { colors: ['red'], save: false } });
});
test('multiple selection, boolean toggle, no implicit submit on space', async () => {
  const r = await run([multi, { id: 'save', prompt: '保存', type: 'confirm' }], [down, ' ', down, ' ', enter]);
  assert.deepEqual(r.answers, { colors: ['red', 'blue'], save: true });
});
test('single selection required, later choice replaces previous choice', async () => {
  const single = { ...multi, type: 'single', default: undefined };
  const r = await run([single], [enter, ' ', down, ' ', enter]);
  assert.equal(r.answers.colors, 'blue');
});
test('empty selection blocked; a only affects current multiple question', async () => {
  const r = await run([multi], ['a', 'a', enter, ' ', enter]);
  assert.deepEqual(r.answers.colors, ['red']);
});
test('max constraint blocks submission', async () => {
  const r = await run([{ ...multi, max: 1 }], ['a', enter, ' ', enter]);
  assert.deepEqual(r.answers.colors, ['blue']);
});
test('cancellation always drops draft answers', async () => {
  for (const opts of [{ keys: ['\x1b'] }, { keys: [down, down, down, enter] },
    { keys: [], abort: true }, { keys: [], preAbort: true }]) {
    const r = await run([multi], opts.keys, opts);
    assert.equal(r.cancelled, true); assert.deepEqual(r.answers, {});
  }
});
test('non-TUI never treats defaults as consent', async () => {
  for (const mode of ['rpc', 'json', 'print']) {
    const r = await run([multi], [], { mode });
    assert.equal(r.cancelled, true); assert.deepEqual(r.answers, {});
  }
});
test('reject invalid IDs, options, defaults, counts', () => {
  for (const qs of [[], [multi, multi], [{ ...multi, default: ['bad'] }],
    [{ ...multi, options: [multi.options[0], multi.options[0]] }], [{ ...multi, min: 3 }],
    [{ ...multi, max: 0 }], [{ ...multi, default: ['red', 'red'] }]]) {
    assert.throws(() => validateQuestions(qs));
  }
});
test('scrollable list remains usable beyond viewport', async () => {
  const options = Array.from({ length: 20 }, (_, i) => ({ value: `${i}`, label: `选项 ${i}` }));
  const r = await run([{ id: 'long', prompt: '长列表', type: 'single', options }], [...Array(19).fill(down), ' ', enter]);
  assert.equal(r.answers.long, '19');
});
test('optional shared card renderer receives generic questions', async () => {
  let calls = 0;
  renderer = card => { calls++; assert.equal(card.title, '通用问卷'); card.lines = ['X'.slice(0, card.width)]; };
  try { await run([multi], [enter]); assert.ok(calls > 0); } finally { renderer = undefined; }
});
