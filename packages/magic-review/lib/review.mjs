import { mkdir, writeFile, readFile, realpath, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export function parseCommand(input) {
  const match = /^(code|paper)(?:\s+([\s\S]*))?$/.exec(input.trim());
  if (!match) throw new Error('Usage: /magic-review code [ref] [--team] | paper <entry.tex> [--team]');
  let target = (match[2] ?? '').trim();
  const team = /(?:^|\s)--team$/.test(target);
  if (team) target = target.replace(/(?:^|\s)--team$/, '').trim();
  if (target.length >= 2 && ((target.startsWith('"') && target.endsWith('"')) || (target.startsWith("'") && target.endsWith("'")))) target = target.slice(1, -1);
  if (match[1] === 'paper' && !target) throw new Error('Paper review requires a LaTeX entry path');
  return { kind: match[1], target: target || 'HEAD', team };
}

// Refuse symlinked artifact directories; avoid following project-provided links
// when writing review files. This is not an OS sandbox against concurrent changes.
async function artifactRoot(cwd) {
  let current = await realpath(cwd);
  for (const part of ['.local', 'magic-review']) {
    current = path.join(current, part);
    try { await mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe review artifact directory');
  }
  return current;
}

export async function saveEvidence(cwd, evidence) {
  const id = randomUUID();
  const directory = path.join(await artifactRoot(cwd), id);
  await mkdir(directory, { mode: 0o700 });
  const evidencePath = path.join(directory, 'evidence.json');
  // Pi read paginates physical lines. Bound JSON string lines too, including
  // minified source with no newlines, so every byte remains reachable by offset.
  const serialized = JSON.stringify(evidence, (_key, value) => {
    if (typeof value === 'string' && value.length > 4000) {
      return { encoding: 'concatenate-chunks', chunks: value.match(/[\s\S]{1,4000}/g) ?? [] };
    }
    return value;
  }, 2);
  await writeFile(evidencePath, serialized, { flag: 'wx', mode: 0o600 });
  return { id, evidencePath };
}

export async function saveReport(cwd, report) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(report.id)) throw new Error('Invalid review run ID');
  const directory = path.join(await artifactRoot(cwd), report.id);
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe review run directory');
  const evidencePath = path.join(directory, 'evidence.json');
  if ((await lstat(evidencePath)).isSymbolicLink()) throw new Error('Unsafe evidence file');
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  const result = { ...report, createdAt: new Date().toISOString(),
    source: { kind: evidence.kind, sha: evidence.sha, base: evidence.base, entry: evidence.entry },
    collectionCoverage: evidence.coverage };
  const lines = ['# Magic Review', '', report.summary, '', '## Source', '',
    `Kind: ${evidence.kind}; commit: ${evidence.sha ?? 'N/A'}; base: ${evidence.base ?? 'N/A'}; entry: ${evidence.entry?.path ?? evidence.entry?.target ?? 'N/A'}`, '',
    '## Reviewed', ...report.reviewed.map(x => `- ${x}`), '', '## Limitations',
    ...report.limitations.map(x => `- ${x}`), '', 'Collection coverage (not review coverage):',
    '```json', JSON.stringify(evidence.coverage, null, 2), '```', '', '## Findings'];
  if (!report.findings.length) lines.push('No validated findings within the reviewed scope. This is not proof of correctness.');
  for (const [i, finding] of report.findings.entries()) {
    lines.push('', `### ${i + 1}. [${finding.priority}] ${finding.title}`, '', `- Category: ${finding.category}`, `- Location: ${finding.location}`, `- Status: ${finding.status ?? 'open'}`, `- Independent verification: ${finding.verificationDecision ?? 'not recorded'}`);
    if (finding.verdict) lines.push(`- Verifier reason: ${finding.verdict.reason}`, `- Verifier evidence: ${finding.verdict.evidence}`);
    for (const key of ['evidence', 'triggerOrClaim', 'consequence', 'confidenceBasis', 'verification', 'suggestion']) lines.push(`- ${key}: ${finding[key]}`);
  }
  // New revision per save: never overwrite user files or follow an existing file link.
  const revision = randomUUID();
  const jsonPath = path.join(directory, `report-${revision}.json`);
  const markdownPath = path.join(directory, `report-${revision}.md`);
  await writeFile(jsonPath, JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
  await writeFile(markdownPath, lines.join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  return { id: report.id, jsonPath, markdownPath, findings: report.findings.length };
}
