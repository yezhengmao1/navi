import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { root } from './helpers.mjs';
const pkg = fileURLToPath(new URL('..', import.meta.url));
const { loadExtensions } = await import(pathToFileURL(join(root, 'dist/core/extensions/loader.js')));

test('single magic-ui entry loads and registers generic tools/commands', async () => {
  const loaded = await loadExtensions([join(pkg, 'extensions/magic-ui/index.ts')], pkg);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0];
  assert.ok(extension.tools.has('questionnaire'));
  assert.ok(extension.tools.has('bash'));
  assert.ok(!extension.tools.has('brief_select'));
  assert.ok(extension.commands.has('quota'));
  const manifest = JSON.parse(readFileSync(join(pkg, 'package.json')));
  assert.ok(manifest.pi.extensions.includes('./extensions/magic-ui/index.ts'));
  assert.ok(!manifest.pi.extensions.some(p => p.includes('**')));
});

test('legacy installer copies/links the whole directory, removes old entry points only', () => {
  const home = mkdtempSync(join(tmpdir(), 'navi-installer-test-'));
  const extensions = join(home, '.pi/agent/extensions');
  mkdirSync(extensions, { recursive: true });
  writeFileSync(join(extensions, 'magic-header.ts'), 'old');
  writeFileSync(join(extensions, 'magic-ui.ts'), 'old');
  writeFileSync(join(extensions, 'unrelated.ts'), 'keep');
  writeFileSync(join(extensions, 'clear.ts'), 'old');
  writeFileSync(join(extensions, 'command-guard.ts'), 'old');
  const run = (...args) => {
    const r = spawnSync('bash', [join(pkg, 'install-extensions.sh'), ...args], {
      env: { ...process.env, HOME: home }, encoding: 'utf8', cwd: tmpdir(), timeout: 10000,
    });
    assert.equal(r.status, 0, r.stderr);
  };
  try {
    run();
    assert.ok(existsSync(join(extensions, 'magic-ui/index.ts')));
    assert.ok(existsSync(join(extensions, 'magic-ui/questionnaire.ts')));
    assert.ok(!existsSync(join(extensions, 'magic-header.ts')));
    assert.ok(!existsSync(join(extensions, 'magic-ui.ts')));
    assert.ok(!existsSync(join(extensions, 'clear.ts')));
    assert.ok(!existsSync(join(extensions, 'command-guard.ts')));
    assert.ok(existsSync(join(extensions, 'safety-guard.ts')));
    assert.ok(existsSync(join(home, '.pi/agent/themes/magic.json')));
    run('--link');
    assert.ok(lstatSync(join(extensions, 'magic-ui')).isSymbolicLink());
    run();
    assert.ok(!lstatSync(join(extensions, 'magic-ui')).isSymbolicLink());
    assert.ok(existsSync(join(pkg, 'extensions/magic-ui/index.ts')), 'must not delete symlink source');
    run('--uninstall');
    assert.ok(!existsSync(join(extensions, 'magic-ui')));
    assert.ok(!existsSync(join(extensions, 'safety-guard.ts')));
    assert.equal(readFileSync(join(extensions, 'unrelated.ts'), 'utf8'), 'keep');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
