import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadPaperImages, auditBibliography } from '../lib/paper-assets.mjs';

const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const jpeg = Buffer.from('ffd8ffe00000', 'hex');
const webp = Buffer.from('524946460c000000574542505650384c00000000', 'hex');
const snapshot = (name, data) => ({ path: name, hashScope: 'full', hash: createHash('sha256').update(data).digest('hex') });
async function fixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), 'paper-assets-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'root');
  await mkdir(root);
  return { base, root, files: [] };
}
async function asset(e, name, data) {
  await writeFile(path.join(e.root, name), data);
  e.files.push(snapshot(name, data));
}

test('loads signature-verified snapshot rasters with aggregate budgets', async t => {
  const e = await fixture(t);
  await asset(e, 'a.png', png); await asset(e, 'b.jpg', jpeg); await asset(e, 'c.webp', webp);
  const result = await loadPaperImages(e);
  assert.deepEqual(result.images.map(i => i.mimeType), ['image/png', 'image/jpeg', 'image/webp']);
  assert.equal(result.images[0].data, png.toString('base64'));
  assert.deepEqual(result.coverage.supplied, ['a.png', 'b.jpg', 'c.webp']);
  assert.equal((await loadPaperImages(e, { maxFiles: 1 })).images.length, 1);
  const bounded = await loadPaperImages(e, { maxBytes: png.length });
  assert.equal(bounded.images.length, 1);
  assert.equal(bounded.coverage.omitted.length, 2);
  assert.equal((await loadPaperImages(e, { maxBytes: 0 })).images.length, 0);
});

test('changed, partial, unsupported and disguised files produce coverage gaps', async t => {
  const e = await fixture(t);
  await asset(e, 'changed.png', png);
  await writeFile(path.join(e.root, 'changed.png'), Buffer.alloc(png.length));
  await asset(e, 'partial.png', png); e.files[1].hashScope = 'prefix';
  await asset(e, 'fake.jpg', Buffer.from('<svg/>'));
  await asset(e, 'figure.pdf', Buffer.from('%PDF-1.0'));
  const result = await loadPaperImages(e);
  assert.equal(result.images.length, 0);
  assert.match(result.coverage.omitted[0].reason, /changed/);
  assert.match(result.coverage.omitted[1].reason, /snapshot/);
  assert.match(result.coverage.omitted[2].reason, /signature/);
  assert.match(result.coverage.omitted[3].reason, /unsupported/);
  assert.ok(result.coverage.limitations.length);
});

test('rejects escapes, outside symlinks, missing files and directories', async t => {
  const e = await fixture(t);
  await writeFile(path.join(e.base, 'outside.png'), png);
  await symlink(path.join(e.base, 'outside.png'), path.join(e.root, 'link.png'));
  await symlink(e.base, path.join(e.root, 'escape'));
  await mkdir(path.join(e.root, 'dir.png'));
  e.files = ['../outside.png', 'link.png', 'escape/outside.png', 'missing.png', 'dir.png'].map(p => snapshot(p, png));
  const result = await loadPaperImages(e);
  assert.equal(result.images.length, 0);
  assert.equal(result.coverage.omitted.length, 5);
  for (const omission of result.coverage.omitted.slice(0, 3)) assert.match(omission.reason, /outside/);
});

const bib = content => ({ files: [{ path: 'refs.bib', content, text: 'not used' }] });
test('literal DOI requests are encoded, bounded and report metadata without claims', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ message: { title: ['Example'], DOI: '10.1234/a?b' } }));
  };
  const result = await auditBibliography(bib('@article{x, doi={10.1234/a?b}, title={X}}\n@misc{y, DOI="10.1234/a?b"}\n@misc{z,doi={10.5678/next}}'), { fetchImpl, maxEntries: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.crossref.org/works/10.1234%2Fa%3Fb');
  assert.equal(calls[0].options.redirect, 'error');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.deepEqual(result.entries[0].metadata.title, ['Example']);
  assert.equal(result.omitted.length, 1);
  assert.match(result.limitations.join(' '), /not proof/);
});

test('HTTP, parse, oversized body and fetch failures are reported', async () => {
  for (const [fetchImpl, pattern] of [
    [async () => new Response('no', { status: 404 }), /HTTP 404/],
    [async () => new Response('not json'), /JSON|Unexpected/],
    [async () => new Response('x'.repeat(256 * 1024 + 1)), /body limit/],
    [async () => { throw new Error('redirect rejected'); }, /redirect/],
  ]) {
    const result = await auditBibliography(bib('@misc{x,doi={10.1234/test}}'), { fetchImpl });
    assert.match(result.entries[0].error, pattern);
    assert.equal(result.entries[0].metadata, undefined);
  }
});

test('aborts in-flight requests even when the mock ignores cancellation', async () => {
  const controller = new AbortController();
  const result = await auditBibliography(bib('@misc{x,doi={10.1234/test}}'), {
    signal: controller.signal,
    fetchImpl: () => { queueMicrotask(() => controller.abort()); return new Promise(() => {}); },
  });
  assert.equal(result.entries[0].error, 'aborted');
});

test('no calls for pre-abort, zero budget, non-bib or nonliteral fields', async () => {
  const fetchImpl = () => { assert.fail('unexpected network call'); };
  const controller = new AbortController(); controller.abort();
  await auditBibliography(bib('@misc{x,doi={10.1234/test}}'), { fetchImpl, signal: controller.signal });
  await auditBibliography(bib('@misc{x,doi={10.1234/test}}'), { fetchImpl, maxEntries: 0 });
  await auditBibliography(bib('@misc{x,doi=macro # {10.1234/test}}'), { fetchImpl });
  await auditBibliography({ files: [{ path: 'main.tex', content: 'doi={10.1234/test}' }] }, { fetchImpl });
  await assert.rejects(loadPaperImages({}, { maxBytes: -1 }), /maxBytes/);
  await assert.rejects(auditBibliography({}, { maxEntries: Infinity }), /maxEntries/);
});
