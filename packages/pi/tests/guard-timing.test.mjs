import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './helpers.mjs';
const { trackGuard, guardPhase, default: registerGuard } = await load('../safety-guard');
const { default: registerTiming } = await load('block-timing');

test('review and confirmation accumulate separately, preserving the guard decision', async () => {
  let now = 0;
  const events = [], saved = [];
  const decision = { block: true, reason: 'denied', terminate: true };
  const result = await trackGuard('a', async () => {
    await guardPhase('review', async () => { now += 1200; });
    await guardPhase('confirm', async () => { now += 5300; });
    await guardPhase('review', async () => { now += 300; });
    return decision;
  }, e => events.push(e), e => saved.push(e), () => now);
  assert.equal(result, decision);
  assert.deepEqual(saved, [{ toolCallId: 'a', reviewMs: 1500, waitMs: 5300, status: 'blocked' }]);
  assert.equal(events[0].phase, 'review');
  assert.equal(events[2].phase, 'confirm');
  assert.equal(events.at(-1).status, 'blocked');
});

test('ordinary tools add no timing metadata, including bare confirmation outside a tool scope', async () => {
  const fail = () => assert.fail('must not publish');
  assert.equal(await trackGuard('a', async () => undefined, fail, fail), undefined);
  assert.equal(await guardPhase('confirm', async () => 'outside'), 'outside');
});

test('parallel review scopes never mix tool IDs and exceptions finalize as interrupted', async () => {
  const saved = [];
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const first = trackGuard('a', () => guardPhase('confirm', async () => { await wait; return { block: true }; }), () => {}, e => saved.push(e));
  const error = new Error('aborted');
  await assert.rejects(trackGuard('b', () => guardPhase('review', async () => { throw error; }), () => {}, e => saved.push(e)), e => e === error);
  release(); await first;
  assert.equal(saved[0].toolCallId, 'b');
  assert.equal(saved[0].status, 'interrupted');
  assert.equal(saved[0].waitMs, undefined);
  assert.equal(saved[1].toolCallId, 'a');
  assert.equal(saved[1].reviewMs, undefined);
  assert.equal(saved[1].status, 'blocked');
});

function harness() {
  const handlers = new Map(), listeners = new Map(), entries = [], events = [];
  const pi = {
    on(name, fn) { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list); },
    events: {
      on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name); },
      emit(name, data) { events.push({ name, data }); listeners.get(name)?.(data); },
    },
    appendEntry(customType, data) { entries.push({ type: 'custom', customType, data }); },
    registerCommand() {}, registerFlag() {}, getFlag() { return false; },
  };
  return { pi, handlers, listeners, entries, events };
}

test('real guard confirmation emits blocked timing; Magic UI restores it without execution', async () => {
  const h = harness();
  registerGuard(h.pi);
  const timing = registerTiming(h.pi);
  const ctx = { mode: 'tui', hasUI: true, cwd: '/tmp', signal: new AbortController().signal,
    ui: { custom: async () => ({ allow: false }), theme: { fg: (_, text) => text, bg: (_, text) => text } },
    sessionManager: { getBranch: () => h.entries } };
  const node = { toolCallId: 'a', isPartial: true, updateResult() {}, render: () => ['bash rm file'] };
  timing.mount({ children: [node], requestRender() {} }, ctx);
  const result = await h.handlers.get('tool_call')[0]({ toolCallId: 'a', toolName: 'bash', input: { command: 'rm file' } }, ctx);
  assert.equal(result.block, true);
  assert.equal(h.entries.length, 1);
  assert.equal(h.entries[0].data.status, 'blocked');
  assert.match(node.render(80)[0], /已阻止/);
  assert.doesNotMatch(node.render(80)[0], /执行/);
  for (const fn of h.handlers.get('session_switch')) fn({}, ctx);
  assert.match(node.render(80)[0], /已阻止/);
  for (const fn of h.handlers.get('session_shutdown')) fn({}, ctx);
  assert.equal(h.listeners.size, 0);
});

test('session changes discard late guard events and persistence', async () => {
  const h = harness(); registerGuard(h.pi);
  let release;
  const ctx = { hasUI: true, cwd: '/tmp', ui: { custom: () => new Promise(resolve => { release = resolve; }) } };
  const pending = h.handlers.get('tool_call')[0]({ toolCallId: 'late', toolName: 'bash', input: { command: 'rm file' } }, ctx);
  assert.equal(h.events.length, 1);
  for (const fn of h.handlers.get('session_switch')) fn();
  release({ allow: false });
  await pending;
  assert.equal(h.events.length, 1);
  assert.equal(h.entries.length, 0);
});
