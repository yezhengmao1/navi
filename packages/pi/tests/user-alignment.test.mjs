import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { load, root, tui } from './helpers.mjs';
const { userAlignmentAdapter } = await load('user-alignment');
const { messageFlowPalette, paintMessageFlow } = await load('message-flow');
const native = path => import(pathToFileURL(join(root, 'dist/modes/interactive', path)).href);
const themes = await native('theme/theme.js');
themes.initTheme('dark', false);
const { UserMessageComponent } = await native('components/user-message.js');

const plain = lines => lines.map(tui.stripTerminalSequences);

test('flow keeps native left alignment, full width, blank rows and OSC zone prefixes', () => {
  const node = new UserMessageComponent('你好 yes');
  const original = node.render;
  const expected = original.call(node, 80);
  const adapter = userAlignmentAdapter((text, width, row, height) =>
    paintMessageFlow(text, messageFlowPalette(width, themes.theme, 4000, row, height)));
  adapter.update({ children: [node] });
  const actual = node.render(80);
  assert.deepEqual(plain(actual), plain(expected));
  assert.ok(plain(actual)[1].startsWith(' 你好 yes'));
  assert.ok(actual[0].startsWith('\x1b]133;A\x07'));
  assert.ok(actual.at(-1).startsWith('\x1b]133;B\x07\x1b]133;C\x07'));
  assert.equal(actual.length, 3);
  assert.equal(plain(actual)[0], ' '.repeat(80));
  assert.equal(plain(actual)[2], ' '.repeat(80));
  assert.deepEqual(actual.map(tui.visibleWidth), [80, 80, 80]);
  adapter.dispose();
  assert.equal(node.render, original);
});

test('flow preserves native Markdown layout across widths and does not change content', () => {
  for (const text of ['中文消息 '.repeat(60), 'first\n\nsecond', '```js\nconst x = 123;\n```', '- one\n- two', '🙂 e\u0301 link']) {
    const node = new UserMessageComponent(text);
    const original = node.render;
    const adapter = userAlignmentAdapter((line, width, row, height) =>
      paintMessageFlow(line, messageFlowPalette(width, themes.theme, 2000, row, height)));
    adapter.update({ getMountedRoots: () => [node] });
    for (const width of [10, 19, 20, 40, 80, 120]) {
      const expected = plain(original.call(node, width));
      const lines = node.render(width);
      assert.deepEqual(plain(lines), expected);
      for (const line of lines) assert.ok(tui.visibleWidth(line) <= width);
    }
    adapter.dispose();
  }
});

test('flow changes over time, loops every eight seconds and restores color after ANSI resets', () => {
  const palette = messageFlowPalette(80, themes.theme, 4000);
  assert.equal(palette.length, 80);
  assert.ok(new Set(palette).size > 1);
  assert.notDeepEqual(palette, messageFlowPalette(80, themes.theme, 0));
  assert.deepEqual(palette, messageFlowPalette(80, themes.theme, 12000));
  const line = paintMessageFlow('a\x1b[0mb', ['\x1b[44m', '\x1b[45m']);
  assert.equal(line, '\x1b[44ma\x1b[0m\x1b[45mb\x1b[49m');
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
