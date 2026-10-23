import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { collectCommit, collectTex } from '../lib/collect.mjs';

async function fixture(t) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'collect-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
async function repo(t) {
  const cwd = await fixture(t);
  git(cwd, 'init', '-b', 'main');
  git(cwd, 'config', 'user.name', 'Test');
  git(cwd, 'config', 'user.email', 'test@example.com');
  git(cwd, 'config', 'commit.gpgsign', 'false');
  return cwd;
}
function commit(cwd, message) { git(cwd, 'add', '.'); git(cwd, 'commit', '-m', message); }

test('subdirectory collection ignores diff.relative config', async t => {
  const cwd = await repo(t);
  await mkdir(path.join(cwd, 'sub'));
  await writeFile(path.join(cwd, 'outside.txt'), 'outside');
  await writeFile(path.join(cwd, 'sub/inside.txt'), 'inside');
  commit(cwd, 'root');
  git(cwd, 'config', 'diff.relative', 'true');
  const result = await collectCommit(path.join(cwd, 'sub'));
  assert.deepEqual(result.files.map(f => f.path).sort(), ['outside.txt', 'sub/inside.txt']);
});

test('FIFO entry cannot block collection', { timeout: 3000 }, async t => {
  const cwd = await fixture(t);
  execFileSync('mkfifo', [path.join(cwd, 'blocked.tex')]);
  const result = await collectTex('blocked.tex', cwd);
  assert.equal(result.entry.status, 'unreadable');
});

test('aborted collections reject', async t => {
  const cwd = await repo(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(collectTex('a.tex', cwd, { signal: controller.signal }));
  await assert.rejects(collectCommit(cwd, 'HEAD', undefined, { signal: controller.signal }));
});

test('root evidence and immutable normal evidence ignore staged and unstaged edits', async t => {
  const cwd = await repo(t);
  await writeFile(path.join(cwd, 'a.txt'), 'original\n');
  commit(cwd, 'root');
  const root = await collectCommit(cwd);
  assert.equal(root.root, true);
  assert.deepEqual(root.parents, []);
  assert.equal(root.base, '4b825dc642cb6eb9a060e54bf8d69288fbee4904');
  assert.equal(root.metadata.message, 'root');
  assert.match(root.diff, /\+original/);
  assert.deepEqual(root.files, [{ status: 'A', path: 'a.txt' }]);
  await writeFile(path.join(cwd, 'a.txt'), 'committed\n');
  commit(cwd, 'second');
  await writeFile(path.join(cwd, 'a.txt'), 'staged secret\n');
  git(cwd, 'add', '.');
  await writeFile(path.join(cwd, 'a.txt'), 'unstaged secret\n');
  const next = await collectCommit(cwd);
  assert.equal(next.base, root.sha);
  assert.equal(next.root, false);
  assert.match(next.diff, /\+committed/);
  assert.doesNotMatch(next.diff, /secret/);
  assert.equal(next.coverage.complete, true);
});

test('NUL-separated names preserve tabs/newlines and rename paths', async t => {
  const cwd = await repo(t);
  const old = 'old\tname\n.txt', renamed = 'new\nname\t.txt';
  await writeFile(path.join(cwd, old), 'unchanged\n');
  commit(cwd, 'first');
  git(cwd, 'mv', old, renamed);
  commit(cwd, 'rename');
  const result = await collectCommit(cwd);
  assert.deepEqual(result.files, [{ status: 'R100', oldPath: old, path: renamed }]);
});

test('merges require explicit base and invalid refs are rejected', async t => {
  const cwd = await repo(t);
  await writeFile(path.join(cwd, 'a'), 'a'); commit(cwd, 'root');
  git(cwd, 'checkout', '-b', 'side');
  await writeFile(path.join(cwd, 'b'), 'b'); commit(cwd, 'side');
  git(cwd, 'checkout', 'main');
  await writeFile(path.join(cwd, 'c'), 'c'); commit(cwd, 'main');
  const base = git(cwd, 'rev-parse', 'HEAD');
  git(cwd, 'merge', '--no-ff', 'side', '-m', 'merge');
  await assert.rejects(collectCommit(cwd), /explicit base/);
  const result = await collectCommit(cwd, 'HEAD', base);
  assert.equal(result.parents.length, 2);
  assert.equal(result.base, base);
  for (const ref of ['--help', 'HEAD:a', 'HEAD\n', '', 'HEAD\\x']) {
    await assert.rejects(collectCommit(cwd, ref), /Invalid git ref/);
  }
  await assert.rejects(collectCommit(cwd, 'HEAD', '--help'), /Invalid git ref/);
});

test('large git diff reports bounded incomplete coverage', async t => {
  const cwd = await repo(t);
  await writeFile(path.join(cwd, 'large'), 'long line of text\n'.repeat(150000));
  commit(cwd, 'large');
  const result = await collectCommit(cwd);
  assert.equal(result.coverage.truncated, true);
  assert.equal(result.coverage.complete, false);
  assert.match(result.coverage.reasons.join(), /diff/);
});

test('TeX graph includes cycles, bibliography, graphics and local styles without execution', async t => {
  const cwd = await fixture(t);
  await mkdir(path.join(cwd, 'src'));
  const main = String.raw`% \input{ignored}
\input{child}
\include{missing}
\input{../secret}
\input{/etc/passwd}
\input{\dynamic}
\input{nested{macro}}
\bibliography{refs}
\addbibresource{extra.bib}
\includegraphics{figure}
\usepackage{local}
\% visible \input{escaped}
\\% \input{ignored2}
`;
  await writeFile(path.join(cwd, 'src/main.tex'), main);
  await writeFile(path.join(cwd, 'src/child.tex'), '\\subfile{main}\n');
  await writeFile(path.join(cwd, 'src/escaped.tex'), 'visible');
  await writeFile(path.join(cwd, 'src/refs.bib'), '@article{x}');
  await writeFile(path.join(cwd, 'src/extra.bib'), '@article{y}');
  await writeFile(path.join(cwd, 'src/local.sty'), 'style');
  await writeFile(path.join(cwd, 'src/figure.png'), Buffer.from([0, 1, 2]));
  await writeFile(path.join(cwd, 'secret.tex'), 'DO NOT READ');
  const result = await collectTex('src/main.tex', cwd);
  assert.equal(result.files.length, 7);
  const statuses = Object.fromEntries(result.references.map(r => [r.target, r.status]));
  assert.equal(statuses.main, 'visited');
  assert.equal(statuses.missing, 'missing');
  assert.equal(statuses['../secret'], 'outside');
  assert.equal(statuses['/etc/passwd'], 'outside');
  assert.equal(statuses['\\dynamic'], 'dynamic');
  assert.equal(statuses['nested{macro'], 'dynamic');
  assert.equal(statuses.escaped, 'collected');
  assert.equal(statuses.ignored, undefined);
  assert.equal(statuses.ignored2, undefined);
  const file = result.files.find(f => f.path === 'main.tex');
  assert.match(file.text, /^1: \n2: \\input\{child\}/);
  assert.equal(file.hash, createHash('sha256').update(main).digest('hex'));
  assert.equal(result.files.find(f => f.path === 'figure.png').text, undefined);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.truncated, false);
  assert.doesNotMatch(JSON.stringify(result), /DO NOT READ/);
});

test('TeX rejects symlink escape including entry and reports missing entry', async t => {
  const cwd = await fixture(t);
  await mkdir(path.join(cwd, 'src'));
  await writeFile(path.join(cwd, 'secret.tex'), 'secret');
  await symlink('../secret.tex', path.join(cwd, 'src/link.tex'));
  await writeFile(path.join(cwd, 'src/main.tex'), '\\input{link}');
  const result = await collectTex('src/main.tex', cwd);
  assert.equal(result.references[0].status, 'outside');
  assert.equal(result.files.length, 1);
  const entry = await collectTex('src/link.tex', cwd);
  assert.equal(entry.entry.status, 'outside');
  assert.equal(entry.files.length, 0);
  assert.equal((await collectTex('src/missing.tex', cwd)).entry.status, 'missing');
});

test('TeX file and byte caps are explicit', async t => {
  const cwd = await fixture(t);
  await writeFile(path.join(cwd, 'large.tex'), 'x'.repeat(300000));
  const large = await collectTex('large.tex', cwd);
  assert.equal(large.coverage.truncated, true);
  assert.equal(large.files[0].hashScope, 'prefix');
  assert.equal(large.files[0].bytes, large.coverage.limits.fileBytes);
  await writeFile(path.join(cwd, 'main.tex'), Array.from({ length: 105 }, (_, i) => `\\input{f${i}}`).join('\n'));
  await Promise.all(Array.from({ length: 105 }, (_, i) => writeFile(path.join(cwd, `f${i}.tex`), 'x')));
  const many = await collectTex('main.tex', cwd);
  assert.equal(many.files.length, 100);
  assert.equal(many.coverage.truncated, true);
  assert.ok(many.references.some(r => r.status === 'limited'));
});

test('TeX main-root priority, fallback, imports, local class and literal graphicspath', async t => {
  const cwd = await fixture(t);
  for (const dir of ['sections', 'sections/nested', 'assets']) await mkdir(path.join(cwd, dir), { recursive: true });
  const main = String.raw`\documentclass{custom}
\graphicspath{{assets/}}
\input{sections/chapter}
\import{sections/}{imported}
\includegraphics{plot}`;
  const contents = {
    'main.tex': main, 'custom.cls': '% class',
    'sections/chapter.tex': String.raw`\input{shared}\input{fallback}\subimport{nested/}{part}`,
    'shared.tex': 'root chosen', 'sections/shared.tex': 'fallback not chosen',
    'sections/fallback.tex': 'fallback chosen', 'sections/imported.tex': 'imported',
    'sections/nested/part.tex': 'nested', 'assets/plot.png': 'image',
  };
  for (const [name, content] of Object.entries(contents)) await writeFile(path.join(cwd, name), content);
  const result = await collectTex('main.tex', cwd);
  const names = result.files.map(f => f.path);
  assert.ok(names.includes('custom.cls'));
  assert.ok(names.includes('sections/fallback.tex'));
  assert.ok(names.includes('sections/imported.tex'));
  assert.ok(names.includes('sections/nested/part.tex'));
  assert.ok(names.includes('assets/plot.png'));
  assert.ok(!names.includes('sections/shared.tex'));
  const ambiguous = result.references.find(r => r.target === 'shared');
  assert.equal(ambiguous.ambiguous, true);
  assert.deepEqual(ambiguous.candidates, ['shared.tex', 'sections/shared.tex']);
  assert.equal(result.coverage.complete, false);
  assert.ok(result.diagnostics.some(d => d.kind === 'ambiguous-dependency'));
  assert.equal(result.files.find(f => f.path === 'main.tex').content, main);
});

test('TeX citation and label diagnostics are static observations, ignoring comments and dynamic keys', async t => {
  const cwd = await fixture(t);
  await writeFile(path.join(cwd, 'main.tex'), String.raw`% \label{commented}
\label{same}\label{same}
\ref{same}\eqref{missing}\ref{\dynamic}
\citep[see]{known,unknown}
\bibliography{refs}`);
  await writeFile(path.join(cwd, 'refs.bib'), '@article{known, title={Known}}');
  const result = await collectTex('main.tex', cwd);
  assert.equal(result.diagnostics.filter(d => d.kind === 'duplicate-label').length, 2);
  assert.deepEqual(result.diagnostics.filter(d => d.kind === 'unresolved-reference').map(d => d.key), ['missing']);
  assert.deepEqual(result.diagnostics.filter(d => d.kind === 'unresolved-citation').map(d => d.key), ['unknown']);
  assert.ok(!result.observations.some(o => o.key === 'commented' || o.key.includes('dynamic')));
  assert.match(result.limitations[0], /not proof/);
});
