import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './helpers.mjs';
const { default: registerGuard } = await load('../safety-guard');

function harness() {
  const handlers = new Map();
  registerGuard({
    on: (name, fn) => handlers.set(name, fn),
    registerCommand() {}, registerFlag() {}, getFlag: () => true, appendEntry() {},
    // The guard publishes timing, never an operation or an approval callback.
    events: { emit: name => assert.equal(name, 'safety-guard:timing') },
  });
  const ctx = { cwd: '/tmp', hasUI: false, model: undefined,
    ui: { custom: () => assert.fail('unexpected dialog') },
  };
  const run = (input, toolName = 'bash', toolCallId = 'call') =>
    handlers.get('tool_call')({ toolCallId, toolName, input }, ctx);
  return { ctx, run };
}

for (const [toolName, input] of [
  ['bash', { command: 'echo before; rm file; echo after' }],
  ['bash', { command: 'git reset --hard' }],
  ['bash', { command: 'find /' }],
  ['bash', { command: 'echo denied > /etc/passwd' }],
  ['bash', { command: 'echo denied >> ~/.bashrc' }],
  ['write', { path: '/etc/passwd', content: 'content' }],
  ['edit', { path: '/etc/passwd', edits: [{ oldText: 'a', newText: 'b' }] }],
]) {
  test(`no UI blocks ${toolName}: ${input.command ?? input.path}`, async () => {
    assert.equal((await harness().run(input, toolName)).block, true);
  });
}

for (const kind of ['risk', 'load']) {
  for (const review of ['medium', 'high', 'no model', 'no auth', 'malformed', 'offline', 'low']) {
    test(`${kind} review without UI: ${review}`, async () => {
      const { ctx, run } = harness();
      if (review !== 'no model') ctx.model = {};
      ctx.modelRegistry = {
        hasConfiguredAuth: () => review !== 'no auth',
        complete: async () => {
          if (review === 'offline') throw new Error('offline');
          const text = review === 'malformed' ? '?' : JSON.stringify({ [kind]: review, reason: 'reviewed' });
          return { content: [{ type: 'text', text }] };
        },
      };
      const name = review.replaceAll(' ', '-'); // Keep reviewer cache keys distinct.
      const result = await run({ command: kind === 'risk' ? `mv ${name} ${name}-new` : `find / -name ${name}` });
      if (review === 'low') assert.equal(result, undefined);
      else assert.equal(result.block, true);
    });
  }
}

test('parallel local rejections keep their own feedback', async () => {
  const { ctx, run } = harness();
  ctx.hasUI = true;
  const decisions = [];
  ctx.ui.custom = () => new Promise(resolve => decisions.push(resolve));
  const calls = ['one', 'two'].map(name => run({ command: `rm ${name}` }, 'bash', name));
  decisions[1]({ allow: false, feedback: 'second decision' });
  decisions[0]({ allow: false, feedback: 'first decision' });
  const [first, second] = await Promise.all(calls);
  assert.match(first.reason, /first decision/);
  assert.match(second.reason, /second decision/);
});

test('only explicit local consent allows a guarded operation', async () => {
  const { ctx, run } = harness();
  ctx.hasUI = true;
  for (const decision of [undefined, { allow: 'yes' }, { allow: false }, { allow: true }]) {
    ctx.ui.custom = async () => decision;
    const result = await run({ command: 'rm example' });
    if (decision?.allow === true) assert.equal(result, undefined);
    else assert.equal(result.block, true);
  }
});

test('abort during RPC confirmation overrides late consent', async () => {
  const { ctx, run } = harness();
  const controller = new AbortController();
  Object.assign(ctx, { hasUI: true, mode: 'rpc', signal: controller.signal });
  ctx.ui.confirm = async () => { controller.abort(); return true; };
  assert.equal((await run({ command: 'rm example' })).block, true);
});

test('a legacy managed invocation cannot substitute local consent', async () => {
  const { ctx, run } = harness();
  ctx.hasUI = true;
  const original = process.argv;
  try {
    process.argv = [...original, '--team-approval-config', '/unused'];
    assert.equal((await run({ command: 'rm example' })).block, true);
  } finally { process.argv = original; }
});
