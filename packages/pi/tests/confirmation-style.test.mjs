import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load, tui } from './helpers.mjs';

const { ConfirmFeedbackDialog } = await load('../safety-guard');
const theme = { fg: (_c, s) => s, bg: (_c, s) => s, bold: s => s };
const make = done => new ConfirmFeedbackDialog(theme, {}, done, '🧹 清空当前对话？', '当前会话文件仍会保留在磁盘上。', '✅ 是', '❌ 否');

test('confirmation uses questionnaire frame and fits narrow terminals', () => {
  const dialog = make(() => {});
  for (const width of [1, 5, 6, 20, 80, 140]) {
    const lines = dialog.render(width);
    assert.ok(lines.every(line => tui.visibleWidth(line) <= width));
    if (width >= 6) assert.ok(lines[0].startsWith('┌'));
    assert.doesNotMatch(lines.join('\n'), /[╭╰▶✅❌🧹]/u);
  }
  assert.match(dialog.render(80).join('\n'), /› 否/);
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
});
