import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { root } from './helpers.mjs';

const pkg = fileURLToPath(new URL('..', import.meta.url));
const { loadExtensions } = await import(pathToFileURL(join(root, 'dist/core/extensions/loader.js')));
const loaded = await loadExtensions([join(pkg, 'extensions/safety-guard.ts')], pkg);
assert.deepEqual(loaded.errors, []);
const extension = loaded.extensions[0];

test('single safety entry registers clear, existing flags and tool guard', () => {
  assert.equal(loaded.extensions.length, 1);
  assert.ok(extension.commands.has('clear'));
  assert.ok(extension.flags.has('shell-guard-review'));
  assert.ok(extension.flags.has('heavy-review'));
  assert.equal(extension.handlers.get('tool_call').length, 1);
  assert.ok(!existsSync(join(pkg, 'extensions/clear.ts')));
  assert.ok(!existsSync(join(pkg, 'extensions/command-guard.ts')));
});

for (const scenario of [
  { name: 'confirmed conversation', hasUI: true, entries: [{}], allow: true, prompts: 1, resets: 1 },
  { name: 'rejected conversation', hasUI: true, entries: [{}], allow: false, prompts: 1, resets: 0 },
  { name: 'empty conversation', hasUI: true, entries: [], prompts: 0, resets: 1 },
  { name: 'non-interactive conversation', hasUI: false, entries: [{}], prompts: 0, resets: 1 },
]) {
  test(`/clear preserves behavior: ${scenario.name}`, async () => {
    let prompts = 0, resets = 0, notifications = 0;
    const ctx = {
      hasUI: scenario.hasUI,
      sessionManager: { getEntries: () => scenario.entries },
      ui: {
        custom: async () => { prompts++; return { allow: scenario.allow }; },
        notify: () => assert.fail('must notify through fresh session context'),
      },
      newSession: async ({ withSession }) => {
        resets++;
        await withSession({ ui: { notify: () => { notifications++; } } });
        return { cancelled: false };
      },
    };
    await extension.commands.get('clear').handler('', ctx);
    assert.equal(prompts, scenario.prompts);
    assert.equal(resets, scenario.resets);
    assert.equal(notifications, scenario.resets);
  });
}
