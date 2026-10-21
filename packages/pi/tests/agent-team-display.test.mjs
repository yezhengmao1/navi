import test from 'node:test';
import assert from 'node:assert/strict';
import { load, tui } from './helpers.mjs';
const { formatTeamStatus, formatTeamResult, teamPanel, subagentStatusPanel } = await load('../../../../.pi/extensions/agent-team/team-display');

test('team summary is readable Chinese, prioritizes actionable tasks, and preserves IDs', () => {
  const data = { label: '代码审查', monitoring: false, dispatch: false, notify: 'wake', counts: { review: 1, completed: 3, blocked: 1 },
    members: [{ name: 'reviewer', state: 'working', pane: 'w:p1', needsProfileRestart: true }],
    tasks: [{ id: 'task-review', member: 'reviewer', state: 'review', task: '检查实现' },
      { id: 'task-block', member: 'reviewer', state: 'blocked', error: '需要证据', waitingFor: ['task-dependency'] }] };
  const text = formatTeamStatus(data);
  assert.match(text, /监控：已暂停/); assert.match(text, /✓ 已完成 3/); assert.match(text, /旧配置，需重建/);
  assert.match(text, /task-dependency/); assert.ok(text.indexOf('原因：需要证据') < text.indexOf('检查实现'));
  assert.doesNotMatch(text, /"members"/);
  assert.doesNotMatch(text, /\/team read|\/team task|\/team hide/);
  assert.equal(formatTeamResult(data), text);
  assert.match(formatTeamStatus(data, 0, 0), /另有 1 位成员/);
  assert.match(formatTeamStatus(data, 0, 0), /另有 2 项任务/);
  assert.match(formatTeamStatus({ members: [], tasks: [] }), /暂无成员/);
});

test('task evidence remains multiline and unknown/background results fall back to the original renderer content', () => {
  assert.match(formatTeamResult({ id: 'task-1', member: 'r', state: 'review', output: '第一行\n第二行' }), /第一行\n第二行/);
  assert.equal(formatTeamResult({ mode: 'parallel', results: [] }), undefined);
  assert.equal(formatTeamResult({ text: 'terminal\noutput' }), 'terminal\noutput');
  assert.match(formatTeamResult({ monitoring: false, dispatch: false, notify: 'silent' }), /已暂停.*静默/);
});

test('fallback subagent status uses transparent questionnaire-style framing', () => {
  const theme = { fg: (_color, text) => text, bg() { assert.fail('no background'); } };
  for (const width of [0, 1, 5, 6, 20, 100]) {
    const lines = subagentStatusPanel(['🤖 子任务 0/1', '[>] 运行中 中文成员'], width, theme);
    for (const line of lines) assert.ok(tui.visibleWidth(line) <= width);
    if (width >= 6) for (const line of lines) assert.equal(tui.visibleWidth(line), width);
  }
  const text = subagentStatusPanel(['🤖 子任务 0/1', '[>] 运行中 worker'], 100, theme).join('\n');
  assert.match(text, /⏳ 运行中 worker/); assert.match(text, /├─+┤/);
  assert.doesNotMatch(text, /🚀|\[>\]/);
});

test('panel rendering fits narrow CJK widths and evaluates the current theme per render', () => {
  const text = formatTeamStatus({ label: '\x1b[31m中文团队\x1b[0m', members: [], tasks: [], monitoring: true, dispatch: true });
  assert.ok(!text.includes('\x1b'));
  let calls = 0;
  const panel = teamPanel(text, { fg(_color, value) { calls++; return value; },
    bg() { assert.fail('team status panel must not paint a background'); } });
  for (const width of [0, 1, 8, 25, 80]) {
    const lines = panel.render(width);
    for (const line of lines) assert.ok(tui.visibleWidth(line) <= width);
    if (width >= 6) {
      assert.equal(lines[1], '┌' + '─'.repeat(width - 2) + '┐');
      assert.equal(lines.at(-2), '└' + '─'.repeat(width - 2) + '┘');
      assert.equal(lines[0], ''); assert.equal(lines.at(-1), '');
      assert.match(lines[3], /👥|…|\.\.\./);
      for (const line of lines.slice(1, -1)) assert.equal(tui.visibleWidth(line), width);
    }
  }
  const before = calls; panel.invalidate(); panel.render(80); assert.ok(calls > before);
});
