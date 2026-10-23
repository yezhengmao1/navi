import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { executeVerification, probeVerification } from '../lib/verify.mjs';

async function fixture(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'verification-test-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('rejects shell strings, executable paths and launcher bypasses before executing', async () => {
  await fixture(async cwd => {
    for (const command of ['sh', 'bash', 'env', 'bwrap', 'prlimit', '/usr/bin/python3', 'python3; touch /tmp/owned', '$(id)', 'node\0']) {
      const result = await executeVerification({ cwd, kind: 'command', command });
      assert.equal(result.status, 'denied', command);
      assert.equal(result.exit, null);
      assert.equal(result.capabilities, null);
    }
  });
});

test('validates argv, bounds, source scope, and TeX options without project execution', async () => {
  await fixture(async cwd => {
    const invalid = [
      { kind: 'command', command: 'python3', args: '-c bad' },
      { kind: 'command', command: 'python3', args: ['a\0b'] },
      { kind: 'command', command: 'python3', timeoutMs: Infinity },
      { kind: 'command', command: 'python3', timeoutMs: 120001 },
      { kind: 'tex', entry: '../main.tex' },
      { kind: 'tex', entry: '/tmp/main.tex' },
      { kind: 'tex', entry: 'main.tex', args: ['-shell-escape'] },
      { kind: 'tex', entry: 'main.tex', command: 'latexmk' },
      { kind: 'tex', entry: 'missing.tex' },
      { kind: 'command', command: 'node', cwd: '/' },
    ];
    for (const request of invalid) {
      const result = await executeVerification({ cwd, ...request });
      assert.equal(result.status, 'denied', JSON.stringify(request));
      assert.equal(result.capabilities, null);
    }
  });
});

test('already-aborted request never starts verification', async () => {
  await fixture(async cwd => {
    const controller = new AbortController();
    controller.abort();
    const result = await executeVerification({ cwd, kind: 'command', command: 'node', signal: controller.signal });
    assert.equal(result.status, 'aborted');
    assert.equal(result.capabilities, null);
  });
});

test('fake tools supplied via PATH cannot become capabilities', async () => {
  await fixture(async dir => {
    const marker = path.join(dir, 'executed');
    await writeFile(path.join(dir, 'bwrap'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    const previous = process.env.PATH;
    process.env.PATH = dir;
    try {
      const capabilities = await probeVerification();
      assert.notEqual(capabilities.tools.bwrap.path, path.join(dir, 'bwrap'));
      await assert.rejects(access(marker));
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    }
  });
});

test('installed but unusable bubblewrap fails closed, never runs requested argv on host', async t => {
  // Mock only system discovery/probes: no real project code executes in this test.
  const calls = [];
  const originalStat = fsPromises.stat;
  t.mock.method(fsPromises, 'access', async () => {});
  t.mock.method(fsPromises, 'stat', async file =>
    file.startsWith('/usr/bin/') ? { isFile: () => true } : originalStat(file));
  t.mock.method(childProcess, 'execFile', (file, args, options, callback) => {
    calls.push({ file, args, options });
    const child = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = () => {};
    queueMicrotask(() => {
      if (args.includes('--unshare-all')) callback(Object.assign(new Error('namespace denied'), { code: 1 }), '', 'Operation not permitted');
      else callback(null, 'version', '');
    });
    return child;
  });
  syncBuiltinESMExports();
  try {
    await fixture(async cwd => {
      const result = await executeVerification({ cwd, kind: 'command', command: 'python3', args: ['-c', 'PROJECT_CODE_MUST_NOT_RUN'] });
      assert.equal(result.status, 'denied');
      assert.equal(result.capabilities.sandboxUsable, false);
      assert.equal(result.capabilities.tools.bwrap.available, true);
      assert.ok(calls.some(call => call.args.includes('--unshare-all')));
      assert.ok(calls.every(call => !call.args.includes('PROJECT_CODE_MUST_NOT_RUN')));
      for (const call of calls) {
        assert.equal(call.options.shell, false);
        assert.equal(call.options.detached, true);
        assert.deepEqual(Object.keys(call.options.env).sort(), ['HOME', 'LANG', 'PATH', 'TMPDIR']);
      }
      const probe = calls.find(call => call.args.includes('--unshare-all'));
      assert.ok(probe.args.includes('--cap-drop'));
      assert.ok(probe.args.includes('--clearenv'));
      assert.ok(probe.args.includes('--nproc=64'));
      assert.ok(!probe.args.includes('--share-net'));
      assert.ok(!probe.args.includes('/home'));
      // '/' is only a remount target, never a host-root bind source.
      for (let i = 0; i < probe.args.length; i++) {
        if (['--bind', '--ro-bind'].includes(probe.args[i])) assert.notEqual(probe.args[i + 1], '/');
        if (probe.args[i] === '/') assert.equal(probe.args[i - 1], '--remount-ro');
      }
      assert.ok(probe.args.includes('--remount-ro'));
    });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('missing bubblewrap fails closed without trying another executor', async t => {
  t.mock.method(fsPromises, 'access', async () => { throw new Error('missing'); });
  syncBuiltinESMExports();
  try {
    await fixture(async cwd => {
      const result = await executeVerification({ cwd, kind: 'command', command: 'node', args: ['-e', 'throw Error("must not run")'] });
      assert.equal(result.status, 'denied');
      assert.equal(result.capabilities.tools.bwrap.available, false);
      assert.equal(result.capabilities.sandboxUsable, false);
      assert.deepEqual(result.artifacts, []);
    });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
