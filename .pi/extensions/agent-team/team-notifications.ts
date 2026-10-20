import type { TeamState, TaskState } from './team-controller.ts';

export interface TaskNotice { id: string; state: TaskState }
const relevant = new Set<TaskState>(['review', 'blocked', 'uncertain']);
export function currentNotices(state: TeamState, notices: TaskNotice[]) {
  return notices.filter(n => relevant.has(n.state) && state.tasks.find(t => t.id === n.id)?.state === n.state);
}
export function formatNotices(state: TeamState, notices: TaskNotice[]): string {
  const lines = notices.map(n => {
    const task = state.tasks.find(t => t.id === n.id)!;
    return `${task.id} (${task.member}) → ${task.state}\n${(task.error ?? task.output ?? '').slice(0, 400)}`;
  });
  let body = lines.join('\n\n');
  if (body.length > 10000) body = body.slice(0, 10000) + '\n[Summary truncated; use team status for all pending tasks.]';
  return `Team ${state.label}:\n${body}\nUse team read with id for task evidence. Review is not success: verify, then resolve. High-risk permission requests require the user in the lead UI.`;
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
