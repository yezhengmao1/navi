import assert from 'node:assert/strict';
import test from 'node:test';
import { load, tui } from './helpers.mjs';

const { showRelayApproval } = await load('../magic-relay/approval');
const theme = { fg: (_, s) => s, bg: (_, s) => s, bold: s => s };
const up = '\x1b[A', down = '\x1b[B', right = '\x1b[C', left = '\x1b[D';
function open(task, { cwd = '/project', signal } = {}) {
  let dialog, completions = 0;
  const terminal = { rows: 24 };
  const result = showRelayApproval({ cwd, mode: 'tui', hasUI: true, ui: {
    custom: factory => new Promise(resolve => {
      dialog = factory({ terminal, requestRender() {} }, theme, {}, value => { completions++; resolve(value); });
    }),
  } }, task, signal);
  return { terminal, result, render: (width = 80) => dialog.render(width), key: k => dialog.handleInput(k),
    completions: () => completions };
}

test('wrap before paging: a single long line is fully inspectable in three-row pages', async () => {
  const groups = [...'甲乙丙丁戊己庚辛'].map(ch => ch.repeat(10)); // Exactly 20 columns per group.
  const f = open(groups.join(''));
  for (let page = 0; page < 3; page++) {
    const lines = f.render(24), view = lines.join('\n');
    assert.match(view, new RegExp(`${page + 1}/3`));
    for (const [i, group] of groups.entries()) assert.equal(view.includes(group), Math.floor(i / 3) === page);
    assert.match(view, /› 拒绝.*允许/);
    assert.ok(lines.length <= 12 && lines.every(line => tui.visibleWidth(line) <= 24));
    f.key(down);
  }
  assert.match(f.render(24).join('\n'), /3\/3/);
  f.key(up); assert.match(f.render(24).join('\n'), /2\/3/);
  // Reflow and clamp the old page after a resize.
  const wide = f.render(100).join('\n');
  assert.match(wide, /1\/1/); assert.match(wide, /外部 agy 可能修改文件并产生费用/);
  assert.match(wide, /目录：\/project/); assert.doesNotMatch(wide, /反馈/);
  f.key('\r'); assert.deepEqual(await f.result, { allow: false });
});

test('hard wrapping preserves code indentation, blank lines and emoji clusters', async () => {
  const f = open(' '.repeat(23) + 'x\n\n' + 'a'.repeat(19) + '🧑‍💻!');
  assert.ok(f.render(24).includes('│ ' + '   x'.padEnd(20) + ' │'));
  f.key(down);
  const last = f.render(24);
  assert.ok(last.some(line => line.includes('a'.repeat(19))));
  assert.ok(last.some(line => line.startsWith('│ 🧑‍💻!')));
  f.key('\x1b'); await f.result;
});

test('only explicit Enter on Allow approves; preview keys never change the action', async () => {
  for (const [keys, allow] of [
    [[right, down, up, 'y', ' ', '\r'], true], [[right, left, '\r'], false],
    [[right, '\x1b'], false], [[right, '\x03'], false], [['y', ' ', '\r'], false],
  ]) {
    const f = open('one\ntwo\nthree\nfour'); f.render();
    for (const key of keys) { assert.equal(f.completions(), 0); f.key(key); }
    assert.deepEqual(await f.result, { allow });
  }
});

test('escape task and path controls for display; a long directory is not silently clipped', async () => {
  const cwd = '/\n' + '子'.repeat(30) + '/tail\x1b';
  const f = open('first\n\x1b[2J\x07\u009b\u202e\r\t\nlast', { cwd });
  let body = '';
  for (let i = 0; i < 20; i++) {
    const lines = f.render(48), view = lines.join('\n');
    assert.ok(lines.every(line => !/[\p{Cc}\p{Bidi_Control}]/u.test(line)));
    body += view; if (view.includes('last')) break;
    f.key('\x1b[6~'); // PgDn
  }
  for (const fragment of ['/\\x0a', '/tail\\x1b', 'first', '\\x1b[2J\\x07\\x9b\\u202e\\x0d\\x09', 'last']) {
    assert.ok(body.includes(fragment), fragment);
  }
  f.key('\x1b'); await f.result;
});

test('very small terminals stay bounded and cannot approve an unreadable prompt', async () => {
  const f = open('🧑‍💻'.repeat(200));
  f.render(); f.key(right);
  for (const [width, height] of [[80, 4], [24, 10], [4, 2], [0, 0]]) {
    f.terminal.rows = height;
    const lines = f.render(width);
    assert.ok(lines.length <= height && lines.every(line => tui.visibleWidth(line) <= width));
  }
  f.key(right); f.key('\r'); assert.deepEqual(await f.result, { allow: false });
});

test('headless, abort, and absent or malformed UI results fail closed', async () => {
  for (const ctx of [{ mode: 'rpc', hasUI: true }, { mode: 'tui', hasUI: false }]) {
    assert.deepEqual(await showRelayApproval(ctx, 'task'), { allow: false });
  }
  const controller = new AbortController();
  const f = open('task', { signal: controller.signal }); f.render(); f.key(right);
  controller.abort(); assert.deepEqual(await f.result, { allow: false });
  assert.deepEqual(await showRelayApproval({ mode: 'tui', hasUI: true }, 'task', controller.signal), { allow: false });
  for (const answer of [undefined, { allow: 'yes' }]) {
    assert.deepEqual(await showRelayApproval({ mode: 'tui', hasUI: true, cwd: '/', ui: { custom: async () => answer } }, 'task'), { allow: false });
  }
});
