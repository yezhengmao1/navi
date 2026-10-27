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
      const tools = new Map(), commands = new Map();
      await factory({ on() {}, registerCommand(name, command) { commands.set(name, command); }, registerTool(tool) { tools.set(tool.name, tool); },
        sendUserMessage() { assert.fail('Cancelled input must not start a review'); } });
      const prepare = tools.get('magic_review_prepare');
      assert.ok(prepare);
      let paperId;
      for (const [kind, target] of [['code', 'HEAD..HEAD'], ['paper', 'main.tex']]) {
        const result = await prepare.execute('fixture', { kind, target }, undefined, undefined, { cwd, hasUI: false });
        assert.equal(result.details.state, 'prepared');
        assert.ok(result.details.id);
        if (kind === 'paper') paperId = result.details.id;
      }
      let prompts = 0;
      const ctx = { cwd, hasUI: true, mode: 'tui', ui: {
        custom: factory => new Promise(resolve => {
          prompts++;
          const theme = { fg: (_c, s) => s, bg: (_c, s) => s, bold: s => s };
          const dialog = factory({ terminal: { rows: 24 }, requestRender() {} }, theme, {}, resolve);
          assert.match(dialog.render(80).join('\n'), /┌/);
          dialog.handleInput('\r'); // Confirmations default to denial; type picker selects code.
        }),
        notify(message) { assert.fail(message); },
        confirm() { assert.fail('Must not bypass explicit authorization with native confirm'); },
        select() { assert.fail('TUI must use cards'); }, input() { assert.fail('TUI must use cards'); },
      } };
      const denied = await tools.get('magic_review_verify').execute('v', { action: 'execute', command: 'false' }, undefined, undefined, ctx);
      assert.equal(denied.details.status, 'denied');
      const refs = await tools.get('magic_review_references').execute('refs', { id: paperId }, undefined, undefined, ctx);
      assert.equal(refs.details.status, 'denied');
      assert.equal(prompts, 2);
      // Select a type, then cancel the target input: no run request is sent.
      ctx.ui.custom = factory => new Promise(resolve => {
        prompts++;
        const theme = { fg: (_c, s) => s, bg: (_c, s) => s, bold: s => s };
        const dialog = factory({ terminal: { rows: 24 }, requestRender() {} }, theme, {}, resolve);
        assert.match(dialog.render(80).join('\n'), /┌/);
        dialog.handleInput(prompts === 3 ? '\r' : '\x1b');
      });
      await commands.get('magic-review').handler('', ctx);
      assert.equal(prompts, 4);
    }
  });
}
