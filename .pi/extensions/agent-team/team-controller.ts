import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { allocateTeamPane, type Page } from './tab-layout.ts';
import { currentNotices, formatNotices, type TaskNotice } from './team-notifications.ts';

export type TaskState = 'queued' | 'submitting' | 'awaiting-activity' | 'running' | 'blocked' | 'review' | 'completed' | 'failed' | 'cancelled' | 'uncertain';
export interface LiveAgent {
  agent: string; agent_status: string; pane_id: string; terminal_id: string;
  agent_session?: { value: string }; completion_seq?: number;
}
export const ACTIVITY_GRACE_MS = 15000;
export interface TeamTask {
  id: string; member: string; text: string; dependsOn: string[]; state: TaskState;
  baseline?: number; active?: boolean; submittedAt?: number; output?: string; error?: string;
}
export interface Member {
  name: string; target: string; pane: string; cwd: string; instructions?: string;
  terminal?: string; session?: string; state: string; worktree?: string; branch?: string;
  tab?: string; slot?: number; approvalConfig?: string; profile?: 'inherited' | 'read-only' | 'custom-tools'; launchProfileVersion?: number;
}
export interface TeamState {
  version: 2; scope: string; label: string; anchor: string; rootAvailable?: boolean; cwd?: string;
  members: Member[]; tasks: TeamTask[]; notify: 'wake' | 'message' | 'silent';
  workspace?: string; pages?: Page[]; approvalDirectory?: string;
  resources: { kind: string; path?: string; pane?: string; branch?: string; state: string }[];
}
export interface TeamIO {
  herdr(args: string[]): Promise<any>;
  git(args: string[]): Promise<string>;
  save(state: TeamState): void;
  notify(text: string, wake: boolean, notices: TaskNotice[]): void;
  confirm(title: string, text: string): Promise<boolean>;
  check(): void;
  now?(): number;
  prepareMember?(member: Member, profile: { readOnly: boolean; tools?: string[]; trustedProject?: boolean }): Promise<string[]>;
}
const ready = (status: string) => status === 'idle' || status === 'done';
const bounded = (value: any) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > 16000 ? text.slice(0, 16000) + '\n[Truncated; inspect the member pane for full output.]' : text;
};

/** Injectable controller. The adapter serializes each member separately and owns cancellation. */
export class TeamController {
  private notices = new Map<string, TaskState>();
  lastObservedAt?: number;
  constructor(public state: TeamState, private io: TeamIO) {}
  private now() { return this.io.now?.() ?? Date.now(); }
  summary() {
    const counts: Record<string, number> = {};
    for (const task of this.state.tasks) counts[task.state] = (counts[task.state] ?? 0) + 1;
    return { label: this.state.label, lastObservedAt: this.lastObservedAt, counts,
      members: this.state.members.map(({ name, state, pane, tab, slot, cwd, worktree, profile, launchProfileVersion }) =>
        ({ name, state, pane, tab, slot, cwd, worktree, profile, needsProfileRestart: launchProfileVersion !== 2 })),
      pages: this.state.pages ?? [],
      tasks: this.state.tasks.filter(t => !['completed', 'cancelled'].includes(t.state)).map(t => ({
        id: t.id, member: t.member, state: t.state, task: t.text.slice(0, 120), error: t.error?.slice(0, 300),
        waitingFor: t.dependsOn.filter(id => this.state.tasks.find(d => d.id === id)?.state !== 'completed'),
      })),
      resources: this.state.resources,
    };
  }
  taskDetail(id: string) {
    const task = this.state.tasks.find(t => t.id === id);
    if (!task) throw new Error('Unknown task');
    return task;
  }
  pollDelay() {
    return this.state.tasks.some(t => ['submitting', 'awaiting-activity', 'running', 'blocked'].includes(t.state)) ? 3000
      : this.state.tasks.some(t => t.state === 'queued' && t.dependsOn.every(id => this.state.tasks.find(d => d.id === id)?.state === 'completed')) ? 3000 : 30000;
  }
  save() { this.io.check(); this.io.save(structuredClone(this.state)); }
  member(name: string) {
    const m = this.state.members.find(m => m.name === name);
    if (!m) throw new Error(`Unknown member: ${name}`);
    return m;
  }
  async verifyApprovalMember(name: string, session: string) {
    const m = this.member(name);
    const a = await this.live(m);
    if (a.agent_session?.value !== session || m.session !== session) throw new Error('Approval session changed');
  }
  private async live(m: Member, bind = false) {
    if (m.state === 'closed') throw new Error(`${m.name} is closed`);
    const a = (await this.io.herdr(['agent', 'get', m.target])).agent;
    return this.observe(m, a, bind);
  }
  private observe(m: Member, a: LiveAgent | undefined, bind = false) {
    this.io.check();
    if (!a || a.agent !== 'pi' || !a.terminal_id || !a.agent_session?.value)
      throw new Error(`${m.name}: no verified Pi session; inspect its pane manually`);
    if (m.terminal && (m.terminal !== a.terminal_id || m.session !== a.agent_session.value))
      throw new Error(`${m.name}: occupant/session changed; refusing to control it`);
    if (!m.terminal && !bind) throw new Error(`${m.name}: identity not bound; use recover after inspecting the pane`);
    if (m.pane !== a.pane_id && !m.terminal) throw new Error(`${m.name}: startup pane changed`);
    m.terminal = a.terminal_id; m.session = a.agent_session.value; m.pane = a.pane_id;
    return a;
  }
  private announce(task: TeamTask) {
    if (this.state.notify !== 'silent') this.notices.set(task.id, task.state);
  }
  private flushNotices() {
    if (!this.notices.size) return;
    const notices = currentNotices(this.state, [...this.notices].map(([id, state]) => ({ id, state })));
    this.notices.clear();
    if (this.state.notify !== 'silent' && notices.length) this.io.notify(
      formatNotices(this.state, notices), this.state.notify === 'wake', notices);
  }
  async create(p: any, cwd: string) {
    this.io.check();
    const rebuilding = !!(this.state.members.length || this.state.tasks.length || this.state.resources.length || this.state.pages?.length);
    if (rebuilding && this.state.members.some(m => m.state !== 'closed'))
      throw new Error('Team still has nonclosed members. Reuse them or close them before creating a new team location.');
    if (rebuilding && this.state.tasks.some(t => !['completed', 'failed', 'cancelled'].includes(t.state)))
      throw new Error('Team has unresolved tasks. Inspect evidence and resolve/cancel them before rebuilding; tasks will not be replayed.');
    if (!isAbsolute(cwd)) throw new Error('cwd must be absolute');
    const label = p.label ?? this.state.label;
    const topology = p.topology ?? 'current';
    if (!['current', 'tab', 'workspace'].includes(topology)) throw new Error('Unknown topology');
    if (!p.workspace) throw new Error('Caller workspace ID unavailable');
    if (rebuilding) {
      const ambiguous = (this.state.pages ?? []).filter(page => ['pending', 'uncertain'].includes(page.state));
      if (ambiguous.length) {
        const result = await this.io.herdr(['workspace', 'list']);
        this.io.check();
        if (!Array.isArray(result?.workspaces) || result.workspaces.some((w: any) => typeof w.workspace_id !== 'string' || !w.workspace_id))
          throw new Error('Cannot verify old workspaces; refusing to discard ambiguous allocation state.');
        const live = new Set(result.workspaces.map((w: any) => w.workspace_id));
        if (ambiguous.some(page => live.has(page.workspace)))
          throw new Error('Old layout is pending/uncertain in an existing workspace. Inspect and reconcile it before rebuilding.');
        // Missing workspaces prove these old allocation intents cannot own live panes.
        // Keep their full history; retire it only after successful location creation.
      }
    }
    let workspace = p.workspace;
    if (topology === 'workspace') {
      if (!await this.io.confirm('Create team location?', `Create ${topology} “${label}” in ${cwd}? Focus stays here.`))
        throw new Error('Cancelled');
      const args = topology === 'workspace' ? ['workspace', 'create'] : ['tab', 'create', '--workspace', p.workspace];
      const result = await this.io.herdr([...args, '--cwd', cwd, '--label', label, '--no-focus']);
      const pane = result.root_pane?.pane_id;
      if (!pane) throw new Error('Creation returned no root pane; inspect Herdr before retrying.');
      if (!result.workspace?.workspace_id) throw new Error('Creation returned no workspace ID; inspect before retrying.');
      workspace = result.workspace.workspace_id;
      this.state.resources.push({ kind: topology, pane, state: 'created' });
    }
    // A new round must start on fresh dedicated tabs, never fill an old page.
    // Preserve members, task evidence, resources and allocation intents for inspection.
    if (rebuilding) for (const page of this.state.pages ?? []) page.state = 'retired';
    this.state.workspace = workspace; this.state.cwd = cwd; this.state.label = label;
    if (p.notify) this.state.notify = p.notify;
    this.save();
    return this.state;
  }
  async spawn(p: any, defaults: { cwd: string; model?: string; thinking?: string; bridge?: string; workspace?: string; trustedProject?: boolean }) {
    this.io.check();
    if (p.readOnly && !defaults.bridge && !this.io.prepareMember) throw new Error('Read-only spawn requires the trusted Herdr status bridge');
    const workspace = this.state.workspace ?? defaults.workspace;
    if (!workspace) throw new Error('Caller workspace ID unavailable');
    if (!/^[a-z][a-z0-9_-]{0,19}$/.test(p.name ?? '')) throw new Error('name must match [a-z][a-z0-9_-]{0,19}');
    if (this.state.members.some(m => m.name === p.name)) throw new Error('Member already exists; reuse it or choose a new name.');
    if (!p.instructions?.trim()) throw new Error('instructions are required');
    if (this.state.members.filter(m => m.state !== 'closed').length >= 64) throw new Error('Maximum 64 live members per team');
    for (const id of p.dependsOn ?? []) if (!this.state.tasks.some(t => t.id === id)) throw new Error(`Unknown dependency ${id}`);
    if (p.task && this.state.tasks.length >= 200) throw new Error('Team task limit reached');
    let cwd = p.cwd ?? this.state.cwd ?? defaults.cwd;
    if (!isAbsolute(cwd)) throw new Error('cwd must be absolute');
    const id = randomUUID().slice(0, 8);
    let worktree: string | undefined, branch: string | undefined;
    if (p.worktree) {
      const root = (await this.io.git(['-C', cwd, 'rev-parse', '--show-toplevel'])).trim();
      if (!isAbsolute(root)) throw new Error('Git returned an invalid repository root');
      worktree = join(dirname(root), '.agent-team-worktrees', `${p.name}-${id}`);
      branch = `agent-team/${p.name}-${id}`;
      if (!await this.io.confirm('Create isolated worktree?', `${worktree}\nBranch: ${branch}\nStarts from HEAD; uncommitted changes are NOT copied. Worktree and branch will be retained after closing the member.`))
        throw new Error('Cancelled');
      const resource = { kind: 'worktree', path: worktree, branch, state: 'creating' };
      this.state.resources.push(resource); this.save();
      try {
        await this.io.git(['-C', root, 'worktree', 'add', '-b', branch, worktree, 'HEAD']);
        resource.state = 'created'; this.save();
      } catch (error) { resource.state = 'uncertain'; this.save(); throw error; }
      cwd = worktree;
    }
    this.state.workspace = workspace;
    const { pane, tab, slot } = await allocateTeamPane({ pages: this.state.pages ??= [], label: this.state.label, workspace, cwd,
      run: args => this.io.herdr(args), check: () => this.io.check(),
      save: pages => {
        // A close may retire a page while its split I/O is in flight. Never resurrect it
        // when the allocator commits its snapshot; the newly returned pane is still tracked.
        for (const page of pages) if (this.state.pages?.some(p => p.tab && p.tab === page.tab && p.state === 'retired')) page.state = 'retired';
        this.state.pages = pages; this.save();
      },
    });
    const m: Member = { name: p.name, target: `${p.name}-${id}`, pane, tab, slot, cwd, instructions: p.instructions, state: 'starting', worktree, branch,
      profile: p.readOnly ? 'read-only' : p.tools?.length ? 'custom-tools' : 'inherited', launchProfileVersion: 2 };
    this.state.members.push(m); this.save();
    const args = ['agent', 'start', m.target, '--kind', 'pi', '--pane', pane, '--timeout', '30000', '--', '--name', m.target];
    if (p.model ?? defaults.model) args.push('--model', p.model ?? defaults.model);
    if (p.thinking ?? defaults.thinking) args.push('--thinking', p.thinking ?? defaults.thinking);
    // Built-in read-only tool preset; disabling extensions/MCP prevents callable-tool escape paths.
    if (p.readOnly) {
      if (!this.io.prepareMember) args.push('--no-extensions', '--extension', defaults.bridge!, '--no-mcp');
      args.push('--no-skills', '--no-context-files', '--tools', 'read,grep,find,ls');
    }
    else if (p.tools?.length) args.push('--tools', p.tools.join(','));
    try {
      if (this.io.prepareMember) args.push(...await this.io.prepareMember(m, { readOnly: p.readOnly === true, tools: p.tools, trustedProject: defaults.trustedProject }));
      await this.io.herdr(args);
      await this.live(m, true);
      m.state = 'ready'; this.save();
      if (p.task) this.enqueue({ name: m.name, task: p.task, dependsOn: p.dependsOn });
      return m;
    } catch (error) {
      m.state = 'needs-inspection'; this.save();
      throw new Error(`${String(error)}\nMember ${m.target}, pane ${pane} retained. Inspect before retrying; do not blindly respawn.`);
    }
  }
  enqueue(p: any) {
    this.io.check();
    const m = this.member(p.name);
    if (m.state === 'closed') throw new Error('Member is closed');
    if (!p.task?.trim()) throw new Error('task is required');
    if (this.state.tasks.length >= 200) throw new Error('Team task limit (200) reached; start a new lead session');
    const deps = [...new Set<string>(p.dependsOn ?? [])];
    for (const id of deps) if (!this.state.tasks.some(t => t.id === id)) throw new Error(`Unknown dependency ${id}`);
    // Dependencies may only reference existing tasks, so cycles cannot be introduced.
    const task: TeamTask = { id: `task-${randomUUID().slice(0, 8)}`, member: m.name, text: p.task, dependsOn: deps, state: 'queued' };
    this.state.tasks.push(task); this.save();
    return task;
  }
  async read(name: string) {
    const m = this.member(name); await this.live(m);
    return this.io.herdr(['agent', 'read', m.target, '--source', 'recent-unwrapped', '--lines', '120']);
  }
  async recover(name: string) {
    if (!name) throw new Error('recover requires a member name; it is not a team reset. Use create after closing members and resolving tasks.');
    const m = this.member(name);
    if (m.state === 'closed') throw new Error(`${name} is closed and cannot be recovered. Spawn a new member with a new name; if the old workspace is gone, use create first.`);
    if (!await this.io.confirm('Recover team member?', `Bind ${m.target} in ${m.pane} only if it is still the member you started. This never resubmits uncertain tasks.`)) throw new Error('Cancelled');
    await this.live(m, true); m.state = 'ready'; this.save(); return m;
  }
  resolve(p: any) {
    this.io.check();
    const t = this.state.tasks.find(t => t.id === p.id);
    if (!t) throw new Error('Unknown task');
    if (!['review', 'uncertain', 'failed', 'cancelled'].includes(t.state)) throw new Error('Only settled/review/uncertain tasks can be resolved');
    if (!['completed', 'failed'].includes(p.outcome)) throw new Error('outcome must be completed or failed');
    if (!p.summary?.trim()) throw new Error('summary required: record evidence and result for dependent tasks');
    t.state = p.outcome; t.output = bounded(p.summary); delete t.error; this.save(); return t;
  }
  cancel(id: string) {
    this.io.check();
    const t = this.state.tasks.find(t => t.id === id);
    if (!t || t.state !== 'queued') throw new Error('Only queued tasks can be cancelled; use stop for active members');
    t.state = 'cancelled'; this.save(); return t;
  }
  async stop(name: string, close = false) {
    const members = name === 'all' ? this.state.members.filter(m => m.state !== 'closed') : [this.member(name)];
    if (!members.length) return [];
    // Validate every occupant before confirmation, and again immediately before control.
    for (const m of members) await this.live(m);
    if (!await this.io.confirm(close ? 'Close team panes?' : 'Interrupt team members?',
      members.map(m => `${m.name}: ${m.pane}`).join('\n') + (close ? '\nCloses terminal processes. Worktrees and changes are retained.' : '\nSends Escape to interrupt; Pi and pane remain open. Queued tasks for these members are cancelled.')))
      throw new Error('Cancelled');
    const stopped = [];
    for (const m of members) {
      const a = await this.live(m);
      if (!close && a.agent_status === 'blocked') throw new Error(`${m.name} is blocked: handle its dialog manually`);
      if (close) await this.io.herdr(['pane', 'close', m.pane]);
      else if (!ready(a.agent_status)) await this.io.herdr(['agent', 'send-keys', m.target, 'esc']);
      m.state = close ? 'closed' : 'interrupted';
      if (close) for (const page of this.state.pages ?? []) if (page.panes.includes(m.pane)) page.state = 'retired';
      for (const t of this.state.tasks.filter(t => t.member === m.name)) {
        if (t.state === 'queued') t.state = 'cancelled';
        else if (['submitting', 'awaiting-activity', 'running', 'blocked', 'uncertain'].includes(t.state)) {
          t.state = 'uncertain'; t.error = 'Member interrupted/closed; inspect effects before resolving or retrying.';
        }
      }
      // If a team root was closed, use a surviving member as the split anchor.
      if (close && this.state.anchor === m.pane) this.state.anchor = this.state.members.find(x => x.state !== 'closed')?.pane ?? this.state.anchor;
      this.save(); stopped.push(m.name);
    }
    return stopped;
  }
  private async observeTask(task: TeamTask, m: Member, a: LiveAgent) {
    const before = task.state;
    if (a.agent_status === 'blocked') task.state = 'blocked';
    else if (a.agent_status === 'working') { task.active = true; task.state = 'running'; delete task.error; }
    else if (ready(a.agent_status) && (task.active || (a.completion_seq ?? 0) > (task.baseline ?? 0))) {
      // Commit the terminal transition only after evidence collection. Cancellation must
      // leave a reconcilable state, not an unannounced review that future polls skip.
      let output: string;
      try {
        const result = await this.read(m.name);
        output = bounded(typeof result?.text === 'string' ? result.text : result);
      }
      catch (error) { this.io.check(); output = `Output unavailable: ${String(error)}. Inspect member pane.`; }
      this.io.check();
      task.state = 'review'; task.output = output; delete task.error;
    } else if (!task.active && this.now() - (task.submittedAt ?? 0) >= ACTIVITY_GRACE_MS) {
      task.state = 'uncertain'; task.error = 'Activity grace period expired without observed activity/completion; inspect before resolving. No prompt was replayed.';
    } else if (!task.active && ready(a.agent_status)) task.state = 'awaiting-activity';
    if (before !== task.state) {
      this.save();
      if (['review', 'blocked', 'uncertain'].includes(task.state)) this.announce(task);
    }
  }
  private async tickMember(m: Member, agents: LiveAgent[], shouldDispatch: () => boolean) {
    this.io.check();
    if (m.state === 'closed') return;
    let a: LiveAgent;
    try { a = this.observe(m, agents.find(a => m.terminal ? a.terminal_id === m.terminal : a.pane_id === m.pane)); }
    catch (error) {
      this.io.check();
      m.state = 'needs-inspection';
      const task = this.state.tasks.find(t => t.member === m.name && ['submitting', 'awaiting-activity', 'running', 'blocked'].includes(t.state));
      if (task) { task.state = 'uncertain'; task.error = String(error); this.save(); this.announce(task); }
      return;
    }
    m.state = a.agent_status;
    const active = this.state.tasks.find(t => t.member === m.name && ['submitting', 'awaiting-activity', 'running', 'blocked', 'uncertain', 'review'].includes(t.state));
    if (active) {
      if (!['review', 'uncertain'].includes(active.state)) await this.observeTask(active, m, a);
      return;
    }
    if (!shouldDispatch() || !ready(a.agent_status)) return;
    const task = this.state.tasks.find(t => t.member === m.name && t.state === 'queued' && t.dependsOn.every(id => this.state.tasks.find(d => d.id === id)?.state === 'completed'));
    if (!task) return;
    // A batch snapshot can be stale. Revalidate identity and readiness immediately before submission.
    a = await this.live(m);
    if (!shouldDispatch() || !ready(a.agent_status)) return;
    task.state = 'submitting'; task.baseline = a.completion_seq ?? 0; task.submittedAt = this.now(); this.save();
    const dependencies = task.dependsOn.map(id => {
      const dep = this.state.tasks.find(t => t.id === id)!;
      return `${id} (${dep.member}): ${dep.output ?? ''}`;
    }).join('\n');
    try {
      await this.io.herdr(['agent', 'prompt', m.target,
        `You are team member ${m.name}. Coordinate through the lead. Do not create other members unless explicitly requested.\nResponsibilities:\n${m.instructions ?? ''}\n\nTask ${task.id}:\n${task.text}\n\nCompleted dependency results:\n${dependencies}\n\nReport findings, changes, and verification to the lead.`,
        '--wait', '--timeout', '1000']);
      task.active = true; task.state = 'running'; this.save();
    } catch (error) {
      this.io.check(); // Cancellation leaves the persisted submitting record for later reconciliation.
      task.state = 'awaiting-activity'; task.error = String(error); this.save();
      // Never replay. A slow terminal gets a bounded observation window, including across reloads.
      try { await this.observeTask(task, m, await this.live(m)); }
      catch (inspection) { this.io.check(); task.error = `${String(error)}\n${String(inspection)}`; this.save(); }
    }
  }
  /** One bulk snapshot, up to four independent member reconciliations; busy members are skipped by the adapter. */
  async tick(dispatch: boolean | (() => boolean) = true,
    withMember: (name: string, fn: () => Promise<void>) => Promise<unknown> = (_name, fn) => fn()) {
    const members = this.state.members.filter(m => m.state !== 'closed');
    if (!members.length) return this.summary();
    const result = await this.io.herdr(['agent', 'list']);
    if (!Array.isArray(result.agents)) throw new Error('Invalid Herdr agent list response');
    const agents: LiveAgent[] = result.agents;
    const shouldDispatch = typeof dispatch === 'function' ? dispatch : () => dispatch;
    let index = 0;
    try {
      // allSettled ensures member cancellation cannot flush notifications before siblings finish.
      const workers = await Promise.allSettled(Array.from({ length: Math.min(4, members.length) }, async () => {
        while (index < members.length) {
          const m = members[index++];
          await withMember(m.name, () => this.tickMember(m, agents, shouldDispatch));
        }
      }));
      this.io.check(); this.lastObservedAt = this.now(); this.save();
      const failed = workers.find(r => r.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      return this.summary();
    } finally { this.io.check(); this.flushNotices(); }
  }
}
