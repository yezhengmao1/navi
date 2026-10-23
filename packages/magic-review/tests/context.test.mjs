import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectCode } from '../lib/collect.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
async function repo(t) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'context-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  git(cwd, 'init', '-b', 'main');
  git(cwd, 'config', 'user.name', 'Test');
  git(cwd, 'config', 'user.email', 'test@example.com');
  git(cwd, 'config', 'commit.gpgsign', 'false');
  return cwd;
}
function commit(cwd, message) { git(cwd, 'add', '.'); git(cwd, 'commit', '--allow-empty', '-m', message); return git(cwd, 'rev-parse', 'HEAD'); }

test('immutable changed contents, ancestor instructions and heuristic callers from subdirectory', async t => {
  const cwd = await repo(t);
  await mkdir(path.join(cwd, 'src'));
  for (const [name, content] of Object.entries({ 'AGENTS.md': 'root rules', 'src/CLAUDE.md': 'local rules',
    'src/widget.js': 'old', 'widget.test.js': 'import widget from "./src/widget.js";', 'caller.js': 'widget();' })) await writeFile(path.join(cwd, name), content);
  commit(cwd, 'initial');
  await writeFile(path.join(cwd, 'src/widget.js'), 'export const widget = 1;\n');
  const sha = commit(cwd, 'change');
  await writeFile(path.join(cwd, 'src/widget.js'), 'dirty');
  await writeFile(path.join(cwd, 'AGENTS.md'), 'dirty instructions');
  const result = await collectCode(path.join(cwd, 'src'));
  assert.equal(result.sha, sha);
  const files = Object.fromEntries(result.context.files.map(f => [f.path, f]));
  assert.equal(files['src/widget.js'].content, 'export const widget = 1;\n');
  assert.equal(files['AGENTS.md'].content, 'root rules');
  assert.equal(files['src/CLAUDE.md'].content, 'local rules');
  assert.ok(files['widget.test.js'].roles.includes('heuristic-test-or-caller'));
  assert.ok(files['caller.js']);
  assert.equal(result.context.omissions.length, 0);
});

test('explicit ranges have aggregate diff and immutable per-commit metadata', async t => {
  const cwd = await repo(t);
  await writeFile(path.join(cwd, 'a'), 'zero');
  const start = commit(cwd, 'start');
  await writeFile(path.join(cwd, 'a'), 'one'); const first = commit(cwd, 'first');
  await writeFile(path.join(cwd, 'a'), 'two'); const last = commit(cwd, 'last');
  const result = await collectCode(cwd, `${start}..HEAD`);
  assert.equal(result.kind, 'range');
  assert.equal(result.base, start);
  assert.equal(result.sha, last);
  assert.deepEqual(result.commits.map(c => c.sha), [first, last]);
  assert.deepEqual(result.commits.map(c => c.metadata.message), ['first', 'last']);
  assert.match(result.diff, /-zero/);
  assert.match(result.diff, /\+two/);
  assert.equal((await collectCode(cwd, 'HEAD..HEAD')).commits.length, 0);
  for (const range of ['HEAD...HEAD', '..HEAD', 'HEAD..', 'HEAD..HEAD..HEAD']) await assert.rejects(collectCode(cwd, range));
  await assert.rejects(collectCode(cwd, 'HEAD~1..HEAD', 'HEAD~1'), /already specifies/);
});

test('range bounds and cancellation', async t => {
  const cwd = await repo(t);
  const start = commit(cwd, 'start');
  for (let i = 0; i < 51; i++) commit(cwd, `commit ${i}`);
  await assert.rejects(collectCode(cwd, `${start}..HEAD`), /50 commit limit/);
  assert.equal((await collectCode(cwd, 'HEAD~50..HEAD')).commits.length, 50);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(collectCode(cwd, 'HEAD', undefined, { signal: controller.signal }));
});

test('omits symlinks, binary, oversized files and deletions without reading worktree', async t => {
  const cwd = await repo(t);
  await writeFile(path.join(cwd, 'deleted'), 'old'); commit(cwd, 'initial');
  await rm(path.join(cwd, 'deleted'));
  await symlink('/etc/passwd', path.join(cwd, 'AGENTS.md'));
  await writeFile(path.join(cwd, 'binary'), Buffer.from([0, 1, 2]));
  await writeFile(path.join(cwd, 'big'), 'x'.repeat(300000));
  const odd = 'odd\tname\n.txt';
  await writeFile(path.join(cwd, odd), 'literal');
  commit(cwd, 'change');
  const result = await collectCode(cwd);
  assert.equal(result.context.files.find(f => f.path === odd).content, 'literal');
  for (const name of ['deleted', 'AGENTS.md', 'binary', 'big']) assert.ok(result.context.omissions.some(o => o.path === name));
  assert.equal(result.context.files.length, 1);
});

test('context file count and total byte budgets omit full files explicitly', async t => {
  const cwd = await repo(t);
  for (let i = 0; i < 105; i++) await writeFile(path.join(cwd, `file${i}.txt`), 'small');
  commit(cwd, 'many files');
  const many = await collectCode(cwd);
  assert.equal(many.context.files.length, 100);
  assert.ok(many.context.omissions.some(o => o.reason === 'file count limit'));
  assert.equal(many.context.coverage.complete, false);
  for (let i = 0; i < 10; i++) await writeFile(path.join(cwd, `big${i}.txt`), 'x'.repeat(250000));
  commit(cwd, 'large files');
  const large = await collectCode(cwd);
  assert.ok(large.context.bytes <= large.context.limits.bytes);
  assert.equal(large.context.files.length, 8);
  assert.equal(large.context.omissions.filter(o => o.role === 'changed').length, 2);
  assert.ok(large.context.files.every(f => f.content.length === 250000));
});

test('Git evidence does not invoke configured external diff or textconv', async t => {
  const cwd = await repo(t);
  await writeFile(path.join(cwd, 'widget.txt'), 'first');
  await writeFile(path.join(cwd, '.gitattributes'), '*.txt diff=evil');
  commit(cwd, 'initial');
  await writeFile(path.join(cwd, 'widget.txt'), 'second');
  commit(cwd, 'second');
  // A command that fails makes accidental execution observable in the result.
  git(cwd, 'config', 'diff.external', 'false');
  git(cwd, 'config', 'diff.evil.command', 'false');
  git(cwd, 'config', 'diff.evil.textconv', 'false');
  const result = await collectCode(cwd);
  assert.match(result.diff, /\+second/);
  assert.equal(result.context.files.find(f => f.path === 'widget.txt').content, 'second');
});
