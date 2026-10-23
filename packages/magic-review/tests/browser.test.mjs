import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

// No Pi host imports: exercise the component contract using a deterministic TUI mock.
const source = await readFile(new URL('../extensions/browser.ts', import.meta.url), 'utf8');
const mock = `
const Key = { escape: 'escape', up: 'up', down: 'down', enter: 'enter' };
const matchesKey = (data, key) => data === key;
const visibleWidth = text => [...text].reduce((n, c) => n + columns(c), 0);
const columns = c => /[^\\x00-\\x7f]/u.test(c) ? 2 : 1;
const truncateToWidth = (text, width) => { let out = ''; for (const c of text) { width -= columns(c); if (width < 0) break; out += c; } return out; };
const wrapTextWithAnsi = (text, width) => { const rows = []; let row = '', used = 0; for (const c of text) { const n = columns(c); if (used + n > width) { rows.push(row); row = ''; used = 0; } row += c; used += n; } rows.push(row); return rows; };
`;
const js = stripTypeScriptTypes(source).replace(/import \{[^}]*\} from '@earendil-works\/pi-tui';/, mock);
const { browseReview, widgetLines, reviewWidget } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const run = { state: 'completed', stage: 'review', calls: 2, budget: { maxCalls: 8, maxTokens: 1000, timeoutMs: 10000 },
  usage: { totalTokens: 42, cost: 0.01 }, findings: Array.from({ length: 25 }, (_, i) => ({
    id: String(i), title: `发现${i}\x1b[31m\n`, priority: i % 2 ? 'optional' : 'must-fix', status: 'open',
    evidence: '证据'.repeat(100), triggerOrClaim: '触发', consequence: '后果', verification: '验证', suggestion: '建议',
  })) };
function harness() {
  let component, done;
  const ctx = { mode: 'tui', ui: { theme: { fg: (_, text) => text }, custom(factory) {
    return new Promise(resolve => { done = resolve; component = factory({ requestRender() {} }, this.theme, {}, resolve); });
  } } };
  const result = browseReview(ctx, run);
  return { ctx, result, get component() { return component; }, close() { done(undefined); } };
}
test('review status uses compact subagent labels and render-time colors', () => {
  const completed = { ...run, stage: 'completed', elapsedMs: 44000, usage: { totalTokens: 26162, cost: 0.30746 }, budget: { maxCalls: 8, maxTokens: 400000, timeoutMs: 600000 } };
  const text = widgetLines(completed).join('\n');
  assert.match(text, /✅ 已完成/);
  assert.doesNotMatch(text, /completed|tokens/);
  assert.match(text, /2.6万\/40.0万 词元/);
  assert.match(text, /\$0.3075 · 44s \/ 10m 0s/);
  const colors = [];
  const widget = reviewWidget(completed, { fg(color, text) { colors.push(color); return text; } });
  // Mock treats box drawing as wide, so test body truncation separately from borders.
  for (const width of [0, 1, 2, 5, 6, 20, 80]) {
    const rows = widget.render(width);
    assert.equal(rows.length, width === 0 ? 0 : width < 6 ? 3 : 5);
    if (width < 6) for (const row of rows) assert.ok([...row].reduce((n, c) => n + (/[^\x00-\x7f]/u.test(c) ? 2 : 1), 0) <= width);
  }
  assert.ok(colors.includes('success'));
  const before = colors.length;
  widget.invalidate(); widget.render(80);
  assert.ok(colors.length > before);
  assert.match(widget.render(80)[0], /┌╌/);
});

test('non-TUI is notification/noop, never calls custom', async () => {
  assert.equal(await browseReview({ mode: 'json' }, run), undefined);
  let notice;
  await browseReview({ mode: 'rpc', ui: { notify(t) { notice = t; }, custom() { throw Error('wrong mode'); } } }, run);
  assert.match(notice, /TUI/);
});
test('bounded, width-safe, sanitized and dynamically themed', async () => {
  const h = harness();
  for (const width of [0, 1, 2, 12, 80]) {
    for (const detail of [false, true]) {
      if (detail) h.component.handleInput('enter');
      const lines = h.component.render(width);
      assert.ok(lines.length <= 20);
      for (const line of lines) {
        assert.doesNotMatch(line, /[\x00-\x1f\x7f-\x9f]/);
        assert.ok([...line].reduce((n, c) => n + (/[^\x00-\x7f]/u.test(c) ? 2 : 1), 0) <= width);
      }
      if (detail) h.component.handleInput('escape');
    }
  }
  let calls = 0;
  h.ctx.ui.theme = { fg(_, text) { calls++; return text; } };
  h.component.invalidate(); h.component.render(80);
  assert.ok(calls > 0);
  h.close(); await h.result;
});
test('navigation, filters, details and status return intent without mutation', async () => {
  const before = JSON.stringify(run);
  const h = harness();
  h.component.handleInput('p'); // must-fix
  h.component.handleInput('down');
  h.component.handleInput('enter');
  const first = h.component.render(40).join('\n');
  h.component.handleInput('down');
  assert.notEqual(h.component.render(40).join('\n'), first);
  h.component.handleInput('escape');
  h.component.handleInput('a');
  assert.deepEqual(await h.result, { action: 'status', findingId: '2', status: 'accepted' });
  assert.equal(JSON.stringify(run), before);
});
test('all action keys and exit', async () => {
  for (const [key, expected] of Object.entries({ d: { action: 'status', status: 'dismissed', findingId: '0' },
    r: { action: 'status', status: 'resolved', findingId: '0' }, o: { action: 'status', status: 'open', findingId: '0' },
    v: { action: 'recheck', findingId: '0' }, q: { action: 'discuss', findingId: '0' }, x: { action: 'cancel' }, u: { action: 'resume' }, escape: undefined })) {
    const h = harness(); h.component.handleInput(key); assert.deepEqual(await h.result, expected);
  }
  assert.equal(widgetLines(run).length, 3);
});
