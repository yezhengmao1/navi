import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { load, root, tui } from './helpers.mjs';
const { userAlignmentAdapter } = await load('user-alignment');
const { staticMessageBackground, paintStaticMessage } = await load('message-flow');
const native = path => import(pathToFileURL(join(root, 'dist/modes/interactive', path)).href);
const themes = await native('theme/theme.js');
themes.initTheme('dark', false);
const { UserMessageComponent } = await native('components/user-message.js');

const plain = lines => lines.map(tui.stripTerminalSequences);

test('flow adds a top-left User label, preserving native content, height and OSC zones', () => {
  const node = new UserMessageComponent('你好 yes');
  const original = node.render;
  const expected = original.call(node, 80);
  const adapter = userAlignmentAdapter(text => paintStaticMessage(text, staticMessageBackground(themes.theme)));
  adapter.update({ children: [node] });
  const actual = node.render(80);
  assert.deepEqual(plain(actual).slice(1), plain(expected).slice(1));
  assert.ok(plain(actual)[1].startsWith(' 你好 yes'));
  assert.ok(actual[0].startsWith('\x1b]133;A\x07'));
  assert.ok(actual.at(-1).startsWith('\x1b]133;B\x07\x1b]133;C\x07'));
  assert.equal(actual.length, 3);
  assert.equal(plain(actual)[0], ' User' + ' '.repeat(75));
  assert.equal(plain(actual)[2], ' '.repeat(80));
  assert.deepEqual(actual.map(tui.visibleWidth), [80, 80, 80]);
  adapter.dispose();
  assert.equal(node.render, original);
});

test('flow preserves native Markdown layout across widths and does not change content', () => {
  for (const text of ['中文消息 '.repeat(60), 'first\n\nsecond', '```js\nconst x = 123;\n```', '- one\n- two', '🙂 e\u0301 link']) {
    const node = new UserMessageComponent(text);
    const original = node.render;
    const adapter = userAlignmentAdapter(line => paintStaticMessage(line, staticMessageBackground(themes.theme)));
    adapter.update({ getMountedRoots: () => [node] });
    for (const width of [10, 19, 20, 40, 80, 120]) {
      const expected = plain(original.call(node, width));
      const lines = node.render(width);
      assert.deepEqual(plain(lines).slice(1), expected.slice(1));
      assert.equal(plain(lines)[0].trim(), 'User');
      for (const line of lines) assert.ok(tui.visibleWidth(line) <= width);
    }
    adapter.dispose();
  }
});

test('static history caches paint across redraws and refreshes on width or style changes', () => {
  const node = new UserMessageComponent('你好 🙂 e\u0301');
  let calls = 0, key = 'a';
  const background = staticMessageBackground(themes.theme);
  const adapter = userAlignmentAdapter(line => { calls++; return paintStaticMessage(line, background); }, text => text, () => key);
  adapter.update({ children: [node] });
  const first = node.render(80);
  assert.ok(first[0].startsWith('\x1b]133;A\x07'));
  assert.equal(tui.visibleWidth(first[1]), 80);
  const painted = calls;
  for (let i = 0; i < 100; i++) assert.equal(node.render(80), first);
  assert.equal(calls, painted);
  node.render(40); assert.ok(calls > painted);
  const resized = calls;
  key = 'b'; node.render(40); assert.ok(calls > resized);
  adapter.dispose();
});

test('static background is uniform and preserves ANSI foreground, OSC and Unicode', () => {
  const bg = staticMessageBackground(themes.theme);
  assert.equal(staticMessageBackground(themes.theme), bg);
  const source = '\x1b]133;A\x07你好 🙂\x1b[0m text';
  const painted = paintStaticMessage(source, bg);
  assert.equal(tui.stripTerminalSequences(painted), tui.stripTerminalSequences(source));
  assert.ok(painted.startsWith('\x1b]133;A\x07'));
  assert.ok(painted.includes('\x1b[0m' + bg));
});

test('detaching restores instances; other components are untouched; repeated updates are safe', () => {
  const node = new UserMessageComponent('hello');
  const original = node.render;
  const other = { render: () => ['other'], children: [] };
  const adapter = userAlignmentAdapter();
  const tree = { children: [node, other] };
  adapter.update(tree);
  const wrapped = node.render;
  adapter.update(tree);
  assert.equal(node.render, wrapped);
  assert.deepEqual(other.render(), ['other']);
  tree.children = [other];
  adapter.update(tree);
  assert.equal(node.render, original);
  adapter.dispose();
});
