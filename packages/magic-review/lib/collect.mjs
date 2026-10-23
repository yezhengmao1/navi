import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { collectContext, CODE_LIMITS } from './context.mjs';

const GIT_LIMIT = 2 * 1024 * 1024;
const TEX_LIMITS = Object.freeze({ files: 100, bytes: 2 * 1024 * 1024, fileBytes: 256 * 1024,
  references: 2000, observations: 5000, graphicPaths: 32 });

function git(cwd, args, { input, allowTruncation = false, allowNoMatch = false, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, {
      cwd, shell: false, timeout: 15000, maxBuffer: GIT_LIMIT, encoding: 'utf8', signal,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    }, (error, stdout, stderr) => {
      if (error && !(allowNoMatch && error.code === 1) && !(allowTruncation && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')) {
        reject(new Error(`git ${args[0]} failed: ${stderr || error.message}`, { cause: error }));
      } else resolve({ text: stdout, truncated: error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
    });
    child.stdin.on('error', () => {}); // A failed git process may close stdin early.
    child.stdin.end(input ?? '');
  });
}

function validateRef(ref) {
  if (typeof ref !== 'string' || !ref || ref.startsWith('-') || /[\s:\\\x00-\x1f\x7f]/u.test(ref)) {
    throw new Error('Invalid git ref');
  }
}

async function resolveCommit(cwd, ref, signal) {
  validateRef(ref);
  const { text } = await git(cwd, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], { signal });
  const sha = text.trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) throw new Error('Invalid resolved commit SHA');
  return sha;
}

function parseNames(text) {
  const tokens = text.split('\0');
  const terminated = tokens.pop() === '';
  const files = [];
  let complete = terminated;
  for (let i = 0; i < tokens.length;) {
    const status = tokens[i++];
    if (!/^[ACDMRTUXB][0-9]*$/.test(status)) { complete = false; break; }
    const count = /^[RC]/.test(status) ? 2 : 1;
    if (i + count > tokens.length) { complete = false; break; }
    if (count === 2) files.push({ status, oldPath: tokens[i++], path: tokens[i++] });
    else files.push({ status, path: tokens[i++] });
  }
  return { files, complete };
}

/** Collect committed evidence only (ignores index/worktree). base is an optional
 * commit ref, required for merges. base is an empty-tree OID for root commits.
 * coverage.complete is false whenever bounded diff/name output was truncated.
 */
export async function collectCommit(cwd, ref = 'HEAD', base, { signal } = {}) {
  const runGit = (args, options = {}) => git(cwd, args, { ...options, signal });
  const sha = await resolveCommit(cwd, ref, signal);
  const parentText = (await runGit(['rev-list', '--parents', '-n', '1', sha, '--'])).text.trim();
  const parents = parentText.split(/\s+/).slice(1);
  const root = parents.length === 0;
  if (parents.length > 1 && base === undefined) throw new Error('Merge commit requires an explicit base');
  const baseSha = base !== undefined ? await resolveCommit(cwd, base, signal)
    : parents[0] ?? (await runGit(['hash-object', '-t', 'tree', '--stdin'])).text.trim();
  const common = ['--no-relative', '--no-ext-diff', '--no-textconv', '--no-color', '--find-renames', '--ignore-submodules=none'];
  const diff = await runGit(['diff', ...common, '--src-prefix=a/', '--dst-prefix=b/', baseSha, sha, '--'], { allowTruncation: true });
  const names = await runGit(['diff', ...common, '--name-status', '-z', baseSha, sha, '--'], { allowTruncation: true });
  const parsed = parseNames(names.text);
  const metadata = (await runGit(['show', '-s', '--no-show-signature', '--format=%an%x00%ae%x00%aI%x00%B', sha, '--'])).text;
  const [author, email, date, ...message] = metadata.split('\0');
  const reasons = [];
  if (diff.truncated) reasons.push('diff output exceeded byte limit');
  if (names.truncated || !parsed.complete) reasons.push('changed-file listing incomplete');
  return {
    kind: 'commit', sha, base: baseSha, root, parents,
    metadata: { author, email, date, message: message.join('\0').trimEnd() },
    files: parsed.files, diff: diff.text,
    coverage: { complete: reasons.length === 0, truncated: reasons.length > 0, reasons, maxOutputBytes: GIT_LIMIT },
  };
}

/** Single commit or aggregate A..B range. Ranges exclude A and include commits
 * reachable from B but not A; more than 50 commits is rejected, not sampled. */
export async function collectCode(cwd, target = 'HEAD', base, { signal } = {}) {
  signal?.throwIfAborted();
  const runGit = (args, options = {}) => git(cwd, args, { ...options, signal });
  // Normalize cwd so grep and tree paths remain repository-root-relative.
  const repo = (await runGit(['rev-parse', '--show-toplevel'])).text.replace(/\n$/, '');
  const rootGit = (args, options = {}) => git(repo, args, { ...options, signal });
  let result, commits;
  if (typeof target === 'string' && target.includes('..')) {
    const parts = target.split('..');
    if (parts.length !== 2 || !parts[0] || !parts[1] || parts[1].startsWith('.')) throw new Error('Expected explicit A..B range');
    if (base !== undefined) throw new Error('Range already specifies its base');
    const from = await resolveCommit(repo, parts[0], signal);
    const to = await resolveCommit(repo, parts[1], signal);
    const list = (await rootGit(['rev-list', '--reverse', '--max-count=51', `${from}..${to}`, '--'])).text.trim();
    const shas = list ? list.split('\n') : [];
    if (shas.length > CODE_LIMITS.commits) throw new Error('Range exceeds 50 commit limit');
    commits = [];
    for (const sha of shas) {
      const raw = (await rootGit(['show', '-s', '--no-show-signature', '--format=%P%x00%an%x00%ae%x00%aI%x00%B', sha, '--'])).text;
      const [parents, author, email, date, ...message] = raw.split('\0');
      commits.push({ sha, parents: parents ? parents.split(' ') : [], metadata: { author, email, date, message: message.join('\0').trimEnd() } });
    }
    result = await collectCommit(repo, to, from, { signal });
    result = { ...result, kind: 'range', range: { from, to, semantics: 'A..B aggregate tree diff; commits reachable from B excluding A' } };
  } else {
    result = await collectCommit(repo, target, base, { signal });
    commits = [{ sha: result.sha, parents: result.parents, metadata: result.metadata }];
  }
  const context = await collectContext(rootGit, result.sha, result.files);
  return { ...result, commits, context };
}

function stripComments(text) {
  return text.split('\n').map(line => {
    for (let i = 0; i < line.length; i++) {
      if (line[i] !== '%') continue;
      let slashes = 0;
      for (let j = i - 1; j >= 0 && line[j] === '\\'; j--) slashes++;
      if (slashes % 2 === 0) return line.slice(0, i);
    }
    return line;
  }).join('\n');
}

function references(text) {
  const result = [];
  const re = /\\(input|include|subfile|bibliography|addbibresource|includegraphics\*?|usepackage|RequirePackage|documentclass)(?![A-Za-z])\s*(?:\[[^\]]*\]\s*)?(?:\{([^}]*)\}|([^\s{}%]+))/g;
  for (const match of text.matchAll(re)) {
    const command = match[1].replace(/\*$/, '');
    const values = /^(bibliography|usepackage|RequirePackage)$/.test(command)
      ? (match[2] ?? match[3]).split(',') : [match[2] ?? match[3]];
    for (const value of values) result.push({ command, target: value.trim(), line: text.slice(0, match.index).split('\n').length });
  }
  const imports = /\\(import|subimport)\s*\{([^}]*)\}\s*\{([^}]*)\}/g;
  for (const match of text.matchAll(imports)) result.push({ command: match[1],
    target: path.isAbsolute(match[3]) || !match[2] ? match[3] : `${match[2].replace(/\/$/, '')}/${match[3]}`,
    line: text.slice(0, match.index).split('\n').length });
  return result.sort((a, b) => a.line - b.line);
}

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Bounded, static TeX dependency evidence. Paths resolve relative to the referring
 * file as fallback after the main root (ambiguities are reported); only literal
 * commands are recognized (not macro expansion/TeX semantics).
 * Root is the entry directory; realpaths must stay within it. Assets are hashed,
 * not executed. Text is comment-stripped and line numbered; hash covers raw bytes.
 * Unresolved packages are reported as missing, not searched in system TeX trees.
 */
export async function collectTex(entry, cwd = process.cwd(), { signal } = {}) {
  signal?.throwIfAborted();
  const entryPath = path.resolve(cwd, entry);
  const root = await realpath(path.dirname(entryPath));
  const files = [], refs = [], reasons = [], visited = new Set();
  const observations = [], graphics = [];
  const diagnostics = [];
  let bytes = 0;
  const relative = file => path.relative(root, file);

  async function visit(candidate, ref, isEntry = false) {
    signal?.throwIfAborted();
    if (!inside(root, candidate)) { ref.status = 'outside'; return; }
    let actual;
    try { actual = await realpath(candidate); }
    catch (error) {
      ref.status = error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'missing' : 'unreadable';
      return;
    }
    if (!inside(root, actual)) { ref.status = 'outside'; return; }
    ref.path = relative(actual);
    if (visited.has(actual)) { ref.status = 'visited'; return; }
    if (files.length >= TEX_LIMITS.files || bytes >= TEX_LIMITS.bytes) {
      ref.status = 'limited'; reasons.push('file or total byte limit reached'); return;
    }
    let handle;
    try {
      // Nonblocking open prevents FIFOs from hanging before the descriptor check.
      handle = await open(actual, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile()) { ref.status = 'unreadable'; return; }
      const limit = Math.min(TEX_LIMITS.fileBytes, TEX_LIMITS.bytes - bytes);
      const buffer = Buffer.alloc(limit + 1);
      let read = 0;
      while (read < buffer.length) {
        signal?.throwIfAborted();
        const chunk = await handle.read(buffer, read, buffer.length - read, null);
        if (!chunk.bytesRead) break;
        read += chunk.bytesRead;
      }
      const truncated = read > limit;
      const data = buffer.subarray(0, Math.min(read, limit));
      bytes += data.length;
      visited.add(actual);
      ref.status = 'collected';
      const textual = isEntry || /\.(tex|sty|bib|cls|ltx)$/i.test(actual);
      const text = textual ? stripComments(data.toString('utf8')) : undefined;
      files.push({ path: relative(actual), bytes: data.length, size: stat.size, truncated,
        hash: createHash('sha256').update(data).digest('hex'), hashScope: truncated ? 'prefix' : 'full',
        ...(text !== undefined ? { content: data.toString('utf8'), text: text.split('\n').map((line, i) => `${i + 1}: ${line}`).join('\n') } : {}),
      });
      if (truncated) reasons.push(`byte limit: ${relative(actual)}`);
      // Close before descending, keeping open descriptors bounded.
      await handle.close(); handle = undefined;
      if (text === undefined) return;
      const from = relative(actual);
      if (/\.bib$/i.test(actual)) {
        for (const m of text.matchAll(/@\w+\s*\{\s*([^,\s{}]+)\s*,/g)) {
          if (observations.length >= TEX_LIMITS.observations) { reasons.push('observation limit'); break; }
          observations.push({ kind: 'bibkey', key: m[1], from });
        }
        return;
      }
      for (const m of text.matchAll(/\\(label|ref|eqref|autoref|pageref|cref|Cref|cite\w*)\*?\s*(?:\[[^\]]*\]\s*)*\{([^{}]*)\}/g)) {
        if (observations.length >= TEX_LIMITS.observations) { reasons.push('observation limit'); break; }
        const kind = m[1] === 'label' ? 'label' : m[1].startsWith('cite') ? 'citation' : 'reference';
        for (const key of m[2].split(',').map(s => s.trim())) {
          if (observations.length >= TEX_LIMITS.observations) { reasons.push('observation limit'); break; }
          if (key && !/[\\#$~]/.test(key)) observations.push({ kind, key, from, line: text.slice(0, m.index).split('\n').length });
        }
      }
      for (const m of text.matchAll(/\\graphicspath\s*\{((?:\s*\{[^{}]*\}\s*)+)\}/g)) {
        for (const item of m[1].matchAll(/\{([^{}]*)\}/g)) {
          if (graphics.length >= TEX_LIMITS.graphicPaths) { reasons.push('graphicspath limit'); break; }
          if (!/[\\#$~]/.test(item[1])) graphics.push({ dir: item[1], from: path.dirname(actual) });
        }
      }
      for (const found of references(text)) {
        if (refs.length >= TEX_LIMITS.references) { reasons.push('reference limit'); break; }
        const child = { from: relative(actual), ...found };
        refs.push(child);
        if (!found.target || /[\\#$~{}]/.test(found.target)) { child.status = 'dynamic'; continue; }
        if (path.isAbsolute(found.target) || /^[a-zA-Z]:|^[a-zA-Z]+:\/\//.test(found.target)) { child.status = 'outside'; continue; }
        let extensions = [''];
        if (!path.extname(found.target)) {
          extensions = found.command === 'includegraphics' ? ['', '.pdf', '.png', '.jpg', '.jpeg', '.eps', '.svg']
            : /^(usepackage|RequirePackage)$/.test(found.command) ? ['.sty']
            : found.command === 'documentclass' ? ['.cls']
            : /^(bibliography|addbibresource)$/.test(found.command) ? ['.bib'] : ['.tex'];
        }
        const dirs = found.command === 'subimport' ? [path.dirname(actual)]
          : found.command === 'import' ? [root] : [root, path.dirname(actual)];
        if (found.command === 'includegraphics') {
          for (const g of graphics) dirs.push(path.resolve(root, g.dir), path.resolve(g.from, g.dir));
        }
        const candidates = [...new Set(dirs.flatMap(dir => extensions.map(ext => path.resolve(dir, found.target + ext))))];
        const available = [];
        let outside = false;
        for (const candidate of candidates) {
          signal?.throwIfAborted();
          if (!inside(root, candidate)) { outside = true; continue; }
          try {
            const canonical = await realpath(candidate);
            if (!inside(root, canonical)) { outside = true; continue; }
            if (!available.some(a => a.canonical === canonical)) available.push({ candidate, canonical });
          } catch (error) {
            if (!['ENOENT', 'ENOTDIR'].includes(error.code)) child.status = 'unreadable';
          }
        }
        child.candidates = available.map(a => relative(a.canonical));
        child.ambiguous = available.length > 1;
        if (child.ambiguous) diagnostics.push({ kind: 'ambiguous-dependency', from: child.from, line: child.line, candidates: child.candidates });
        if (available.length) await visit(available[0].candidate, child);
        else child.status ??= outside ? 'outside' : 'missing';
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      ref.status = 'unreadable'; ref.error = error.code ?? 'read error';
    }
    finally { if (handle) await handle.close(); }
  }

  // Use the canonical directory but do not canonicalize the entry before checking containment.
  const entryRef = { target: entry };
  await visit(path.join(root, path.basename(entryPath)), entryRef, true);
  const unresolved = [entryRef, ...refs].filter(r => !['collected', 'visited'].includes(r.status));
  const definitions = new Map();
  for (const item of observations) {
    const key = `${item.kind}:${item.key}`;
    definitions.set(key, (definitions.get(key) ?? 0) + 1);
  }
  for (const item of observations) {
    const definition = item.kind === 'citation' ? 'bibkey' : item.kind === 'reference' ? 'label' : undefined;
    if (definition && !definitions.has(`${definition}:${item.key}`)) diagnostics.push({ ...item, kind: `unresolved-${item.kind}` });
    if (item.kind === 'label' && definitions.get(`label:${item.key}`) > 1) diagnostics.push({ ...item, kind: 'duplicate-label' });
  }
  return { kind: 'tex', root, entry: entryRef, files, references: refs, observations, diagnostics,
    limitations: ['Static literal observations only; diagnostics are not proof of TeX errors.',
      'No macro expansion, conditional evaluation, TeX search paths, or scope simulation.',
      'Main-root paths precede referring-file fallback; import uses root and subimport uses referring directory.',
      'Literal graphicspath entries are accumulated, not TeX-scoped; ambiguous dependencies collect only the first candidate.'],
    coverage: { complete: unresolved.length === 0 && reasons.length === 0 && !refs.some(r => r.ambiguous),
      truncated: reasons.length > 0, reasons: [...new Set(reasons)], unresolved: unresolved.length,
      bytes, limits: TEX_LIMITS, mode: 'static-literal-only' } };
}
