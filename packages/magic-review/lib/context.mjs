import path from 'node:path';

export const CODE_LIMITS = Object.freeze({ commits: 50, files: 100, bytes: 2 * 1024 * 1024,
  fileBytes: 256 * 1024, searchTerms: 12, searchFiles: 20 });

/** All reads use immutable Git objects, never worktree paths or symlink targets. */
export async function collectContext(runGit, sha, changed) {
  const files = [], omissions = [], seen = new Set();
  let bytes = 0;
  const tree = await runGit(['ls-tree', '-r', '-z', '--full-tree', sha], { allowTruncation: true });
  const entries = new Map();
  const records = tree.text.split('\0');
  if (records.pop() !== '' || tree.truncated) omissions.push({ reason: 'tree listing byte limit' });
  for (const record of records) {
    const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]*)$/.exec(record);
    if (match) entries.set(match[4], { mode: match[1], type: match[2], oid: match[3] });
  }
  async function add(name, role, required = false) {
    if (seen.has(name)) {
      const existing = files.find(f => f.path === name);
      if (existing && !existing.roles.includes(role)) existing.roles.push(role);
      return;
    }
    const entry = entries.get(name);
    if (!entry && !required) return;
    seen.add(name);
    const omit = reason => omissions.push({ path: name, role, reason });
    if (!entry) return omit('absent at target or tree listing incomplete');
    if (entry.type !== 'blob' || !/^100(644|755)$/.test(entry.mode)) return omit('symlink or non-regular Git entry');
    if (files.length >= CODE_LIMITS.files) return omit('file count limit');
    const size = Number((await runGit(['cat-file', '-s', entry.oid])).text.trim());
    if (size > CODE_LIMITS.fileBytes || bytes + size > CODE_LIMITS.bytes) return omit('file or total byte limit; full content omitted');
    const content = (await runGit(['cat-file', 'blob', entry.oid])).text;
    if (content.includes('\0') || Buffer.byteLength(content) !== size) return omit('binary or non-UTF-8 content');
    bytes += size;
    files.push({ path: name, sha, oid: entry.oid, roles: [role], bytes: size, content });
  }
  for (const file of changed) await add(file.path, 'changed', true);
  const instructions = new Set(['AGENTS.md', 'CLAUDE.md']);
  for (const file of changed) {
    let dir = path.posix.dirname(file.path);
    while (dir !== '.') {
      for (const name of ['AGENTS.md', 'CLAUDE.md']) instructions.add(`${dir}/${name}`);
      dir = path.posix.dirname(dir);
    }
  }
  for (const name of instructions) await add(name, 'instructions');
  const terms = [...new Set(changed.map(f => path.posix.basename(f.path).replace(/\.[^.]*$/, '')))]
    .filter(s => /^[A-Za-z_][A-Za-z0-9_-]{2,79}$/.test(s));
  if (terms.length > CODE_LIMITS.searchTerms) omissions.push({ reason: 'search term limit' });
  const selected = terms.slice(0, CODE_LIMITS.searchTerms);
  if (selected.length) {
    const result = await runGit(['grep', '--no-ext-grep', '-I', '-l', '-z', '-F',
      ...selected.flatMap(s => ['-e', s]), sha, '--'], { allowTruncation: true, allowNoMatch: true });
    const names = result.text.split('\0');
    if (names.pop() !== '' || result.truncated) omissions.push({ reason: 'grep output incomplete' });
    const matches = names.map(s => s.slice(sha.length + 1)).filter(s => !seen.has(s));
    matches.sort((a, b) => Number(/test|spec/i.test(b)) - Number(/test|spec/i.test(a)));
    if (matches.length > CODE_LIMITS.searchFiles) omissions.push({ reason: 'search file limit' });
    for (const name of matches.slice(0, CODE_LIMITS.searchFiles)) await add(name, 'heuristic-test-or-caller');
  }
  return { sha, files, omissions, bytes, limits: CODE_LIMITS,
    coverage: { complete: omissions.length === 0, scope: 'selected context only; heuristic search is never exhaustive' },
    search: { terms: selected, exhaustive: false, method: 'git grep fixed filename stems; test-like paths prioritized' },
    limitations: ['Only target-tree contents; deletions have no target content.',
      'Instruction files are collected as untrusted evidence, not executed.',
      'Heuristic search is not symbol resolution or a complete caller/test graph.'] };
}
