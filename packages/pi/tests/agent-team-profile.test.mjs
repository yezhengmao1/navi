import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { load } from './helpers.mjs';
const { leadMemberProfile, memberLaunchArgs } = await load('../../../../.pi/extensions/agent-team/member-profile');

test('default members preserve normal Pi plugins/MCP and mirror active tools; restrictions require explicit opt-in', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-member-profile-'));
  try {
    const guard = join(dir, 'safety-guard.ts'), extra = join(dir, 'temporary-network.ts');
    writeFileSync(guard, '// agent-team:approval'); writeFileSync(extra, '// temporary plugin');
    const pi = {
      getCommands: () => [{ sourceInfo: { path: guard, scope: 'user' } }],
      getAllTools: () => [{ sourceInfo: { path: extra, scope: 'temporary' } }, { sourceInfo: { path: 'builtin:read', scope: 'user' } }],
      getActiveTools: () => ['read', 'bash', 'mcp__network__search'],
    };
    const profile = leadMemberProfile(pi, dir, '/unused-fallback');
    assert.equal(profile.guard, guard); assert.deepEqual(profile.extensions, [extra]);
    assert.deepEqual(profile.activeTools, pi.getActiveTools());
    const options = { guard, bridge: '/bridge', relay: '/relay', config: '/config', extensions: profile.extensions };
    const normal = memberLaunchArgs(options);
    for (const flag of ['--no-extensions', '--no-mcp', '--no-approve', '--no-skills', '--no-context-files', '--tools']) assert.ok(!normal.includes(flag));
    assert.ok(normal.includes(extra)); assert.ok(!normal.includes('--approve'));
    assert.ok(memberLaunchArgs({ ...options, trustedProject: true }).includes('--approve'));
    const restricted = memberLaunchArgs({ ...options, readOnly: true, trustedProject: true });
    assert.ok(restricted.includes('--no-extensions')); assert.ok(restricted.includes('--no-mcp'));
    assert.ok(!restricted.includes(extra)); assert.ok(!restricted.includes('--approve'));
    writeFileSync(guard, '// obsolete guard');
    assert.throws(() => leadMemberProfile(pi, dir, '/unused-fallback'), /does not support central approvals/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
