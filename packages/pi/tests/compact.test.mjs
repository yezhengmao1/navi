import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { load, root, tui } from './helpers.mjs';
const { initTheme, getThemeByName } = await import(pathToFileURL(join(root, 'dist/modes/interactive/theme/theme.js')).href);
initTheme('dark', false);
const theme = getThemeByName('dark');
const { default: register } = await load('compact');
let bash;
register({ registerMarkdownTransformer() {}, registerTool(tool) { bash = tool; } });
const context = () => ({ state: {}, toolCallId: 'test', executionStarted: true, argsComplete: true,
  isPartial: false, expanded: false, showImages: false, isError: false, durationMs: 1234,
  invalidate() {}, lastComponent: undefined, cwd: '/tmp', outputPad: 1 });
const plain = component => component.render(100).map(tui.stripTerminalSequences).join('\n');

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
