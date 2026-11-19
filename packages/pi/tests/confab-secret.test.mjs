import test from 'node:test';
import assert from 'node:assert/strict';
import { load, tui } from './helpers.mjs';
const { promptConfabKey } = await load('confab-secret');
function harness() {
  let component;
  const controller = new AbortController();
  const ctx = { mode: 'tui', hasUI: true, ui: { custom: factory => new Promise(resolve => {
    component = factory({ requestRender() {} }, { fg: (_c, s) => s, bg: (_c, s) => s, bold: s => s }, {}, resolve);
  }) } };
  const result = promptConfabKey(ctx, controller.signal);
  return { component, controller, result };
}
test('secret input masks typing and bracketed paste at all widths', async () => {
  const h = harness();
  h.component.handleInput('\x1b[200~private-api-key\x1b[201~');
  for (const width of [1, 12, 80]) {
    const lines = h.component.render(width);
    assert.doesNotMatch(lines.join(''), /private-api-key/);
    assert.ok(lines.every(line => tui.visibleWidth(line) <= width));
  }
  assert.match(h.component.render(80).join(''), /\*+/);
  h.component.handleInput('\r');
  assert.equal(await h.result, 'private-api-key');
  assert.doesNotMatch(h.component.render(80).join(''), /\*/);
});
test('escape and lifecycle abort cancel without returning a secret', async () => {
  for (const abort of [false, true]) {
    const h = harness();
    h.component.handleInput('private-key');
    if (abort) h.controller.abort(); else h.component.handleInput('\x1b');
    assert.equal(await h.result, undefined);
    assert.doesNotMatch(h.component.render(80).join(''), /private-key|\*/);
  }
});
test('questionnaire card offers submit and cancel actions with keyboard navigation', async () => {
  const h = harness();
  const lines = h.component.render(80).join('\n');
  assert.match(lines, /┌/); assert.match(lines, /确认提交/); assert.match(lines, /取消/);
  h.component.handleInput('private-key');
  h.component.handleInput('\t'); h.component.handleInput('\t');
  h.component.handleInput('\r');
  assert.equal(await h.result, undefined);
  const submit = harness();
  submit.component.handleInput('private-key'); submit.component.handleInput('\t'); submit.component.handleInput('\r');
  assert.equal(await submit.result, 'private-key');
});
test('typing or split paste on action focus is not silently discarded', async () => {
  for (const paste of [false, true]) {
    const h = harness(); h.component.handleInput('\t');
    if (paste) {
      h.component.handleInput('\x1b[200~');
      h.component.handleInput('private-key');
      h.component.handleInput('\x1b[201~');
    } else h.component.handleInput('private-key');
    assert.match(h.component.render(80).join(''), /已输入 11 个字符/);
    h.component.handleInput('\r');
    assert.equal(await h.result, 'private-key');
  }
});
test('invalid key is not misleadingly reported as empty', async () => {
  const h = harness(); h.component.handleInput('key with spaces'); h.component.handleInput('\r');
  assert.match(h.component.render(80).join(''), /含空白或控制字符/);
  assert.doesNotMatch(h.component.render(80).join(''), /尚未收到密钥/);
  h.controller.abort(); await h.result;
});
test('empty input stays open and supports retry', async () => {
  const h = harness();
  h.component.handleInput('\r');
  assert.match(h.component.render(80).join(''), /尚未收到密钥/);
  h.component.handleInput('valid-key'); h.component.handleInput('\r');
  assert.equal(await h.result, 'valid-key');
});
