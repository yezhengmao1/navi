import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

/** Use only the user's Herdr-managed integration, never a repository-supplied path.
 * This is a compatibility check, not signature verification: personal extensions must be trusted. */
export function resolveHerdrBridge(agentDir: string): string {
  const path = join(agentDir, 'extensions', 'herdr-agent-state.ts');
  try {
    const resolved = realpathSync(path);
    const source = readFileSync(resolved, 'utf8');
    if (!source.includes('HERDR_INTEGRATION_ID=pi') || !source.includes('pane.report_agent_session') ||
        /\bregister(?:Tool|Command|McpServer)\s*\(/.test(source))
      throw new Error('not a recognized status-only integration');
    return resolved;
  } catch (error) {
    throw new Error(`Read-only member needs the Herdr-managed status bridge at ${path}. Install/repair the Pi integration before spawning. ${String(error)}`);
  }
}
