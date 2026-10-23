import { lstat, realpath, readdir, mkdir, rmdir, open, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const SCHEMA_VERSION = 1;
export const DEFAULT_BUDGET = Object.freeze({ maxCalls: 8, maxTokens: 100000, timeoutMs: 600000 });
export const RUN_STATES = Object.freeze(['prepared', 'running', 'verifying', 'completed', 'failed', 'cancelled', 'interrupted']);
export const FINDING_STATUSES = Object.freeze(['open', 'accepted', 'dismissed', 'resolved']);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function checkId(id) {
  if (typeof id !== 'string' || !uuid.test(id)) throw new Error('Invalid review run ID');
}
function text(value, name) {
  if (typeof value !== 'string' || !value.length) throw new Error(`Invalid ${name}`);
  return value;
}

// Exact identity, not fuzzy matching: edits to location/category/trigger create a new finding.
export function findingFingerprint(finding) {
  const identity = [text(finding.location, 'finding location'), text(finding.category, 'finding category'),
    text(finding.triggerOrClaim || finding.trigger || finding.title, 'finding trigger/title')];
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

export function normalizeFindings(findings = []) {
  if (!Array.isArray(findings)) throw new Error('Findings must be an array');
  const unique = new Map();
  for (const finding of findings) {
    const id = findingFingerprint(finding);
    const status = finding.status ?? 'open';
    if (!FINDING_STATUSES.includes(status)) throw new Error('Invalid finding status');
    if (finding.note !== undefined && typeof finding.note !== 'string') throw new Error('Invalid finding note');
    // First occurrence wins, including human triage, rather than silently overriding it.
    if (!unique.has(id)) unique.set(id, { ...finding, id, fingerprint: id, status });
  }
  return [...unique.values()];
}

export function mergeFindings(existing = [], incoming = []) {
  return normalizeFindings([...normalizeFindings(existing), ...normalizeFindings(incoming)]);
}

export function compareRuns(previous, current) {
  const reported = findings => normalizeFindings(findings).filter(f => !f.verificationDecision || f.verificationDecision === 'confirmed');
  const before = reported(previous.findings);
  const after = reported(current.findings);
  const oldIds = new Set(before.map(f => f.id));
  const newIds = new Set(after.map(f => f.id));
  return {
    added: after.filter(f => !oldIds.has(f.id)),
    persisting: after.filter(f => oldIds.has(f.id)),
    notObserved: before.filter(f => !newIds.has(f.id)),
  };
}

async function directory(file) {
  const stat = await lstat(file);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe review directory: ${file}`);
  return file;
}
async function root(cwd) {
  // cwd is the caller's trusted workspace; artifact descendants must never be links.
  const base = await realpath(cwd);
  return directory(path.join(await directory(path.join(base, '.local')), 'magic-review'));
}
async function runDirectory(cwd, id) {
  checkId(id);
  return directory(path.join(await root(cwd), id));
}
async function regular(file, optional = false) {
  try {
    const stat = await lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw new Error(`Unsafe review file: ${file}`);
  } catch (error) {
    if (optional && error.code === 'ENOENT') return false;
    throw error;
  }
  return true;
}
async function readJson(file) {
  await regular(file);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return JSON.parse(await handle.readFile('utf8')); } finally { await handle.close(); }
}
function validate(run) {
  if (run.schemaVersion !== SCHEMA_VERSION) throw new Error('Unsupported review store schema version');
  checkId(run.id);
  if (!['code', 'paper'].includes(run.kind)) throw new Error('Invalid review kind');
  text(run.target, 'target');
  text(run.evidencePath, 'evidencePath');
  if (run.previousId !== undefined) checkId(run.previousId);
  if (!RUN_STATES.includes(run.state)) throw new Error('Invalid run state');
  text(run.stage, 'stage');
  if (!Array.isArray(run.tasks)) throw new Error('Tasks must be an array');
  if (!Number.isSafeInteger(run.revision) || run.revision < 1) throw new Error('Invalid revision');
  if (!Number.isSafeInteger(run.calls) || run.calls < 0) throw new Error('Invalid calls');
  for (const key of ['createdAt', 'updatedAt']) {
    if (typeof run[key] !== 'string' || !Number.isFinite(Date.parse(run[key]))) throw new Error(`Invalid ${key}`);
  }
  for (const key of Object.keys(DEFAULT_BUDGET)) {
    if (!Number.isSafeInteger(run.budget?.[key]) || run.budget[key] < 0) throw new Error(`Invalid budget ${key}`);
  }
  for (const key of ['input', 'output', 'totalTokens', 'cost']) {
    const value = run.usage?.[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (key !== 'cost' && !Number.isSafeInteger(value))) throw new Error(`Invalid usage ${key}`);
  }
  run.findings = normalizeFindings(run.findings);
  return run;
}
async function load(dir, id) {
  const run = validate(await readJson(path.join(dir, 'run.json')));
  if (run.id !== id || run.evidencePath !== path.join(dir, 'evidence.json')) throw new Error('Run identity/path mismatch');
  await regular(run.evidencePath);
  return run;
}
async function syncDirectory(dir) {
  const handle = await open(dir, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function replace(dir, run) {
  const destination = path.join(dir, 'run.json');
  await regular(destination, true);
  const temporary = path.join(dir, `.run-${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try {
      await handle.writeFile(JSON.stringify(run, null, 2) + '\n');
      await handle.sync();
    } finally { await handle.close(); }
    await regular(destination, true);
    await rename(temporary, destination);
    await syncDirectory(dir);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

// Never steal locks: an abandoned lock requires explicit operator investigation.
// Like review.mjs, this is not a sandbox against concurrent ancestor-directory replacement.
async function locked(dir, action, { lockTimeoutMs = 2000 } = {}) {
  if (!Number.isFinite(lockTimeoutMs) || lockTimeoutMs < 0) throw new Error('Invalid lock timeout');
  const lock = path.join(dir, '.store-lock');
  const deadline = performance.now() + lockTimeoutMs;
  for (;;) {
    try { await mkdir(lock, { mode: 0o700 }); break; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await directory(lock);
      if (performance.now() >= deadline) throw new Error('Review store lock acquisition timed out; lock was not stolen');
      await delay(Math.min(20, Math.max(1, deadline - performance.now())));
    }
  }
  try { return await action(); } finally { await rmdir(lock); }
}

export async function createRun(cwd, { id, kind, target, evidencePath, budget, previousId }, options) {
  const dir = await runDirectory(cwd, id);
  if (typeof evidencePath !== 'string' || evidencePath.split(/[\\/]/).includes('..')) throw new Error('Unsafe evidence path');
  const resolved = path.resolve(cwd, evidencePath);
  if (resolved !== path.join(dir, 'evidence.json')) throw new Error('Evidence must belong to this run');
  await regular(resolved);
  return locked(dir, async () => {
    if (await regular(path.join(dir, 'run.json'), true)) throw new Error('Review run already exists');
    const now = new Date().toISOString();
    const run = validate({ schemaVersion: SCHEMA_VERSION, id, kind, target, evidencePath: resolved,
      ...(previousId === undefined ? {} : { previousId }), revision: 1, createdAt: now, updatedAt: now,
      state: 'prepared', stage: 'prepared', tasks: [], findings: [],
      usage: { input: 0, output: 0, totalTokens: 0, cost: 0 }, budget: { ...DEFAULT_BUDGET, ...budget }, calls: 0 });
    await replace(dir, run);
    return run;
  }, options);
}

export async function getRun(cwd, id) {
  return load(await runDirectory(cwd, id), id);
}

export async function listRuns(cwd) {
  let base;
  try { base = await root(cwd); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const runs = [];
  for (const name of (await readdir(base)).sort()) {
    if (!uuid.test(name)) continue;
    const dir = await directory(path.join(base, name));
    // Evidence-only runs predate the store and are not implicitly started.
    if (await regular(path.join(dir, 'run.json'), true)) runs.push(await load(dir, name));
  }
  return runs;
}

export async function updateRun(cwd, id, mutator, options) {
  const dir = await runDirectory(cwd, id);
  return locked(dir, async () => {
    const original = await load(dir, id);
    const draft = structuredClone(original);
    const result = (await mutator(draft)) ?? draft;
    for (const key of ['id', 'kind', 'target', 'evidencePath', 'previousId', 'schemaVersion', 'createdAt']) {
      if (result[key] !== original[key]) throw new Error(`Cannot change run ${key}`);
    }
    const run = validate({ ...result, revision: original.revision + 1, updatedAt: new Date().toISOString() });
    await replace(dir, run);
    return run;
  }, options);
}

export async function setFindingStatus(cwd, id, findingId, status, note) {
  if (!FINDING_STATUSES.includes(status)) throw new Error('Invalid finding status');
  if (note !== undefined && typeof note !== 'string') throw new Error('Invalid finding note');
  return updateRun(cwd, id, run => {
    const finding = run.findings.find(f => f.id === findingId);
    if (!finding) throw new Error('Unknown finding ID');
    finding.status = status;
    if (note !== undefined) finding.note = note;
  });
}
