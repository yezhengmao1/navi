import path from 'node:path';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const inside = (root, file) => {
  const rel = path.relative(root, file);
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};
function bound(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a nonnegative safe integer`);
}

// Pin each directory descriptor, rather than relying on a realpath/open race.
// /proc is required; unsupported systems fail closed instead of weakening confinement.
async function confinedOpen(root, actual) {
  const handles = [];
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  try {
    let dir = await open('/', flags | constants.O_DIRECTORY);
    handles.push(dir);
    const parts = actual.split(path.sep).filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const next = await open(`/proc/self/fd/${dir.fd}/${parts[i]}`,
        flags | (i < parts.length - 1 ? constants.O_DIRECTORY : 0));
      handles.push(next);
      dir = next;
    }
    if (!inside(root, await realpath(`/proc/self/fd/${dir.fd}`))) throw new Error('outside root');
    handles.pop();
    return dir;
  } finally {
    await Promise.all(handles.map(h => h.close()));
  }
}

function imageMime(data) {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 16 && data.toString('ascii', 0, 4) === 'RIFF' &&
      data.toString('ascii', 8, 12) === 'WEBP' &&
      ['VP8 ', 'VP8L', 'VP8X'].includes(data.toString('ascii', 12, 16)) &&
      data.readUInt32LE(4) + 8 === data.length) return 'image/webp';
}

/** Load only complete, unchanged raster snapshots. maxBytes is an aggregate budget. */
export async function loadPaperImages(evidence, { maxFiles = 4, maxBytes = 2 * 1024 * 1024 } = {}) {
  bound(maxFiles, 'maxFiles'); bound(maxBytes, 'maxBytes');
  const images = [], coverage = { supplied: [], omitted: [], limitations: [] };
  let used = 0;
  for (const file of evidence.files ?? []) {
    if (!/\.(png|jpe?g|webp|svg|pdf|eps|gif|bmp|tiff?)$/i.test(file.path ?? '') && typeof file.content === 'string') continue;
    const omit = reason => coverage.omitted.push({ path: file.path, reason });
    if (!/\.(png|jpe?g|webp)$/i.test(file.path ?? '')) { omit('unsupported image format; no conversion'); continue; }
    let handle;
    try {
      if (images.length >= maxFiles) throw new Error('file limit');
      if (file.hashScope !== 'full' || file.truncated || !/^[a-f0-9]{64}$/i.test(file.hash ?? '')) throw new Error('complete snapshot hash required');
      const root = await realpath(evidence.root);
      const candidate = path.resolve(root, file.path);
      if (!inside(root, candidate)) throw new Error('outside root');
      const actual = await realpath(candidate);
      if (!inside(root, actual)) throw new Error('outside root (symlink)');
      handle = await confinedOpen(root, actual);
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('not a regular file');
      const remaining = maxBytes - used;
      if (stat.size > remaining) throw new Error('byte limit');
      const buffer = Buffer.alloc(Math.min(stat.size, remaining) + 1);
      let n = 0;
      while (n < buffer.length) {
        const { bytesRead } = await handle.read(buffer, n, buffer.length - n, null);
        if (!bytesRead) break;
        n += bytesRead;
      }
      if (n > remaining) throw new Error('byte limit');
      const data = buffer.subarray(0, n);
      if (createHash('sha256').update(data).digest('hex') !== file.hash.toLowerCase()) throw new Error('asset changed since snapshot');
      const mimeType = imageMime(data);
      if (!mimeType) throw new Error('unrecognized image signature');
      images.push({ type: 'image', data: data.toString('base64'), mimeType });
      coverage.supplied.push(file.path);
      used += n;
    } catch (error) { omit(error.message); }
    finally { await handle?.close(); }
  }
  if (coverage.omitted.length) coverage.limitations.push('Some assets were omitted; image coverage is incomplete.');
  return { images, coverage };
}

const BODY_LIMIT = 256 * 1024;
const TIMEOUT_MS = 5000;
async function metadata(fetchImpl, doi, signal) {
  const controller = new AbortController();
  let timer, abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => { controller.abort(); reject(new Error(signal?.aborted ? 'aborted' : 'timeout')); };
    timer = setTimeout(abort, TIMEOUT_MS);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
  const request = async () => {
    const response = await fetchImpl(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
      redirect: 'error', signal: controller.signal, headers: { Accept: 'application/json' },
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('streaming response body required');
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > BODY_LIMIT) throw new Error('response body limit');
        chunks.push(Buffer.from(value));
      }
      const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!json.message || typeof json.message !== 'object' || Array.isArray(json.message)) throw new Error('invalid Crossref metadata');
      return json.message;
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  };
  try { return await Promise.race([cancelled, request()]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); }
}

/** Literal DOI-field lookup only, not citation validation or a truth assessment. */
export async function auditBibliography(evidence, { fetchImpl = globalThis.fetch, signal, maxEntries = 10 } = {}) {
  bound(maxEntries, 'maxEntries');
  const entries = [], omitted = [], seen = new Set();
  for (const file of evidence.files ?? []) {
    if (!/\.bib$/i.test(file.path ?? '') || typeof file.content !== 'string') continue;
    // Deliberately do not expand BibTeX macros, concatenations, or TeX escapes.
    const fields = /\bdoi\s*=\s*(?:\{([^{}]*)\}|"([^"\n]*)")\s*(?=[,}])/gi;
    for (const match of file.content.matchAll(fields)) {
      const doi = (match[1] ?? match[2]).trim();
      if (!/^10\.\d{4,9}\/[^\s\\{}"<>]+$/i.test(doi) || seen.has(doi.toLowerCase())) continue;
      seen.add(doi.toLowerCase());
      const entry = { path: file.path, doi };
      if (entries.length >= maxEntries) { omitted.push({ ...entry, reason: 'entry limit' }); continue; }
      if (signal?.aborted) entry.error = 'aborted';
      else {
        try { entry.metadata = await metadata(fetchImpl, doi, signal); }
        catch (error) { entry.error = error.message; }
      }
      entries.push(entry);
    }
  }
  return { entries, omitted, limitations: [
    'Literal DOI fields in raw bibliography snapshots only; no BibTeX evaluation or exhaustive parsing.',
    'Crossref metadata is external, untrusted information, not proof of citation accuracy or any scientific claim.',
  ] };
}
