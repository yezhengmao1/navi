import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './helpers.mjs';
const { default: registerGuard, confirmOrFeedback } = await load('../safety-guard');

function harness(listener, review = '{"risk":"medium","reason":"reviewed"}') {
  const handlers = new Map(), requests = [];
  let local = 0;
  const controller = new AbortController();
  registerGuard({
    on(name, fn) { handlers.set(name, fn); },
    registerCommand() {}, registerFlag() {}, getFlag() { return true; }, appendEntry() {},
    events: { emit(name, data) {
      if (name !== 'agent-team:approval') return;
      requests.push(data);
      listener?.(data);
    } },
  });
  const ctx = { cwd: '/tmp', hasUI: true, signal: controller.signal,
    model: {}, modelRegistry: {
      hasConfiguredAuth: () => true,
      complete: async () => {
        if (review instanceof Error) throw review;
        return { content: [{ type: 'text', text: review }] };
      },
    },
    ui: { custom: async () => { local++; return { allow: false, feedback: 'local rejection' }; } },
  };
  return { ctx, requests, controller, get local() { return local; },
    run(input, toolName = 'bash', toolCallId = 'operation') {
      return handlers.get('tool_call')({ toolCallId, toolName, input }, ctx);
    },
  };
}

for (const [name, toolName, input] of [
  ['delete', 'bash', { command: 'echo before; rm file; echo after', timeout: 123 }],
  ['destructive', 'bash', { command: 'git reset --hard' }],
  ['heavy', 'bash', { command: 'find /' }],
  ['sensitive write', 'write', { path: '/etc/passwd', content: 'full exact content' }],
  ['sensitive edit', 'edit', { path: '/etc/passwd', edits: [{ oldText: 'a', newText: 'b' }] }],
]) {
  test(`${name} routes high with exact operation, awaiting central reply without local UI`, async () => {
    let reply;
    const h = harness(request => { request.handled = true; reply = request.reply; });
    const pending = h.run(input, toolName);
    const request = h.requests[0];
    assert.equal(request.source, 'safety-guard');
    assert.equal(request.risk, 'high');
    assert.equal(request.input, input);
    assert.equal(request.ctx, h.ctx);
    assert.equal(request.toolName, toolName);
    assert.equal(request.toolCallId, 'operation');
    assert.ok(request.title && request.body);
    let finished = false;
    pending.then(() => { finished = true; });
    await Promise.resolve();
    assert.equal(finished, false);
    reply({ allow: true });
    assert.equal(await pending, undefined);
    assert.equal(h.local, 0);
  });
}

for (const [kind, command, review] of [
  ['mv', 'mv medium-route-a medium-route-b', '{"risk":"medium","reason":"possible overwrite"}'],
  ['load', 'find / -name team-route-medium', '{"load":"medium","reason":"bounded scan"}'],
]) {
  test(`${kind} actual reviewer medium routes medium even without UI`, async () => {
    const h = harness(r => { r.handled = true; queueMicrotask(() => r.reply({ allow: true })); }, review);
    h.ctx.hasUI = false;
    assert.equal(await h.run({ command }), undefined);
    assert.equal(h.requests[0].risk, 'medium');
    assert.equal(h.local, 0);
  });
}

for (const kind of ['mv', 'load']) {
  for (const failure of ['no model', 'no credentials', 'parse', 'exception']) {
    test(`${kind} ${failure} uncertainty routes high, never autoapproves`, async () => {
      const h = harness(r => { r.handled = true; r.reply({ allow: false, feedback: 'central denial' }); },
        failure === 'exception' ? new Error('offline') : 'unclear');
      if (failure === 'no model') h.ctx.model = undefined;
      if (failure === 'no credentials') h.ctx.modelRegistry.hasConfiguredAuth = () => false;
      const unique = `${kind}-${failure.replaceAll(' ', '-')}`;
      const command = kind === 'mv' ? `mv ${unique} ${unique}-new` : `find / -name ${unique}`;
      const result = await h.run({ command });
      assert.equal(result.block, true);
      assert.match(result.reason, /central denial/);
      assert.equal(h.requests[0].risk, 'high');
      assert.equal(h.local, 0);
    });
  }
}

for (const preAborted of [false, true]) {
  test(`central cancellation denies (pre-aborted=${preAborted}) and ignores late approval`, async () => {
    const h = harness(r => { r.handled = true; });
    if (preAborted) h.controller.abort();
    const pending = h.run({ command: 'rm cancel-file' });
    h.controller.abort();
    const result = await pending;
    assert.equal(result.block, true);
    h.requests[0].reply({ allow: true });
    assert.equal(h.local, 0);
  });
}

test('managed member with a missing relay denies instead of falling back to its local UI', async () => {
  const original = [...process.argv];
  process.argv.push('--team-approval-config', '/test/private-config.json');
  try {
    const h = harness();
    const result = await h.run({ command: 'rm relay-missing-file' });
    assert.equal(result.block, true); assert.equal(h.local, 0);
    assert.match(result.reason, /relay unavailable/);
  } finally { process.argv.splice(0, process.argv.length, ...original); }
});

test('unclaimed requests retain local dialog; a reply alone is not a claim', async () => {
  for (const listener of [undefined, r => r.reply({ allow: true })]) {
    const h = harness(listener);
    const result = await h.run({ command: 'rm local-file' });
    assert.equal(result.block, true);
    assert.match(result.reason, /local rejection/);
    assert.equal(h.local, 1);
  }
});

test('outside tool scope confirmation stays local and no-UI stays denied', async () => {
  const h = harness(() => assert.fail('outside scope'));
  assert.equal((await confirmOrFeedback(h.ctx, 'title', 'body')).allow, false);
  assert.equal(h.local, 1);
  h.ctx.hasUI = false;
  assert.equal((await confirmOrFeedback(h.ctx, 'title', 'body')).allow, false);
  assert.equal(h.local, 1);
});

test('parallel tool scopes preserve operation identity and independent decisions', async () => {
  const h = harness(r => { r.handled = true; });
  const first = h.run({ command: 'rm first' }, 'bash', 'first');
  const second = h.run({ command: 'rm second' }, 'bash', 'second');
  assert.deepEqual(h.requests.map(r => [r.toolCallId, r.input.command]), [['first', 'rm first'], ['second', 'rm second']]);
  h.requests[1].reply({ allow: true });
  assert.equal(await second, undefined);
  h.requests[0].reply({ allow: false, feedback: 'first denied' });
  assert.match((await first).reason, /first denied/);
  assert.equal(h.local, 0);
});
