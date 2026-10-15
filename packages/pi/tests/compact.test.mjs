import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { load, root, tui } from './helpers.mjs';
const { initTheme, getThemeByName } = await import(pathToFileURL(join(root, 'dist/modes/interactive/theme/theme.js')).href);
initTheme('dark', false);
const theme = getThemeByName('dark');
const { default: register, compactThinking } = await load('compact');
let bash;
register({ registerMarkdownTransformer() {}, registerTool(tool) { bash = tool; } });
const context = () => ({ state: {}, toolCallId: 'test', executionStarted: true, argsComplete: true,
  isPartial: false, expanded: false, showImages: false, isError: false, durationMs: 1234,
  invalidate() {}, lastComponent: undefined, cwd: '/tmp', outputPad: 1 });
const plain = component => component.render(100).map(tui.stripTerminalSequences).join('\n');

test('thinking tail matches legacy folding without materializing historical lines', () => {
  const legacy = (text, keep) => {
    const lines = text.split('\n');
    if (lines.length <= keep) return text;
    const omitted = lines.length - keep;
    return `⋯ ${omitted} earlier thinking ${omitted === 1 ? 'line' : 'lines'} folded ⋯\n\n${lines.slice(-keep).join('\n')}`;
  };
  const samples = ['', '中文🙂', '\n', 'a\r\nb\r\n', '\n'.repeat(50),
    '分析🙂\n'.repeat(100_000), 'a\nb\nc\nd\ne\nf\ng'];
  for (const text of samples) for (const keep of [1, 2, 6, 100, 0, -1, 2.5, Infinity, NaN]) {
    assert.equal(compactThinking(text, keep), legacy(text, keep));
  }
  for (let count = 0; count < 100; count++) {
    const text = Array.from({ length: count }, (_, i) => i % 3 ? `line ${i}` : '').join('\n');
    assert.equal(compactThinking(text), legacy(text, 6));
  }
});

test('bash timeout title only shows finite positive numbers', () => {
  for (const timeout of [undefined, null, 0, -1, NaN, Infinity, '30']) {
    assert.doesNotMatch(plain(bash.renderCall({ command: 'pwd', timeout }, theme, context())), /timeout/);
  }
  assert.match(plain(bash.renderCall({ command: 'pwd', timeout: 30 }, theme, context())), /timeout 30s/);
});

test('bash omits native duration footer without filtering real output, partial or expanded', () => {
  for (const expanded of [false, true]) for (const isPartial of [false, true]) {
    const ctx = context();
    bash.renderCall({ command: 'pwd' }, theme, ctx);
    const output = plain(bash.renderResult({ content: [{ type: 'text', text: 'Took 0.1s\nElapsed 2s\nreal output' }], details: {} }, { expanded, isPartial }, theme, ctx));
    assert.match(output, /Took 0\.1s/);
    assert.match(output, /Elapsed 2s/);
    assert.match(output, /real output/);
    assert.doesNotMatch(output, /Took 1\.2s/);
    assert.equal(ctx.durationMs, 1234, 'preserve recorded duration for top-right label');
    assert.equal(ctx.state.interval, undefined);
  }
});
