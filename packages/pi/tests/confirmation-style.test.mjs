import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load, tui } from './helpers.mjs';

const { ConfirmFeedbackDialog, showConfirmation } = await load('confirmation');
const theme = { fg: (_c, s) => s, bg: (_c, s) => s, bold: s => s };
const make = done => new ConfirmFeedbackDialog(theme, {}, done, '🧹 清空当前对话？', '这将开始一个新会话，并从模型上下文中清除当前对话。', '✅ 是', '❌ 否');

test('confirmation uses questionnaire frame and fits narrow terminals', () => {
  const dialog = make(() => {});
  for (const width of [1, 5, 6, 20, 80, 140]) {
    const lines = dialog.render(width);
    assert.ok(lines.every(line => tui.visibleWidth(line) <= width));
    if (width >= 6) assert.ok(lines[0].startsWith('┌'));
    assert.doesNotMatch(lines.join('\n'), /[╭╰▶✅❌🧹]/u);
  }
  assert.match(dialog.render(80).join('\n'), /› 否/);
  assert.doesNotMatch(dialog.render(140).join('\n'), /操作|当前会话文件仍会保留/);
});

test('confirmation footer uses questionnaire wording on a single responsive line', () => {
  const dialog = make(() => {});
  for (const width of [60, 80, 140]) {
    const lines = dialog.render(width);
    const hints = lines.filter(line => line.includes('↑↓'));
    assert.equal(hints.length, 1);
    assert.match(hints[0], /Enter 提交 · Esc 取消/);
    assert.doesNotMatch(lines.join('\n'), /确认当前操作|Esc 拒绝/);
  }
  assert.match(dialog.render(140).join('\n'), /↑↓\/Tab 移动 · 反馈行输入文字 · Enter 提交 · Esc 取消/);
});

test('default rejects, explicit approval works, feedback and escape stay safe', () => {
  let result;
  const done = value => { result = value; };
  make(done).handleInput('\r');
  assert.deepEqual(result, { allow: false, feedback: undefined });
  const yes = make(done);
  yes.handleInput('\x1b[A');
  yes.handleInput('\r');
  assert.deepEqual(result, { allow: true });
  const feedback = make(done);
  feedback.focused = true;
  feedback.handleInput('\t');
  assert.ok(feedback.render(80).join('\n').includes(tui.CURSOR_MARKER));
  feedback.handleInput('不');
  feedback.handleInput('\r');
  assert.deepEqual(result, { allow: false, feedback: '不' });
  feedback.handleInput('\x1b');
  assert.deepEqual(result, { allow: false, feedback: undefined });
  make(done).handleInput('\x03');
  assert.deepEqual(result, { allow: false, feedback: undefined });
});

test('shared confirmation denies without UI or after abort and closes pending dialog', async () => {
  const controller = new AbortController();
  let dialog;
  const ctx = { hasUI: true, mode: 'tui', ui: {
    custom: factory => new Promise(resolve => { dialog = factory({}, theme, {}, resolve); }),
  } };
  const pending = showConfirmation(ctx, '高危审批', '完整操作', undefined, controller.signal);
  assert.ok(dialog instanceof ConfirmFeedbackDialog);
  controller.abort();
  assert.deepEqual(await pending, { allow: false });
  assert.deepEqual(await showConfirmation({ hasUI: false }, 'title', 'body'), { allow: false });
  assert.deepEqual(await showConfirmation(ctx, 'title', 'body', undefined, controller.signal), { allow: false });
});

test('shared confirmation returns rejection feedback and uses RPC fallback only in RPC', async () => {
  const ctx = { hasUI: true, mode: 'tui', ui: {
    custom: factory => new Promise(resolve => {
      const dialog = factory({}, theme, {}, resolve);
      dialog.handleInput('\t');
      dialog.handleInput('不');
      dialog.handleInput('\r');
    }),
  } };
  assert.deepEqual(await showConfirmation(ctx, '审批', '操作'), { allow: false, feedback: '不' });
  const rpc = { hasUI: true, mode: 'rpc', ui: { confirm: async () => false } };
  assert.deepEqual(await showConfirmation(rpc, '审批', '操作'), { allow: false });
});
