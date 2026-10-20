import { stripVTControlCharacters } from 'node:util';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

const states: Record<string, string> = {
  starting: '◌ 启动中', ready: '○ 就绪', idle: '○ 空闲', done: '○ 空闲', working: '▶ 工作中',
  queued: '◷ 排队中', submitting: '◌ 派发中', 'awaiting-activity': '◌ 等待响应', running: '▶ 运行中',
  blocked: '! 等待处理', review: '◇ 待验收', completed: '✓ 已完成', failed: '✗ 失败',
  cancelled: '– 已取消', uncertain: '? 状态待核实', closed: '– 已关闭', stopped: '■ 已停止',
  interrupted: '■ 已中断', 'needs-inspection': '? 需要检查',
};
const clean = (value: unknown) => stripVTControlCharacters(String(value ?? '')).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
const badge = (state: string) => states[state] ?? clean(state);
const notifications: Record<string, string> = { wake: '唤醒 lead', message: '仅显示', silent: '静默' };
const ranks: Record<string, number> = { blocked: 0, uncertain: 1, 'needs-inspection': 1, review: 2, failed: 3, running: 4, working: 4, queued: 5, closed: 9 };
const priority = (state: string) => ranks[state] ?? 6;
const ordered = (items: any[]) => [...items].sort((a, b) => priority(a.state) - priority(b.state));

export function formatTeamStatus(data: any, memberLimit = 8, taskLimit = 6): string {
  const members = data.members ?? [], tasks = data.tasks ?? [];
  const lines = [`👥 团队 · ${clean(data.label || 'team')}  ${members.filter((m: any) => m.state !== 'closed').length}/${members.length} 位成员未关闭`];
  lines.push(`监控：${data.monitoring === undefined ? '未知' : data.monitoring ? '运行中' : '已暂停'}  派发：${data.dispatch === undefined ? '未知' : data.dispatch ? '开启' : '暂停'}${data.notify ? `  通知：${notifications[data.notify] ?? clean(data.notify)}` : ''}`);
  const counts = Object.entries(data.counts ?? {}).filter(([, count]) => count).map(([state, count]) => `${badge(state)} ${count}`);
  if (counts.length) lines.push(counts.join('  '));
  if (data.lastObservedAt) lines.push(`最近观测：${new Date(data.lastObservedAt).toLocaleTimeString('zh-CN', { hour12: false })}`);
  if (data.refreshing) lines.push('◌ 正在刷新，以下为最近一次状态');
  if (data.pollFailures) lines.push(`! 状态刷新失败 ${data.pollFailures} 次，正在退避重试；以下为旧快照`);
  lines.push('', '👤 成员');
  if (!members.length) lines.push('  暂无成员 · /team start <目标>');
  for (const m of ordered(members).slice(0, memberLimit)) {
    const active = tasks.find((t: any) => t.member === m.name && !['failed', 'completed', 'cancelled'].includes(t.state));
    lines.push(`  ${badge(m.state)}  ${clean(m.name)}${m.pane ? `  [${clean(m.pane)}]` : ''}${active ? `  · ${clean(active.id)}` : ''}${m.needsProfileRestart ? '  ! 旧配置，需重建' : ''}${data.busyMembers?.includes(m.name) ? '  ◌ 控制操作中' : ''}`);
  }
  if (members.length > memberLimit) lines.push(`  … 另有 ${members.length - memberLimit} 位成员`);
  lines.push('', '📋 任务');
  if (!tasks.length) lines.push('  暂无待处理任务');
  for (const t of ordered(tasks).slice(0, taskLimit)) {
    lines.push(`  ${badge(t.state)}  ${clean(t.id)} · ${clean(t.member)}  ${clean(t.task ?? t.text).slice(0, 100)}`);
    if (t.error) lines.push(`    原因：${clean(t.error).slice(0, 160)}`);
    if (t.waitingFor?.length) lines.push(`    等待：${t.waitingFor.map(clean).join('、')}`);
  }
  if (tasks.length > taskLimit) lines.push(`  … 另有 ${tasks.length - taskLimit} 项任务`);
  lines.push('', '/team read <成员> · /team task <ID> · /team hide 隐藏面板');
  return lines.join('\n');
}

export function formatTeamResult(data: any, expanded = false): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  if (data.hidden === true) return data.wasVisible ? '团队面板已隐藏（监控和任务不受影响）' : '团队面板当前未显示';
  if (Array.isArray(data.members) && Array.isArray(data.tasks)) return formatTeamStatus(data, expanded ? 64 : 8, expanded ? 200 : 6);
  if (Array.isArray(data)) return data.map(item => typeof item === 'string' ? clean(item) : formatTeamResult(item, expanded) ?? clean(item.name ?? item.state)).join('\n') || '没有需要操作的成员';
  if (typeof data.monitoring === 'boolean') return `团队监控${data.monitoring ? '已恢复' : '已暂停'} · 自动派发${data.dispatch ? '开启' : '暂停'} · 通知：${notifications[data.notify] ?? clean(data.notify)}`;
  if (data.id && data.member && data.state) {
    const lines = [`${badge(data.state)}  ${clean(data.id)} · ${clean(data.member)}`, clean(data.text)];
    if (data.dependsOn?.length) lines.push(`依赖：${data.dependsOn.map(clean).join('、')}`);
    if (data.error) lines.push(`原因：${clean(data.error)}`);
    if (data.output) lines.push('', stripVTControlCharacters(data.output));
    return lines.join('\n');
  }
  if (data.name && data.state) return `${badge(data.state)}  ${clean(data.name)}${data.pane ? `  [${clean(data.pane)}]` : ''}${data.cwd ? `\n目录：${clean(data.cwd)}` : ''}`;
  if (typeof data.text === 'string') return stripVTControlCharacters(data.text);
  return undefined;
}

/** Full available width, with one space of inner padding. Tiny terminals omit the frame. */
export function frameRows(rows: string[], width: number, border: (text: string) => string): string[] {
  width = Math.max(0, width);
  if (width < 6) return rows.map(line => truncateToWidth(line, width));
  const inner = width - 4;
  return [border(`┌${'─'.repeat(width - 2)}┐`), ...['', ...rows, ''].map(line => {
    const text = truncateToWidth(line, inner);
    return border('│ ') + text + ' '.repeat(Math.max(0, inner - visibleWidth(text))) + border(' │');
  }), border(`└${'─'.repeat(width - 2)}┘`)];
}

/** Render-time theme evaluation and terminal-column truncation, including CJK. */
export function teamPanel(text: string, theme: any) {
  return { invalidate() {}, render(width: number) {
    const [title, ...rows] = text.split('\n');
    const styled = [theme.fg('accent', title), '', ...rows.map(line => theme.fg(/✗/.test(line) ? 'error' : /[!?◇]/.test(line) ? 'warning' : /✓/.test(line) ? 'success' : 'text', line))];
    const framed = frameRows(styled, width, line => theme.fg('dim', line));
    return ['', ...framed.map(line => theme.bg ? theme.bg('customMessageBg', line) : line), ''];
  } };
}
