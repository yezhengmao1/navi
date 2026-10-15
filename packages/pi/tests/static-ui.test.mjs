import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { load } from './helpers.mjs';
const { cachedTimingRow, timingRow } = await load('block-timing');

test('completed timing titles reuse layout; duration, width, title and theme invalidate it', () => {
  const render = cachedTimingRow();
  let calls = 0, color = 90;
  const dim = text => { calls++; return `\x1b[${color}m${text}\x1b[39m`; };
  const first = render('Tool title', '1.0s', 80, dim);
  calls = 0;
  for (let i = 0; i < 100; i++) assert.equal(render('Tool title', '1.0s', 80, dim), first);
  // One cheap style probe, no timingRow()/ANSI slicing on cache hits.
  assert.equal(calls, 100);
  for (const [left, right, width] of [['Tool title', '2.0s', 80], ['Tool title', '2.0s', 40], ['Changed title', '2.0s', 40]]) {
    assert.equal(render(left, right, width, dim), timingRow(left, right, width, dim));
  }
  color = 31;
  assert.equal(render('Changed title', '2.0s', 40, dim), timingRow('Changed title', '2.0s', 40, dim));
  const bg = text => `\x1b[44m${text}\x1b[49m`;
  assert.equal(render('Changed title', '2.0s', 40, dim, bg), timingRow('Changed title', '2.0s', 40, dim, bg));
});

test('decorative animation timers are absent; editor uses static bright background', () => {
  const source = name => readFileSync(new URL(`../extensions/magic-ui/${name}.ts`, import.meta.url), 'utf8');
  assert.doesNotMatch(source('index'), /setInterval/);
  assert.doesNotMatch(source('header'), /setInterval/);
  const editor = source('editor-footer');
  assert.doesNotMatch(editor, /glowTimer|syncGlow|inputFlowPalette|renderInputBackground/);
  assert.match(editor, /staticMessageBackground\(theme\)/);
  assert.match(editor, /paintStaticMessage\(/);
});
