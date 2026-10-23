import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRun, getRun, listRuns, updateRun, setFindingStatus, normalizeFindings, mergeFindings, compareRuns, RUN_STATES, DEFAULT_BUDGET } from '../lib/store.mjs';

async function fixture(t) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'review-store-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const id = randomUUID();
  const dir = path.join(cwd, '.local', 'magic-review', id);
  await mkdir(dir, { recursive: true });
  const evidencePath = path.join(dir, 'evidence.json');
  await writeFile(evidencePath, '{}');
  return { cwd, id, dir, evidencePath, args: { id, kind: 'code', target: 'HEAD', evidencePath } };
}
const finding = { location: 'src/a.mjs:10', category: 'correctness', title: 'Wrong result', triggerOrClaim: 'empty input' };

test('durable defaults and all states roundtrip without replay', async t => {
  const f = await fixture(t);
  const initial = await createRun(f.cwd, f.args);
  assert.equal(initial.schemaVersion, 1);
  assert.equal(initial.revision, 1);
  assert.deepEqual(initial.budget, DEFAULT_BUDGET);
  assert.deepEqual(initial.usage, { input: 0, output: 0, totalTokens: 0, cost: 0 });
  for (const state of RUN_STATES) {
    const saved = await updateRun(f.cwd, f.id, run => {
      run.state = state;
      run.stage = 'inspect';
      run.tasks = [{ id: 'task-1', state: 'running' }];
      run.calls++;
    });
    assert.deepEqual(await getRun(f.cwd, f.id), saved);
  }
  const moduleUrl = new URL('../lib/store.mjs', import.meta.url).href;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e',
    `import {getRun} from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(await getRun(${JSON.stringify(f.cwd)}, ${JSON.stringify(f.id)})));`], { encoding: 'utf8' });
  assert.equal(JSON.parse(output).state, 'interrupted');
  assert.deepEqual(await listRuns(f.cwd), [await getRun(f.cwd, f.id)]);
  await assert.rejects(createRun(f.cwd, f.args), /already exists/);
});

test('async concurrent mutations serialize without lost updates', async t => {
  const f = await fixture(t);
  await createRun(f.cwd, f.args);
  await Promise.all(Array.from({ length: 20 }, (_, i) => updateRun(f.cwd, f.id, async run => {
    await new Promise(resolve => setTimeout(resolve, 2));
    run.calls++;
    run.tasks.push({ id: String(i) });
    run.usage.input += 2;
    run.usage.totalTokens += 2;
  })));
  const run = await getRun(f.cwd, f.id);
  assert.equal(run.calls, 20);
  assert.equal(run.revision, 21);
  assert.equal(run.tasks.length, 20);
  assert.equal(run.usage.totalTokens, 40);
  assert.deepEqual((await readdir(f.dir)).sort(), ['evidence.json', 'run.json']);
});

test('independent processes share the same mutation lock', async t => {
  const f = await fixture(t);
  await createRun(f.cwd, f.args);
  const moduleUrl = new URL('../lib/store.mjs', import.meta.url).href;
  const script = `import {updateRun} from ${JSON.stringify(moduleUrl)};
    for (let i = 0; i < 5; i++) await updateRun(${JSON.stringify(f.cwd)}, ${JSON.stringify(f.id)}, async run => {
      await new Promise(resolve => setTimeout(resolve, 3)); run.calls++;
    });`;
  await Promise.all(Array.from({ length: 4 }, () => promisify(execFile)(process.execPath, ['--input-type=module', '-e', script])));
  const run = await getRun(f.cwd, f.id);
  assert.equal(run.calls, 20);
  assert.equal(run.revision, 21);
});

test('failed mutator/validation leaves original intact and releases lock', async t => {
  const f = await fixture(t);
  const original = await createRun(f.cwd, f.args);
  await assert.rejects(updateRun(f.cwd, f.id, async run => { run.calls++; throw new Error('stop'); }), /stop/);
  await assert.rejects(updateRun(f.cwd, f.id, run => { run.state = 'unknown'; }), /state/);
  await assert.rejects(updateRun(f.cwd, f.id, run => { run.id = randomUUID(); }), /Cannot change/);
  await assert.rejects(updateRun(f.cwd, f.id, run => { run.usage.cost = Infinity; }), /usage/);
  assert.deepEqual(await getRun(f.cwd, f.id), original);
  await updateRun(f.cwd, f.id, run => ({ ...run, calls: 1 }));
});

test('uncertain locks time out without stealing', async t => {
  const f = await fixture(t);
  await createRun(f.cwd, f.args);
  await mkdir(path.join(f.dir, '.store-lock'));
  await writeFile(path.join(f.dir, '.store-lock', 'owner'), 'unknown owner');
  await assert.rejects(updateRun(f.cwd, f.id, () => assert.fail('must not run'), { lockTimeoutMs: 30 }), /timed out/);
  assert.equal(await readFile(path.join(f.dir, '.store-lock', 'owner'), 'utf8'), 'unknown owner');
});

test('stable exact fingerprints, deduplication, triage and comparison', async t => {
  const f = await fixture(t);
  await createRun(f.cwd, f.args);
  const [one] = normalizeFindings([finding, { ...finding, title: 'Rephrased' }]);
  assert.equal(normalizeFindings([finding, finding]).length, 1);
  assert.equal(normalizeFindings([{ ...finding, id: 'untrusted' }])[0].id, one.id);
  assert.notEqual(normalizeFindings([{ ...finding, location: 'src/a.mjs:11' }])[0].id, one.id);
  await updateRun(f.cwd, f.id, run => { run.findings = [finding, finding]; });
  const triaged = await setFindingStatus(f.cwd, f.id, one.id, 'accepted', 'will fix');
  assert.equal(triaged.findings[0].note, 'will fix');
  assert.equal(mergeFindings(triaged.findings, [finding])[0].status, 'accepted');
  const different = { ...finding, triggerOrClaim: 'null input' };
  const compared = compareRuns(triaged, { findings: [different] });
  assert.equal(compared.added.length, 1);
  assert.equal(compared.persisting.length, 0);
  assert.equal(compared.notObserved[0].status, 'accepted');
  assert.equal(compareRuns(triaged, triaged).persisting.length, 1);
  await assert.rejects(setFindingStatus(f.cwd, f.id, one.id, 'closed'), /status/);
  await assert.rejects(setFindingStatus(f.cwd, f.id, 'missing', 'resolved'), /Unknown/);
});

test('reject traversal and evidence paths outside the existing run', async t => {
  const f = await fixture(t);
  for (const id of ['../escape', '/', `${f.id}/..`, '', 'not-a-uuid']) {
    await assert.rejects(getRun(f.cwd, id), /Invalid/);
    await assert.rejects(createRun(f.cwd, { ...f.args, id }), /Invalid/);
  }
  await assert.rejects(createRun(f.cwd, { ...f.args, evidencePath: path.join(f.cwd, 'evidence.json') }), /belong/);
  await assert.rejects(createRun(f.cwd, { ...f.args, evidencePath: `${f.dir}/../${f.id}/evidence.json` }), /Unsafe/);
  await assert.rejects(createRun(f.cwd, { ...f.args, id: randomUUID() }), /ENOENT/);
});

test('reject symlinks at artifact ancestors, run, evidence, state and lock', async t => {
  for (const component of ['.local', 'magic-review', 'run', 'evidence.json', 'run.json', '.store-lock']) {
    await t.test(component, async t => {
      const f = await fixture(t);
      await createRun(f.cwd, f.args);
      const victim = component === '.local' ? path.join(f.cwd, '.local')
        : component === 'magic-review' ? path.dirname(f.dir)
          : component === 'run' ? f.dir : path.join(f.dir, component);
      const outside = path.join(f.cwd, 'outside');
      if (component.endsWith('.json')) await writeFile(outside, '{}');
      else await mkdir(outside);
      await rm(victim, { recursive: true, force: true });
      await symlink(outside, victim);
      await assert.rejects(updateRun(f.cwd, f.id, () => assert.fail('must not mutate')), /Unsafe/);
      if (component !== '.store-lock') await assert.rejects(getRun(f.cwd, f.id), /Unsafe/);
      if (component.endsWith('.json')) assert.equal(await readFile(outside, 'utf8'), '{}');
    });
  }
});

test('list skips evidence-only runs; missing store is empty; corrupt state is explicit', async t => {
  const f = await fixture(t);
  assert.deepEqual(await listRuns(f.cwd), []);
  await createRun(f.cwd, f.args);
  await writeFile(path.join(f.dir, 'run.json'), '{broken');
  await assert.rejects(getRun(f.cwd, f.id), SyntaxError);
  await assert.rejects(listRuns(f.cwd), SyntaxError);
  await rm(path.join(f.cwd, '.local'), { recursive: true });
  assert.deepEqual(await listRuns(f.cwd), []);
});
