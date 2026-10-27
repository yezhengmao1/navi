import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { root } from './helpers.mjs';

const require = createRequire(path.join(root, 'package.json'));
const { createJiti } = require('jiti');
let aiEntry;
try { aiEntry = require.resolve('@earendil-works/pi-ai/compat'); }
catch { aiEntry = path.join(root, '../pi-ai/dist/index.js'); }
const entry = fileURLToPath(new URL('../../magic-review/extensions/index.ts', import.meta.url));

// Unlike the unit harness, load the actual TS entry and all its dependencies
// through Pi's jiti, exercising both native and transformed ESM loading.
for (const tryNative of [true, false]) {
  test(`magic-review jiti startup and code/paper prepare (tryNative=${tryNative})`, async t => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'magic-review-loader-'));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const git = (...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
    git('init');
    git('config', 'user.name', 'Test Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    await writeFile(path.join(cwd, 'main.tex'), '\\section{Fixture}');
    git('add', 'main.tex');
    git('-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
    const jiti = createJiti(import.meta.url, {
      moduleCache: false, fsCache: false, tryNative,
      alias: {
        '@earendil-works/pi-ai': aiEntry,
        '@earendil-works/pi-tui': require.resolve('@earendil-works/pi-tui'),
      },
    });
    // Load twice to cover the reload path as well as initial registration.
    for (let attempt = 0; attempt < 2; attempt++) {
      const factory = await jiti.import(entry, { default: true });
      const tools = new Map();
      await factory({ on() {}, registerCommand() {}, registerTool(tool) { tools.set(tool.name, tool); } });
      const prepare = tools.get('magic_review_prepare');
      assert.ok(prepare);
      for (const [kind, target] of [['code', 'HEAD..HEAD'], ['paper', 'main.tex']]) {
        const result = await prepare.execute('fixture', { kind, target }, undefined, undefined, { cwd, hasUI: false });
        assert.equal(result.details.state, 'prepared');
        assert.ok(result.details.id);
      }
    }
  });
}
