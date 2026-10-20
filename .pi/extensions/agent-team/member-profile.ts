import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** Default members keep normal Pi discovery. No global --no-extensions/--no-mcp.
 * Mirror extra temporary (CLI-loaded) extensions known through the public tool/command metadata. */
export function leadMemberProfile(pi: any, agentDir: string, fallbackGuard: string) {
  const sources = [...(pi.getCommands?.() ?? []), ...(pi.getAllTools?.() ?? [])].map(item => item.sourceInfo).filter(Boolean);
  const guard = sources.find(source => /(?:^|\/)safety-guard\.[cm]?[jt]s$/.test(source.path ?? ''))?.path
    ?? (existsSync(join(agentDir, 'extensions/safety-guard.ts')) ? join(agentDir, 'extensions/safety-guard.ts') : fallbackGuard);
  if (!readFileSync(guard, 'utf8').includes('agent-team:approval'))
    throw new Error(`Lead safety-guard does not support central approvals: ${guard}. Update it before spawning; do not load a second conflicting copy.`);
  const candidatePaths = [...sources.filter(source => source.scope === 'temporary').map(source => source.path),
    ...(pi.getMcpServers?.() ?? []).map((server: any) => server.extensionPath)];
  const extensions: string[] = [...new Set<string>(candidatePaths.filter(path =>
    typeof path === 'string' && isAbsolute(path) && /\.[cm]?[jt]s$/.test(path) && existsSync(path)))];
  return { guard, extensions, activeTools: pi.getActiveTools?.() as string[] | undefined };
}

export function memberLaunchArgs(options: { bridge: string; relay: string; guard: string; config: string;
  extensions: string[]; readOnly?: boolean; trustedProject?: boolean }) {
  const args: string[] = [];
  if (options.readOnly) args.push('--no-extensions', '--no-mcp', '--no-approve');
  else if (options.trustedProject) args.push('--approve'); // Only the same already-trusted lead project/worktree.
  for (const path of new Set([options.bridge, options.relay, options.guard, ...(options.readOnly ? [] : options.extensions)]))
    args.push('--extension', path);
  args.push('--team-approval-config', options.config);
  return args;
}
