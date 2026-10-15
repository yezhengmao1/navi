import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { load, root } from './helpers.mjs';
const { renderRefresh } = await load('render-refresh');
const { default: registerTiming } = await load('block-timing');
const { default: registerHeader } = await load('header');
const { default: registerFooter, DailyTokenCounter } = await load('editor-footer');
const themes = await import(pathToFileURL(join(root, 'dist/modes/interactive/theme/theme.js')).href);
themes.initTheme('dark', false);
function harness(register) {
  const handlers = new Map();
  const controller = register({
    on(name, fn) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
    events: { on: () => () => {} }, appendEntry() {},
  });
  return { controller, emit(name, ...args) { for (const fn of handlers.get(name) ?? []) fn(...args); } };
}

test('burst requests coalesce; repaint-only updates and clean frames never rediscover', async () => {
  let scans = 0, renders = 0;
  const refresh = renderRefresh(() => scans++, () => renders++, 5);
  for (let i = 0; i < 100; i++) refresh.request(true);
  await sleep(15);
  assert.deepEqual([scans, renders], [1, 1]);
  for (let i = 0; i < 100; i++) { refresh.flush(); refresh.request(); }
  await sleep(15);
  assert.deepEqual([scans, renders], [1, 2]);
  refresh.request(true); refresh.reset();
  await sleep(15);
  assert.deepEqual([scans, renders], [1, 2]);
  refresh.request(true); await sleep(15);
  assert.deepEqual([scans, renders], [2, 3]);
  refresh.reset();
});

test('streaming deltas skip history scans; late tools are discovered and detached nodes restored', async () => {
  const { controller, emit } = harness(registerTiming);
  let scans = 0, renders = 0;
  const children = [];
  const tree = { getMountedRoots() { scans++; return children; }, requestRender() { renders++; } };
  const ctx = { mode: 'tui', ui: { theme: themes.theme }, sessionManager: { getBranch: () => [] } };
  controller.mount(tree, ctx);
  await sleep(70);
  const baseline = scans;
  const baselineRenders = renders;
  const m = { role: 'assistant', provider: 'test', model: 'test', timestamp: 1 };
  for (let i = 0; i < 100; i++) {
    emit('message_update', { message: m, assistantMessageEvent: { type: 'text_delta', contentIndex: 0 } });
    controller.update();
  }
  await sleep(70);
  assert.equal(scans, baseline);
  assert.equal(renders, baselineRenders, 'native deltas must not request duplicate extension repaints');
  // Structural events still schedule discovery/repaint.
  emit('message_update', { message: m, assistantMessageEvent: { type: 'text_start', contentIndex: 1 } });
  await sleep(70);
  assert.ok(renders > baselineRenders);
  const node = { toolName: 'read', toolCallId: 'late', updateResult() {}, render: () => ['read file'] };
  const original = node.render;
  // Extension event arrives before the native component is mounted.
  emit('tool_execution_start', { toolCallId: 'late' });
  controller.update(); // An early frame must not consume post-event discovery.
  children.push(node);
  await sleep(70);
  assert.notEqual(node.render, original);
  children.length = 0;
  emit('session_compact', {});
  await sleep(70);
  assert.equal(node.render, original);
  emit('message_start', {});
  emit('session_shutdown');
  const stopped = renders;
  await sleep(70);
  assert.equal(renders, stopped);
});

test('header caches layout and resource discovery; resize, expansion and theme changes refresh', async () => {
  let component, scans = 0, expanded = false;
  const tree = { getMountedRoots() { scans++; return []; }, requestRender() {} };
  const ctx = { mode: 'tui', ui: {
    theme: themes.theme, getToolsExpanded: () => expanded,
    setHeader(factory) { component = factory(tree, this.theme); },
  } };
  const { emit } = harness(registerHeader);
  emit('session_start', {}, ctx);
  await sleep(5);
  const first = component.render(80);
  const baseline = scans;
  for (let i = 0; i < 100; i++) assert.equal(component.render(80), first);
  assert.equal(scans, baseline);
  assert.notEqual(component.render(40), first);
  expanded = true;
  const wider = component.render(80);
  assert.ok(wider.length > first.length);
  const before = scans;
  emit('session_switch', {}, ctx); component.render(80);
  assert.ok(scans > before);
  component.invalidate();
  assert.notEqual(component.render(80), wider);
  ctx.ui.theme = { ...themes.theme, fg: (_, text) => text };
  assert.notDeepEqual(component.render(80), wider);
  component.dispose();
});

test('footer renders cached context and invalidates it at session/model/message boundaries', async () => {
  const original = DailyTokenCounter.prototype.read;
  DailyTokenCounter.prototype.read = async () => 0;
  let footer, widget, reads = 0;
  const { emit } = harness(registerFooter);
  const tree = { requestRender() {} };
  const ctx = { mode: 'tui', getContextUsage() {
    reads++; return { tokens: reads, percent: reads, contextWindow: 100 };
  }, ui: {
    setWorkingMessage() {}, setEditorComponent() {},
    setWidget(_name, factory) { widget = factory(tree, themes.theme); },
    setFooter(factory) { footer = factory(tree, themes.theme, { getExtensionStatuses: () => new Map() }); },
  }, sessionManager: { getSessionDir: () => '/tmp/unused', getBranch: () => [] } };
  try {
    emit('session_start', {}, ctx); await sleep(10);
    assert.equal(reads, 1);
    for (let i = 0; i < 100; i++) widget.render(80);
    assert.equal(reads, 1, 'render must not recalculate session projections');
    for (const name of ['session_switch', 'session_tree', 'session_compact', 'model_select',
      'message_start', 'message_end', 'agent_end', 'before_provider_request']) {
      const before = reads;
      emit(name, { message: { role: 'user' } }, ctx);
      await sleep(10);
      assert.equal(reads, before + 1, name);
    }
    const before = reads;
    for (let i = 0; i < 100; i++) emit('message_update', { assistantMessageEvent: { type: 'text_delta' } }, ctx);
    await sleep(10);
    assert.equal(reads, before);
  } finally {
    footer?.dispose(); emit('session_shutdown', {}, ctx);
    DailyTokenCounter.prototype.read = original;
  }
});

test('usage poll repaints only when the value changes and ignores in-flight results after disposal', async () => {
  const original = DailyTokenCounter.prototype.read;
  let value = 100, renders = 0, footer, reject = false;
  DailyTokenCounter.prototype.read = async () => { if (reject) throw new Error('unavailable'); return value; };
  const { emit } = harness(registerFooter);
  const ctx = { mode: 'tui', ui: {
    setWorkingMessage() {}, setEditorComponent() {}, setWidget() {},
    setFooter(factory) { footer = factory({ requestRender() { renders++; } }, themes.theme, {}); },
  }, sessionManager: { getSessionDir: () => '/tmp/unused', getBranch: () => [] } };
  const refresh = async () => {
    emit('message_end', { message: { role: 'assistant', usage: {} } }, ctx);
    await sleep(10);
  };
  try {
    emit('session_start', {}, ctx); await sleep(10);
    assert.equal(renders, 1);
    await refresh(); assert.equal(renders, 1);
    value = 200; await refresh(); assert.equal(renders, 2);
    reject = true; await refresh(); assert.equal(renders, 3);
    await refresh(); assert.equal(renders, 3);
    let resolve;
    DailyTokenCounter.prototype.read = () => new Promise(done => { resolve = done; });
    await refresh(); footer.dispose(); resolve(300); await sleep(10);
    assert.equal(renders, 3);
  } finally {
    footer?.dispose(); emit('session_shutdown', {}, ctx);
    DailyTokenCounter.prototype.read = original;
  }
});
