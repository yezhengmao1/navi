import type { TeamState, TaskState } from './team-controller.ts';
import { stripVTControlCharacters } from 'node:util';

export interface TaskNotice { id: string; state: TaskState }
const relevant = new Set<TaskState>(['review', 'blocked', 'uncertain']);
export function currentNotices(state: TeamState, notices: TaskNotice[]) {
  return notices.filter(n => relevant.has(n.state) && state.tasks.find(t => t.id === n.id)?.state === n.state);
}
export function formatNotices(state: TeamState, notices: TaskNotice[]): string {
  const clean = (value: string) => stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  const labels: Partial<Record<TaskState, string>> = { review: '◇ 待验收', blocked: '⚠ 等待处理', uncertain: '? 状态待核实' };
  const lines = notices.map(n => {
    const task = state.tasks.find(t => t.id === n.id)!;
    // Terminal capture can include startup banners, tool traces and older turns.
    // Preserve it in task evidence, never present its first lines as a result summary.
    const title = `${labels[task.state] ?? task.state} · ${clean(task.member)} · ${task.id}`;
    return task.error ? `${title}\n原因：${clean(task.error).slice(0, 240)}` : title;
  });
  let body = lines.join('\n');
  if (body.length > 10000) body = body.slice(0, 10000) + '\n（通知已截断，请查看完整团队状态。）';
  return `👥 ${clean(state.label)} · 成员状态更新\n${body}\n请读取任务证据并核验后再验收；待验收不代表成功。高危操作仍需用户在 lead 授权。`;
}

/** Hold events in the extension, not Pi's follow-up queue. Revalidate at delivery. */
export class PendingTeamNotices {
  private pending = new Map<string, TaskState>();
  add(notices: TaskNotice[]) { for (const n of notices) this.pending.set(n.id, n.state); }
  clear() { this.pending.clear(); }
  take(state: TeamState) {
    const notices = currentNotices(state, [...this.pending].map(([id, state]) => ({ id, state })));
    this.clear();
    if (state.notify === 'silent' || !notices.length) return undefined;
    return { content: formatNotices(state, notices), details: { notices }, wake: state.notify === 'wake' };
  }
}
