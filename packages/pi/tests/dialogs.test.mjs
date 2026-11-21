import assert from 'node:assert/strict';
import test from 'node:test';
import { load, tui } from './helpers.mjs';
const { createInputCard, inputCard, selectCard } = await load('dialogs');
const { confirmPermission, showConfirmation } = await load('confirmation');
const theme = { fg: (_c, s) => s, bg: (_c, s) => s, bold: s => s };

test('input card preserves focus, Unicode paste, narrow widths and empty submission', () => {
 let value;
 const card = createInputCard(theme, x => { value = x; });
 card.focused = true;
 card.handleInput('\x1b[200~论文/main.tex\x1b[201~');
 for (const width of [1, 5, 6, 20, 80]) {
  const lines = card.render(width);
  assert.ok(lines.every(line => tui.visibleWidth(line) <= width));
  if (width >= 6) assert.ok(lines[0].startsWith('┌'));
 }
 assert.ok(card.render(80).join('\n').includes(tui.CURSOR_MARKER));
 card.handleInput('\r');
 assert.equal(value, '论文/main.tex');
 card.handleInput('\x03'); // Completion is idempotent.
 assert.equal(value, '论文/main.tex');
 createInputCard(theme, x => { value = x; }).handleInput('\r');
 assert.equal(value, '');
});

test('input escape and ctrl+c cancel; selection uses card and cancels safely', async () => {
 for (const key of ['\x1b', '\x03']) {
  const ctx = { hasUI: true, mode: 'tui', ui: { custom: factory => new Promise(resolve => {
   const card = factory({ terminal: { rows: 24 }, requestRender() {} }, theme, {}, resolve);
   assert.match(card.render(80).join('\n'), /┌/);
   card.handleInput(key);
  }) } };
  assert.equal(await inputCard(ctx, '目标'), undefined);
  assert.equal(await selectCard(ctx, '类型', ['code', 'paper']), undefined);
 }
});

test('RPC uses supported native dialogs, headless never prompts', async () => {
 const ctx = { hasUI: true, mode: 'rpc', ui: {
  select: async () => 'paper', input: async () => 'main.tex',
  custom() { assert.fail('RPC cannot draw terminal cards'); },
 } };
 assert.equal(await selectCard(ctx, 'type', ['code', 'paper']), 'paper');
 assert.equal(await inputCard(ctx, 'entry'), 'main.tex');
 assert.equal(await inputCard({ hasUI: false }, 'entry'), undefined);
 assert.equal(await selectCard({ hasUI: false }, 'type', ['code']), undefined);
});

test('TUI permissions require a decision in the current session', async () => {
 let prompted = 0;
 const ctx = { hasUI: true, mode: 'tui', ui: {
  confirm: () => assert.fail('TUI permissions must use the local card'),
  custom: async () => ({ allow: ++prompted === 2 }),
 } };
 assert.equal(await confirmPermission(ctx, 'Trust agent', 'body'), false);
 assert.equal(await confirmPermission(ctx, 'Trust agent', 'body'), true);
});

test('RPC late consent after abort cannot authorize', async () => {
 const controller = new AbortController();
 const ctx = { hasUI: true, mode: 'rpc', ui: { confirm: async () => { controller.abort(); return true; } } };
 assert.deepEqual(await showConfirmation(ctx, 'title', 'body', undefined, controller.signal), { allow: false });
});
