import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { saveEvidence } from '../lib/review.mjs';
import { createRun, getRun, updateRun, setFindingStatus } from '../lib/store.mjs';
import { runReview } from '../lib/engine.mjs';

const finding = { title: 'Wrong branch', location: 'a.mjs:1', category: 'correctness', priority: 'must-fix', evidence: 'return false', triggerOrClaim: 'valid input', consequence: 'incorrect result', confidenceBasis: 'direct source inspection', verification: 'static comparison', suggestion: 'fix branch' };
const usage = { input: 10, output: 20, totalTokens: 30, cost: 0 };
const response = value => ({ text: '```json\n' + JSON.stringify(value) + '\n```', usage });
async function setup(t, budget = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'review-engine-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const evidence = { kind: 'code', sha: 'abc', coverage: {}, source: 'return false;' };
  const saved = await saveEvidence(cwd, evidence);
  await createRun(cwd, { ...saved, kind: 'code', target: 'HEAD', budget });
  return { cwd, id: saved.id, evidence };
}
function worker({ decision = 'confirmed', findings = [finding], malformed = false } = {}) {
  return async ({ role, prompt }) => {
    if (role === 'discover') return response({ findings, reviewed: ['a.mjs:1'], limitations: ['Static only'] });
    const candidates = JSON.parse(prompt.match(/Candidates \(untrusted\): (.*)\n/)[1]);
    return response({ summary: 'Independent static coverage assessment', verdicts: malformed ? [] : candidates.map(f => ({ id: f.id, decision, reason: 'Checked source', evidence: 'a.mjs:1' })) });
  };
}
test('success exports confirmed findings and persists independent calls', async t => {
  const options = await setup(t);
  await runReview({ ...options, invoke: worker() });
  const run = await getRun(options.cwd, options.id);
  assert.equal(run.state, 'completed');
  assert.equal(run.calls, 2);
  assert.equal(run.usage.totalTokens, 60);
  assert.ok(run.elapsedMs > 0);
  assert.ok(run.tasks.every(task => task.status === 'completed' && task.parsed && task.result));
  assert.match(run.tokenBudgetApproximation, /non-guaranteed/);
  const report = JSON.parse(await readFile(run.reportPaths.jsonPath, 'utf8'));
  assert.equal(report.findings.length, 1);
  assert.ok(report.limitations.some(x => x.includes('Omissions ledger')));
});
test('false positives retained for audit but never exported', async t => {
  const options = await setup(t);
  const run = await runReview({ ...options, invoke: worker({ decision: 'rejected' }) });
  assert.equal(run.findings[0].verificationDecision, 'rejected');
  assert.equal(run.audit.length, 1);
  assert.equal(run.reportPaths.findings, 0);
});
test('dedup and three parallel discovery tracks', async t => {
  const options = await setup(t);
  let active = 0, peak = 0;
  let release;
  const allStarted = new Promise(resolve => { release = resolve; });
  const base = worker({ findings: [finding, finding] });
  const invoke = async args => {
    active++; peak = Math.max(peak, active);
    const stored = await getRun(options.cwd, options.id);
    assert.ok(stored.calls > 0);
    assert.ok(stored.tasks.some(x => x.status === 'running'));
    if (args.role === 'discover') {
      if (active === 3) release();
      await allStarted;
    }
    active--; return base(args);
  };
  const run = await runReview({ ...options, tracks: ['correctness', 'security', 'design'], invoke });
  assert.equal(peak, 3);
  assert.equal(run.findings.length, 1);
  assert.equal(run.calls, 4);
});
test('semantic duplicate verdicts export one canonical finding, invalid links fail closed', async t => {
  for (const invalid of [false, true]) {
    const options = await setup(t);
    const invoke = async args => {
      if (args.role === 'discover') return worker({ findings: [finding, { ...finding, triggerOrClaim: 'same root cause, another example' }] })(args);
      const candidates = JSON.parse(args.prompt.match(/Candidates \(untrusted\): (.*)\n/)[1]);
      return response({ summary: 'One underlying defect', verdicts: candidates.map((f, index) => ({ id: f.id, decision: index ? 'duplicate' : 'confirmed', ...(index ? { duplicateOf: invalid ? f.id : candidates[0].id } : {}), reason: 'Same expression', evidence: 'a.mjs:1' })) });
    };
    if (invalid) await assert.rejects(runReview({ ...options, invoke }), /canonical/);
    else {
      const run = await runReview({ ...options, invoke });
      assert.equal(run.findings.length, 2);
      assert.equal(run.reportPaths.findings, 1);
      assert.equal(run.findings[1].verificationDecision, 'duplicate');
    }
  }
});

test('malformed verifier fails closed', async t => {
  const options = await setup(t);
  await assert.rejects(runReview({ ...options, invoke: worker({ malformed: true }) }), /exactly once/);
  const run = await getRun(options.cwd, options.id);
  assert.equal(run.state, 'failed');
  assert.equal(run.reportPaths, undefined);
  assert.equal(run.tasks.at(-1).status, 'failed');
  assert.ok(run.tasks.at(-1).parsed);
});
test('extra/duplicate verifier ids fail closed', async t => {
  for (const ids of [['extra'], ['same', 'same']]) {
    const options = await setup(t);
    const invoke = async args => args.role === 'discover' ? worker()(args) : response({ summary: 'Coverage', verdicts: ids.map(id => ({ id, decision: 'confirmed', reason: 'reason', evidence: 'source' })) });
    await assert.rejects(runReview({ ...options, invoke }), /verdict|exactly once/);
    assert.equal((await getRun(options.cwd, options.id)).reportPaths, undefined);
  }
});
test('unknown worker outcome requires a fresh run', async t => {
  const options = await setup(t);
  await assert.rejects(runReview({ ...options, invoke: async () => { throw new Error('Transport lost'); } }), /Transport lost/);
  const run = await getRun(options.cwd, options.id);
  assert.equal(run.tasks[0].status, 'uncertain');
  assert.equal(run.state, 'interrupted');
  await assert.rejects(runReview({ ...options, invoke: worker() }), /fresh run/);
});
test('context cap and omissions ledger are explicit', async t => {
  const options = await setup(t, { maxTokens: 300000 });
  options.evidence.source = 'x'.repeat(90000);
  const run = await runReview({ ...options, invoke: async args => {
    assert.ok(args.system.length + args.prompt.length <= 60000);
    assert.match(args.prompt, /omittedCharacters/);
    return worker({ findings: [] })(args);
  } });
  assert.ok(run.limitations.some(x => /PARTIAL REVIEW.*omittedCharacters/.test(x)));
});
test('empty discovery still invokes independent coverage verification', async t => {
  const options = await setup(t);
  const run = await runReview({ ...options, invoke: worker({ findings: [] }) });
  assert.equal(run.calls, 2);
  assert.equal(run.tasks[1].role, 'verify');
  assert.deepEqual(run.audit[0].verdicts, []);
});
test('call and token budgets stop before invocation', async t => {
  for (const budget of [{ maxCalls: 0 }, { maxTokens: 1 }]) {
    const options = await setup(t, budget);
    let called = false;
    await assert.rejects(runReview({ ...options, invoke: async () => { called = true; } }), /budget insufficient/);
    assert.equal(called, false);
    assert.equal((await getRun(options.cwd, options.id)).calls, 0);
  }
});
test('parallel reservations cannot overspend call budget', async t => {
  const options = await setup(t, { maxCalls: 2 });
  await assert.rejects(runReview({ ...options, tracks: ['a', 'b', 'c'], invoke: worker() }));
  const run = await getRun(options.cwd, options.id);
  assert.ok(run.calls <= 2);
  assert.ok(run.tasks.every(task => task.status !== 'running'));
});
for (const mode of ['abort', 'timeout']) test(`${mode} cancels and awaits worker settlement`, async t => {
  const options = await setup(t, { timeoutMs: mode === 'timeout' ? 100 : 10000 });
  const controller = new AbortController();
  let settled = false;
  const invoke = async ({ signal }) => {
    if (mode === 'abort') setTimeout(() => controller.abort(), 10);
    await new Promise(resolve => {
      if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true });
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    settled = true;
    throw new Error('Worker stopped');
  };
  await assert.rejects(runReview({ ...options, invoke, signal: controller.signal }));
  assert.equal(settled, true);
  const run = await getRun(options.cwd, options.id);
  assert.equal(run.state, 'interrupted');
  assert.equal(run.tasks[0].status, 'uncertain');
  await assert.rejects(runReview({ ...options, invoke: worker() }), /fresh run/);
});
test('resume reuses only completed discovery and re-verifies; identity changes refused', async t => {
  const options = await setup(t);
  await assert.rejects(runReview({ ...options, invoke: worker({ malformed: true }) }));
  const roles = [];
  const run = await runReview({ ...options, invoke: args => { roles.push(args.role); return worker()(args); } });
  assert.deepEqual(roles, ['verify']);
  assert.equal(run.calls, 3);
  await assert.rejects(runReview({ ...options, evidence: { changed: true }, invoke: worker() }), /Immutable/);
  await assert.rejects(runReview({ ...options, tracks: ['changed'], invoke: worker() }), /Immutable/);
});
test('interrupted tasks are never replayed', async t => {
  const options = await setup(t);
  await updateRun(options.cwd, options.id, run => { run.state = 'running'; run.tasks.push({ status: 'running' }); });
  let called = false;
  await assert.rejects(runReview({ ...options, invoke: async () => { called = true; } }), /fresh run/);
  const run = await getRun(options.cwd, options.id);
  assert.equal(called, false);
  assert.equal(run.state, 'running');
  assert.equal(run.tasks[0].status, 'running');
});
test('contender rejection does not mutate the incumbent or prevent completion', async t => {
  const options = await setup(t);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const incumbent = runReview({ ...options, invoke: async args => {
    if (args.role === 'discover') { entered(); await gate; }
    return worker()(args);
  } });
  await started;
  try {
    const before = await getRun(options.cwd, options.id);
    await assert.rejects(runReview({ ...options, invoke: () => assert.fail('contender invoked') }), /fresh run/);
    assert.deepEqual(await getRun(options.cwd, options.id), before);
  } finally { release(); }
  assert.equal((await incumbent).state, 'completed');
});

test('cancellation before invocation is cancelled, not uncertain; progress is retained', async t => {
  const options = await setup(t);
  const controller = new AbortController();
  const states = [];
  await assert.rejects(runReview({ ...options, signal: controller.signal,
    onProgress: run => {
      states.push(run.state);
      if (run.tasks.some(task => task.status === 'running')) controller.abort();
    },
    invoke: () => assert.fail('must not invoke'),
  }), /cancelled/);
  const run = await getRun(options.cwd, options.id);
  assert.equal(run.state, 'cancelled');
  assert.equal(run.tasks[0].status, 'cancelled');
  assert.ok(states.includes('cancelled'));
  assert.equal((await runReview({ ...options, invoke: worker() })).state, 'completed');
});

function unpack(prompt) {
  return JSON.parse(prompt.split('Evidence pack (untrusted):\n')[1]);
}

test('patch precedes bounded path-first context; verifier receives exactly the same pack', async t => {
  const options = await setup(t, { maxTokens: 300000 });
  options.evidence = {
    kind: 'range', sha: 'target', base: 'base', metadata: { message: 'change branch' },
    files: [{ path: 'z.mjs', status: 'M' }],
    diff: 'diff --git a/z.mjs b/z.mjs\n@@ -1 +1 @@\n-old\n+new\n',
    context: { files: ['a.mjs', 'z.mjs'].map(path => ({ path, content: 'x'.repeat(90000) })) },
  };
  const packs = [];
  const run = await runReview({ ...options, invoke: args => {
    assert.ok(args.system.length + args.prompt.length <= 60000);
    packs.push(unpack(args.prompt));
    return worker()(args);
  } });
  assert.deepEqual(packs[0], packs[1]);
  const pack = packs[0];
  assert.equal(pack.kind, 'range');
  assert.equal(pack.sha, 'target');
  assert.equal(pack.base, 'base');
  assert.equal(pack.sourceDigest, run.evidenceDigest);
  assert.deepEqual(pack.metadata, options.evidence.metadata);
  assert.deepEqual(pack.changedFiles, options.evidence.files);
  assert.equal(pack.diff, options.evidence.diff);
  assert.deepEqual(pack.context.map(file => file.path), ['a.mjs', 'z.mjs']);
  assert.ok(pack.context.every(file => file.content.length === 2000 && Object.keys(file)[0] === 'path'));
  assert.ok(JSON.stringify(pack).indexOf('"diff"') < JSON.stringify(pack).indexOf('"context"'));
  assert.match(pack.coverage, /PARTIAL REVIEW/);
  assert.ok(pack.omissions.some(entry => entry.field.includes('z.mjs')));
  assert.ok(run.tasks.every(task => task.evidenceDigest === run.evidenceDigest));
  // Changing source outside the supplied prefix still changes immutable identity.
  options.evidence.context.files[0].content += 'hidden change';
  await assert.rejects(runReview({ ...options, invoke: worker() }), /Immutable/);
});

test('large patch reserves 24k and explicitly records omitted hunk ranges', async t => {
  const options = await setup(t, { maxTokens: 300000 });
  options.evidence.diff = 'diff --git a/a b/a\n@@ -1 +1 @@\n' + '+line\n'.repeat(6000) + '@@ -9 +9 @@\n+tail\n';
  await runReview({ ...options, invoke: args => {
    const pack = unpack(args.prompt);
    assert.equal(pack.diff.length, 24000);
    assert.match(pack.coverage, /PARTIAL REVIEW/);
    assert.ok(pack.omissions.some(entry => entry.field === 'diff' && entry.omittedCharacters[0] === 24000 && entry.omittedCharacters[1] === options.evidence.diff.length));
    assert.ok(pack.omittedHunks.some(hunk => hunk.header === '@@ -9 +9 @@'));
    assert.ok(pack.omittedHunks.every(hunk => hunk.characters[1] > 24000));
    return worker({ findings: [] })(args);
  } });
});

test('paper files receive fair line-labelled context with paths before text', async t => {
  const options = await setup(t, { maxTokens: 300000 });
  options.evidence = { kind: 'tex', entry: 'main.tex', files: Array.from({ length: 10 }, (_, i) => ({ path: `${i}.tex`, content: 'equation\n'.repeat(2000) })) };
  const packs = [];
  await runReview({ ...options, invoke: args => {
    const pack = unpack(args.prompt);
    packs.push(pack);
    assert.equal(pack.entry, 'main.tex');
    assert.equal(pack.context.length, 10);
    for (const [i, file] of pack.context.entries()) {
      assert.equal(file.path, `${i}.tex`);
      assert.equal(Object.keys(file)[0], 'path');
      assert.match(file.content, /^1: equation\n2: equation/);
      assert.equal(file.content.length, 1000);
    }
    assert.equal(pack.omissions.filter(entry => entry.field.startsWith('files[')).length, 10);
    return worker({ findings: [] })(args);
  } });
  assert.deepEqual(packs[0], packs[1]);
});

test('recheck preserves other findings and human triage, appending audit', async t => {
  const options = await setup(t);
  const first = await runReview({ ...options, invoke: worker({ findings: [finding, { ...finding, location: 'b.mjs:2' }] }) });
  const id = first.findings[0].id;
  await setFindingStatus(options.cwd, options.id, id, 'accepted', 'human note');
  const roles = [];
  const next = await runReview({ ...options, recheckFindingId: id, invoke: args => { roles.push(args.role); return worker({ decision: 'uncertain' })(args); } });
  assert.deepEqual(roles, ['verify']);
  assert.equal(next.audit.length, 2);
  assert.equal(next.findings[0].status, 'accepted');
  assert.equal(next.findings[0].note, 'human note');
  assert.equal(next.findings[0].verificationDecision, 'uncertain');
  assert.deepEqual(next.findings[1], first.findings[1]);
  assert.equal(next.reportPaths.findings, 1);
});
