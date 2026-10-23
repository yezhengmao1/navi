import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseCommand, saveEvidence, saveReport } from '../lib/review.mjs';

test('commands handle team, quoted spaces, cancellation is caller controlled', () => {
  assert.deepEqual(parseCommand('code'), { kind: 'code', target: 'HEAD', team: false });
  assert.deepEqual(parseCommand('paper "my paper/main.tex" --team'), { kind: 'paper', target: 'my paper/main.tex', team: true });
  assert.deepEqual(parseCommand('code HEAD~2 --team'), { kind: 'code', target: 'HEAD~2', team: true });
  assert.throws(() => parseCommand('paper'));
  assert.throws(() => parseCommand(''));
});

test('evidence and revision reports round trip without overwrites', async t => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magic-report-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const evidence = { kind: 'commit', sha: 'a'.repeat(40), coverage: { complete: false } };
  const saved = await saveEvidence(cwd, evidence);
  assert.deepEqual(JSON.parse(await readFile(saved.evidencePath, 'utf8')), evidence);
  const report = { id: saved.id, summary: 'Review', reviewed: ['a.js'], limitations: ['Tests not run'], findings: [] };
  const first = await saveReport(cwd, report);
  const second = await saveReport(cwd, report);
  assert.notEqual(first.jsonPath, second.jsonPath);
  assert.match(await readFile(first.markdownPath, 'utf8'), /not proof of correctness/);
  assert.equal(JSON.parse(await readFile(first.jsonPath, 'utf8')).collectionCoverage.complete, false);
  await assert.rejects(saveReport(cwd, { ...report, id: '../../escape' }));
});

test('large evidence strings are losslessly readable by physical line paging', async t => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magic-large-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const diff = 'some source text with newline\n'.repeat(10000);
  const saved = await saveEvidence(cwd, { diff });
  const text = await readFile(saved.evidencePath, 'utf8');
  assert.ok(text.split('\n').every(line => Buffer.byteLength(line) < 50000));
  assert.equal(JSON.parse(text).diff.chunks.join(''), diff);
});

test('artifact directory symlinks are rejected', async t => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magic-link-'));
  const other = await mkdtemp(path.join(os.tmpdir(), 'magic-other-'));
  t.after(() => Promise.all([cwd, other].map(x => rm(x, { recursive: true, force: true }))));
  await symlink(other, path.join(cwd, '.local'));
  await assert.rejects(saveEvidence(cwd, {}), /Unsafe/);
});
