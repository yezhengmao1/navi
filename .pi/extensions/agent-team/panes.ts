import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import { accessSync } from 'node:fs';
import { Type } from 'typebox';
import { Text } from '@earendil-works/pi-tui';
import { formatTeamStatus, formatTeamResult, teamPanel } from './team-display.ts';
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { discoverAgents } from './agents.ts';
import { TeamController, type TeamState } from './team-controller.ts';
import { ControlQueue } from './control-queue.ts';
import { resolveHerdrBridge } from './herdr-bridge.ts';
import { PermissionBroker, type Approval, type Decision } from './permission-broker.ts';
import { decodeHerdrResponse } from './herdr-response.ts';
import { PendingTeamNotices } from './team-notifications.ts';
import { leadMemberProfile, memberLaunchArgs } from './member-profile.ts';

const choices = (values: string[]) => Type.Union(values.map(v => Type.Literal(v)));
const parameters = Type.Object({
  action: choices(['run', 'create', 'spawn', 'send', 'broadcast', 'status', 'read', 'resolve', 'cancel', 'stop', 'close', 'recover', 'monitor', 'hide']),
  backend: Type.Optional(choices(['background', 'pane'])),
  name: Type.Optional(Type.String({ description: 'Member name; stop/close also accept all' })),
  label: Type.Optional(Type.String()), topology: Type.Optional(choices(['current', 'tab', 'workspace'])),
  instructions: Type.Optional(Type.String()), task: Type.Optional(Type.String()),
  agent: Type.Optional(Type.String({ description: 'Optional saved agent definition, shared with background subagent' })),
  agentScope: Type.Optional(choices(['user', 'project', 'both'])),
  cwd: Type.Optional(Type.String()), model: Type.Optional(Type.String()),
  thinking: Type.Optional(choices(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])),
  tools: Type.Optional(Type.Array(Type.String())), readOnly: Type.Optional(Type.Boolean()), worktree: Type.Optional(Type.Boolean()),
  dependsOn: Type.Optional(Type.Array(Type.String({ description: 'Existing task IDs; dispatch only after lead resolves all as completed' }))),
  id: Type.Optional(Type.String({ description: 'Task ID for resolve/cancel, or read stored task evidence' })),
  outcome: Type.Optional(choices(['completed', 'failed'])), summary: Type.Optional(Type.String()),
  enabled: Type.Optional(Type.Boolean({ description: 'monitor: enable polling/dispatch; false pauses immediately, not member processes' })),
  notify: Type.Optional(choices(['wake', 'message', 'silent'])),
  wait: Type.Optional(Type.Boolean({ description: 'Compatibility: send queues without blocking; completion arrives via notifications' })),
});

export function registerPanes(pi: ExtensionAPI) {
  const operations = new AsyncLocalStorage<{ signal: AbortSignal; ctx: ExtensionContext }>();
  let locks = new ControlQueue();
  let lifetime = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let polling: Promise<unknown> | undefined;
  let current: { ctx: ExtensionContext; controller: TeamController; scope: string; serialized: string; outputs: Map<string, string> } | undefined;
  let dispatch = false, monitoring = false, pauseRevision = 0, failures = 0;
  let panelVisible = false;
  let panelRevision = 0;
  function hidePanel(ctx: ExtensionContext) {
    const wasVisible = panelVisible;
    panelRevision++; // Invalidate an in-flight /team status before it can reopen the panel.
    panelVisible = false;
    if (ctx.mode === 'tui') ctx.ui.setWidget?.('agent-team-status', undefined);
    return { hidden: true, wasVisible };
  }
  function refreshPanel() {
    if (!panelVisible || !current || current.ctx.mode !== 'tui') return;
    const snapshot = formatTeamStatus({ ...current.controller.summary(), monitoring, dispatch,
      notify: current.controller.state.notify, refreshing: !!polling, pollFailures: failures, busyMembers: current.controller.state.members.filter(m => locks.busy(`member:${m.name}`)).map(m => m.name) }, 6, 4);
    current.ctx.ui.setWidget?.('agent-team-status', (_tui, theme) => teamPanel(snapshot, theme));
  }
  const pendingNotices = new PendingTeamNotices();
  let noticeWakeSuspended = false;
  let broker: PermissionBroker | undefined;
  let brokerStarting: Promise<PermissionBroker> | undefined;
  const memberExtension = fileURLToPath(new URL('./member-permissions.ts', import.meta.url));
  const safetyExtension = fileURLToPath(new URL('../../../packages/pi/extensions/safety-guard.ts', import.meta.url));
  const scopeOf = (ctx: ExtensionContext) => `${process.env.HERDR_SOCKET_PATH}:${process.env.HERDR_PANE_ID}:${ctx.sessionManager.getSessionId()}`;
  const guard = (ctx: ExtensionContext) => {
    if (ctx.mode !== 'tui' || process.env.HERDR_ENV !== '1' || !process.env.HERDR_PANE_ID)
      throw new Error('Pane teams require interactive Pi inside Herdr; use subagent for background tasks.');
  };
  const clearTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };
  const reset = () => {
    if (panelVisible) current?.ctx.ui.setWidget?.('agent-team-status', undefined);
    panelVisible = false;
    panelRevision++;
    const closing = broker?.close(); broker = undefined; brokerStarting = undefined;
    lifetime.abort(); locks.clear(); locks = new ControlQueue(); lifetime = new AbortController();
    clearTimer(); pendingNotices.clear(); noticeWakeSuspended = false;
    polling = undefined; current = undefined; dispatch = monitoring = false; pauseRevision++; failures = 0;
    return closing;
  };
  const inOperation = <T>(ctx: ExtensionContext, signal: AbortSignal, fn: () => Promise<T>) => operations.run({ ctx, signal }, fn);
  function bind(ctx: ExtensionContext) {
    guard(ctx);
    const scope = scopeOf(ctx);
    if (current?.scope === scope) { current.ctx = ctx; return current.controller; }
    if (current) throw new Error('Session context changed; reload team state first');
    const branch: any[] = ctx.sessionManager.getBranch();
    const entry = [...branch].reverse().find(e => e.type === 'custom' && e.customType === 'agent-team' && e.data?.scope === scope);
    const state: TeamState = { version: 2, scope, label: 'team', anchor: process.env.HERDR_PANE_ID!, members: [], tasks: [], notify: 'wake', resources: [], ...structuredClone(entry?.data ?? {}) };
    const outputs = new Map<string, string>();
    for (const e of branch) if (e.type === 'custom' && e.customType === 'agent-team-result' && e.data?.scope === scope)
      outputs.set(e.data.id, e.data.output);
    for (const task of state.tasks) if (task.output === undefined && outputs.has(task.id)) task.output = outputs.get(task.id);
    state.version = 2;
    const ownLifetime = lifetime;
    const check = () => {
      if (ownLifetime.signal.aborted || operations.getStore()?.signal.aborted || current?.scope !== scope)
        throw new Error('Team operation cancelled or session changed');
    };
    const exec = async (binary: string, args: string[]) => {
      check();
      const operation = operations.getStore();
      const signal = operation ? AbortSignal.any([ownLifetime.signal, operation.signal]) : ownLifetime.signal;
      const timeout = binary === 'git' ? 120000 : args[0] === 'agent' && args[1] === 'start' ? 35000 : 5000;
      const r = await pi.exec(binary, args, { timeout, signal });
      check();
      if (r.code !== 0) throw new Error((r.stderr || r.stdout || `${binary} failed`).slice(0, 4000) + '\nInspect state before retrying; operation may have applied.');
      return r.stdout;
    };
    const controller = new TeamController(state, {
      check,
      async herdr(args) {
        return decodeHerdrResponse(args, await exec('herdr', args));
      },
      git: args => exec('git', args),
      async prepareMember(member, profile) {
        check();
        const activeBroker = await ensureBroker(current!.ctx);
        check();
        const inherited = leadMemberProfile(pi, getAgentDir(), safetyExtension);
        member.approvalConfig = activeBroker.register(member.name,
          !profile.readOnly && !profile.tools?.length ? { activeTools: inherited.activeTools } : undefined);
        controller.save();
        return memberLaunchArgs({ bridge: resolveHerdrBridge(getAgentDir()), relay: memberExtension,
          guard: inherited.guard, config: member.approvalConfig, extensions: inherited.extensions,
          readOnly: profile.readOnly, trustedProject: profile.trustedProject });
      },
      save(value) {
        check();
        // Store each changed result once. Metadata snapshots reference task IDs, not repeated 16K outputs.
        for (const task of value.tasks) if (task.output !== undefined && current!.outputs.get(task.id) !== task.output) {
          pi.appendEntry('agent-team-result', { scope, id: task.id, output: task.output });
          current!.outputs.set(task.id, task.output);
        }
        const compact = { ...value, tasks: value.tasks.map(({ output: _output, ...task }) => task) };
        const serialized = JSON.stringify(compact);
        if (serialized !== current!.serialized) { pi.appendEntry('agent-team', compact); current!.serialized = serialized; }
      },
      notify(_text, _wake, notices) {
        check();
        if (!monitoring || state.notify === 'silent') return;
        pendingNotices.add(notices);
        flushNoticesWhenIdle();
      },
      async confirm(title, text) {
        check();
        // Team lifecycle operations are ordinary approvals under the user's lead-managed policy.
        // Identity checks in the controller remain mandatory. Only high safety-guard requests need UI.
        pi.appendEntry('agent-team-approval', { member: 'lead', source: 'team-management', title, allow: true, automatic: true });
        return true;
      },
    });
    current = { ctx, controller, scope, serialized: JSON.stringify(entry?.data ?? state), outputs };
    return controller;
  }
  function flushNoticesWhenIdle() {
    if (!current || !monitoring || noticeWakeSuspended || locks.busy('dialog') || current.ctx.isIdle?.() !== true) return;
    const notice = pendingNotices.take(current.controller.state);
    if (notice) pi.sendMessage({ customType: 'agent-team-update', content: notice.content, display: true, details: notice.details }, { triggerTurn: notice.wake });
  }
  // A busy lead gets one fresh, actionable batch at the settlement boundary, not
  // a growing FIFO of follow-ups that survive task resolution or monitor pause.
  pi.on('agent_before_settle', (event, ctx) => {
    if (!current || scopeOf(ctx) !== current.scope || !monitoring || noticeWakeSuspended || locks.busy('dialog') || event.outcome !== 'completed') return;
    if (current.controller.state.notify === 'wake' && !event.context.canContinue) return;
    const notice = pendingNotices.take(current.controller.state);
    if (!notice) return;
    return { entries: [...event.entries, { type: 'custom_message' as const, customType: 'agent-team-update',
      content: notice.content, display: true, details: notice.details }], ...(notice.wake ? { continue: true } : {}) };
  });
  pi.on('agent_settled', event => { if (event.aborted) noticeWakeSuspended = true; });
  pi.on('before_agent_start', event => { if (event.messageType === 'user') noticeWakeSuspended = false; });
  async function decideApproval(request: Approval, ctx: ExtensionContext, signal: AbortSignal): Promise<Decision> {
    if (signal.aborted) return { allow: false, feedback: 'Approval cancelled' };
    const high = request.risk !== 'low' && request.risk !== 'medium';
    let allow = !high;
    if (high && ctx.hasUI) {
      ctx.ui.notify(`成员 ${request.member} 请求高危授权：${request.title}`, 'warning');
      allow = await locks.run('dialog', dialogSignal => ctx.ui.confirm(
        `高危审批 · ${request.member} · ${request.title}`,
        `${request.body}\n\n工具：${request.toolName}\n请求：${request.toolCallId}\n完整操作：\n${JSON.stringify(request.input, null, 2)}\n\n仅批准本次操作。`,
        { signal: dialogSignal }), signal);
    }
    if (signal.aborted) return { allow: false, feedback: 'Approval cancelled' };
    pi.appendEntry('agent-team-approval', { id: request.id, member: request.member, toolCallId: request.toolCallId,
      title: request.title, risk: request.risk, allow, automatic: !high });
    return { allow, feedback: allow ? undefined : 'Lead denied the high-risk operation' };
  }
  async function ensureBroker(ctx: ExtensionContext): Promise<PermissionBroker> {
    if (brokerStarting) return brokerStarting;
    const c = bind(ctx), generation = lifetime;
    const instance = new PermissionBroker(c.state.approvalDirectory,
      (request, signal) => decideApproval(request, current?.ctx ?? ctx, AbortSignal.any([generation.signal, signal])),
      (request, signal) => inOperation(current?.ctx ?? ctx, AbortSignal.any([generation.signal, signal]), () => c.verifyApprovalMember(request.member, request.session)));
    broker = instance; c.state.approvalDirectory = instance.directory; c.save();
    brokerStarting = (async () => {
      try {
        await instance.start();
        if (generation.signal.aborted) throw new Error('Session changed');
        for (const member of c.state.members.filter(m => m.state !== 'closed' && m.approvalConfig)) instance.register(member.name);
        return instance;
      } catch (error) {
        await instance.close();
        if (broker === instance) { broker = undefined; brokerStarting = undefined; }
        throw error;
      }
    })();
    return brokerStarting;
  }
  // The lead itself follows the same policy once this session has an active team.
  const unsubscribeApprovals = pi.events?.on?.('agent-team:approval', (value: unknown) => {
    const request = value as any;
    if (process.argv.includes('--team-approval-config') || request?.handled || request?.source !== 'safety-guard' || !current || scopeOf(request.ctx) !== current.scope) return;
    request.handled = true;
    const signal = request.ctx.signal ? AbortSignal.any([lifetime.signal, request.ctx.signal]) : lifetime.signal;
    void decideApproval({ ...request, id: request.toolCallId, member: 'lead', session: request.ctx.sessionManager.getSessionId() }, request.ctx, signal)
      .then(request.reply, error => request.reply({ allow: false, feedback: String(error) }));
  });
  function memberOperation<T>(name: string, ctx: ExtensionContext, signal: AbortSignal, fn: () => Promise<T>, urgent = false) {
    return locks.run(`member:${name}`, s => inOperation(ctx, s, fn), signal, urgent);
  }
  async function poll(ctx: ExtensionContext, signal: AbortSignal, allowDispatch: boolean) {
    const c = bind(ctx);
    if (polling) return { ...c.summary(), refreshing: true };
    const ownLocks = locks, generation = lifetime;
    const work = inOperation(ctx, signal, () => c.tick(() => allowDispatch && dispatch && monitoring,
      async (name, fn) => {
        if (ownLocks.busy(`member:${name}`)) return; // Starting, reading, or stopping: never block other members.
        try { await ownLocks.run(`member:${name}`, s => inOperation(ctx, s, fn), signal); }
        catch (error) {
          // Urgent control can cancel this member's poll; siblings still reconcile normally.
          if (signal.aborted || generation.signal.aborted) throw error;
          if (!String(error).includes('cancelled')) throw error;
        }
      }));
    polling = work;
    try { return await work; }
    finally { if (polling === work) polling = undefined; }
  }
  function schedule(expedite = false) {
    if (!monitoring || !current || lifetime.signal.aborted) return;
    if (expedite) clearTimer();
    if (timer) return;
    const generation = lifetime, ctx = current.ctx;
    const delay = expedite ? 0 : failures ? Math.min(30000, 3000 * 2 ** failures) : current.controller.pollDelay();
    timer = setTimeout(() => {
      timer = undefined;
      void poll(ctx, generation.signal, true).then(() => {
        if (generation === lifetime) { failures = 0; flushNoticesWhenIdle(); refreshPanel(); }
      }).catch(error => {
        if (generation === lifetime && !generation.signal.aborted && current) {
          failures++;
          refreshPanel();
          if (failures === 1) ctx.ui.notify(`Team polling failed; retrying with backoff (no prompt replay): ${String(error)}`, 'warning');
        }
      }).finally(() => { if (generation === lifetime) schedule(); });
    }, delay);
    timer.unref?.();
  }
  async function execute(p: any, ctx: ExtensionContext, signal?: AbortSignal) {
    if (process.argv.includes('--team-approval-config')) throw new Error('Team management is lead-only; ask the lead to manage members.');
    if (p.action === 'hide') return hidePanel(ctx);
    const generation = lifetime;
    const combined = signal ? AbortSignal.any([generation.signal, signal]) : generation.signal;
    if (combined.aborted) throw new Error('Team operation cancelled');
    const c = bind(ctx), revision = pauseRevision;
    const enable = () => { if (generation === lifetime && revision === pauseRevision) { monitoring = dispatch = true; noticeWakeSuspended = false; schedule(true); } };
    const onMember = <T>(name: string, fn: () => Promise<T>, urgent = false) => memberOperation(name, ctx, combined, fn, urgent);
    return inOperation(ctx, combined, async () => {
      if (c.state.approvalDirectory && ['send', 'broadcast', 'resolve', 'recover'].includes(p.action)) await ensureBroker(ctx);
      let result: any;
      switch (p.action) {
        case 'create': result = await locks.run('topology', s => inOperation(ctx, s, () => c.create({ ...p, workspace: process.env.HERDR_WORKSPACE_ID }, p.cwd ?? ctx.cwd)), combined); break;
        case 'spawn': {
          result = await locks.run('topology', s => memberOperation(p.name, ctx, s, async () => {
            const bridge = resolveHerdrBridge(getAgentDir());
            accessSync(memberExtension); accessSync(safetyExtension);
            leadMemberProfile(pi, getAgentDir(), safetyExtension); // Fail before allocating panes if the inherited guard is incompatible.
            let config = { ...p };
            if (p.agent) {
              const role = discoverAgents(ctx.cwd, p.agentScope ?? 'user').agents.find(a => a.name === p.agent);
              if (!role) throw new Error(`Unknown saved agent ${p.agent}`);
              // Roles supply responsibilities/model, not a hidden tool restriction. Default capabilities mirror the lead.
              config = { ...p, instructions: [role.systemPrompt, p.instructions].filter(Boolean).join('\n\n'), model: p.model ?? role.model, tools: p.tools };
            }
            return c.spawn(config, { cwd: ctx.cwd, model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
              thinking: ctx.thinkingLevel, bridge, workspace: process.env.HERDR_WORKSPACE_ID,
              trustedProject: ctx.isProjectTrusted?.() === true && (!config.cwd || config.cwd === ctx.cwd) });
          }), combined);
          enable(); break;
        }
        case 'send': result = await onMember(p.name, async () => c.enqueue(p)); enable(); break;
        case 'broadcast': {
          // Reservation-free, synchronous metadata transaction: no I/O or awaits between validation and enqueue.
          const members = c.state.members.filter(m => m.state !== 'closed');
          if (!p.task?.trim() || c.state.tasks.length + members.length > 200) throw new Error('task required and task limit must not be exceeded');
          for (const id of p.dependsOn ?? []) if (!c.state.tasks.some(t => t.id === id)) throw new Error(`Unknown dependency ${id}`);
          result = members.map(m => c.enqueue({ ...p, name: m.name })); enable(); break;
        }
        case 'status': result = { ...await poll(ctx, combined, false), monitoring, dispatch, notify: c.state.notify,
          busyMembers: c.state.members.filter(m => locks.busy(`member:${m.name}`)).map(m => m.name) }; break;
        case 'read': result = p.id ? c.taskDetail(p.id) : await onMember(p.name, () => c.read(p.name)); break;
        case 'resolve': result = await onMember(c.taskDetail(p.id).member, async () => c.resolve(p)); enable(); break;
        case 'cancel': result = await onMember(c.taskDetail(p.id).member, async () => c.cancel(p.id)); break;
        case 'stop': case 'close': {
          const members = p.name === 'all' ? c.state.members.filter(m => m.state !== 'closed').map(m => m.name) : [c.member(p.name).name];
          result = [];
          // Revoke pending authorizations first. Every operation still rechecks the owned Pi identity.
          for (const name of members) { broker?.cancelMember(name); result.push(...await onMember(name, () => c.stop(name, p.action === 'close'), true)); }
          break;
        }
        case 'recover':
          if (!p.name) throw new Error('recover requires a member name; to rebuild a closed team use create, then spawn new members.');
          result = await onMember(p.name, () => c.recover(p.name)); break;
        case 'monitor':
          if (p.notify) c.state.notify = p.notify;
          monitoring = dispatch = p.enabled ?? true;
          if (!monitoring) { pauseRevision++; clearTimer(); pendingNotices.clear(); } // Also discard undelivered notices.
          else { noticeWakeSuspended = false; if (c.state.approvalDirectory) await ensureBroker(ctx); schedule(true); }
          if (p.notify === 'silent') pendingNotices.clear();
          c.save(); result = { monitoring, dispatch, notify: c.state.notify }; break;
        default: throw new Error('Unknown team action');
      }
      if (generation.signal.aborted) throw new Error('Session changed');
      refreshPanel();
      return structuredClone(result);
    });
  }
  for (const event of ['session_start', 'session_switch', 'session_tree'] as const) pi.on(event, reset);
  pi.on('session_shutdown', () => { unsubscribeApprovals?.(); return reset(); });
  pi.registerTool({
    name: 'team', label: 'Agent team', parameters,
    renderCall(input, theme) {
      const labels: Record<string, string> = { status: '查看状态', run: '启动任务', create: '创建团队', spawn: '创建成员', send: '派发任务', broadcast: '广播任务', read: '查看结果', resolve: '验收任务', cancel: '取消任务', stop: '中断成员', close: '关闭成员', recover: '恢复成员', monitor: '设置监控', hide: '隐藏面板' };
      const background = input.action === 'run' && input.backend === 'background';
      const title = background ? `🤖 后台子任务 · ${String(input.agent ?? input.name ?? '执行任务').replace(/\s+/g, ' ')}`
        : `👥 团队 · ${labels[input.action] ?? '操作'}`;
      return new Text(theme.fg('toolTitle', theme.bold(title)), 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      const text = formatTeamResult(result.details, expanded) ?? result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      const background = ['single', 'parallel', 'chain'].includes((result.details as any)?.mode);
      const limit = expanded ? 24000 : 3000;
      const hint = background ? '\n… 展开查看完整子任务结果' : '\n… 展开或使用 /team task <ID> 查看详情';
      const display = text.length > limit ? text.slice(0, limit) + hint : text;
      return new Text(isPartial && !text ? theme.fg('muted', background ? '⏳ 后台子任务执行中…' : '◌ 正在处理团队操作…') : result.isError ? theme.fg('error', display) : display, 0, 0);
    },
    reachesTools: (input: any) => input?.action === 'run' && input?.backend === 'background' ? ['subagent'] : [],
    description: 'Unified dynamic agent delegation. run requires backend background (existing subagent) or pane (persistent interactive Pi). create selects workspace; after all members are closed and tasks resolved/cancelled, create can select a new location in the same lead, preserving history and forcing fresh tabs. Pending/uncertain old layouts require inspection unless their workspaces are confirmed missing. Use new member names; recover never restarts closed members. spawn creates members in dedicated tabs, four panes per tab in TL/TR/BL/BR order, then a new tab. Default members inherit normal Pi extension/MCP discovery and the lead active tools, model and thinking. Roles do not restrict tools. Use readOnly/tools only for an explicitly requested restriction; analysis-only instructions do not require disabling network tools. Optional worktree. Lead auto-approves ordinary permissions; high-risk safety-guard requests require user confirmation in the lead, never in members. send/broadcast queue tasks with dependencies. Batched completion/blocked notices wake lead by default. Do not wait for members with bash sleep or polling loops: when monitoring is enabled with notify=wake, end the lead turn after dispatch and let result notifications resume coordination. Respect user pauses/aborts. Review is not success: inspect evidence then resolve id/outcome/summary to release dependents. status gives compact live overview; read with id gives stored task evidence or with name reads member terminal. cancel queued work; stop interrupts, close terminates owned panes (identity checked); recover failed startup. monitor controls polling/dispatch; pause is immediate, not a member stop. hide dismisses the status widget only, without changing monitoring or tasks; safe when no panel is visible. After reload explicitly resume. No high-risk auto-approval or prompt replay. Worktrees retained. Use subagent for short parallel/chain tasks.',
    async execute(_id, p, signal, onUpdate, ctx) {
      if (p.action === 'run') {
        if (!p.backend) throw new Error('run requires explicit backend: background or pane');
        if (p.backend === 'background') {
          if (p.readOnly || p.worktree || p.dependsOn?.length || p.thinking) throw new Error('readOnly/worktree/dependencies/thinking overrides currently require pane backend; background inherits lead thinking.');
          if (!p.task || (!p.agent && (!p.name || !p.instructions))) throw new Error('background run requires task and either a saved agent or name + instructions');
          if (p.agent && (p.instructions || p.model || p.tools)) throw new Error('To override a saved background role, use an explicit dynamic name + instructions instead of agent.');
          const outcome = await ctx.executeTool('subagent', {
            agent: p.agent ?? p.name, task: p.task, cwd: p.cwd, agentScope: p.agentScope,
            definitions: p.agent ? undefined : [{ name: p.name, instructions: p.instructions, model: p.model, tools: p.tools }],
          }, { signal, onUpdate });
          return { ...outcome.result, usage: undefined, isError: outcome.isError };
        }
      }
      const details = await execute(p.action === 'run' ? { ...p, action: 'spawn' } : p, ctx, signal);
      const text = p.action === 'read' && typeof details?.text === 'string' ? details.text : JSON.stringify(details, null, 2);
      return { content: [{ type: 'text', text: text.length > 24000 ? text.slice(0, 24000) + '\n[Truncated; use team read with id/name for details.]' : text }], details };
    },
  });
  pi.registerCommand('team', {
    description: '团队：/team 切换面板；/team [status|start <目标>|stop <成员|all>|close <成员|all>|pause|resume|read <成员>|task <ID>|recover <成员>|hide]',
    async handler(args, ctx) {
      const input = args.trim();
      const [action = 'status', ...rest] = input.split(/\s+/);
      try {
        if (action === 'hide' || (!input && panelVisible)) {
          hidePanel(ctx);
          ctx.ui.notify('团队状态面板已隐藏；监控和任务不受影响。', 'info');
          return;
        }
        guard(ctx);
        if (action === 'start') {
          if (!rest.length) throw new Error('Usage: /team start <goal>');
          pi.sendUserMessage(`请使用 team 工具，根据以下目标动态组建 Herdr 窗格团队。按任务需要选择成员和分工，不使用固定角色模板。

Lead 职责与工作边界：
- Lead 负责拆分任务、派发、协调依赖、跟进进度、验收成员结果和最终汇总；主体工作交给成员执行。
- 已经分配给成员的主体工作，不要自行重复执行，也不要在等待成员期间另做一遍审查、实现或整套测试。
- 等待成员时，不要执行 bash sleep、长时间阻塞等待或循环查询状态。确保团队监控开启且 notify 为 wake；完成派发、暂时没有协调事项时，简短告知进展后结束当前轮，让插件在成员返回时唤醒 Lead。不要把“本轮等待”说成整个任务已经完成。
- 收到成员返回通知后，及时读取证据、验收结果并推进后续任务；若用户主动暂停或中断，应尊重该操作，不自行恢复监控。
- 对成员结论有疑点时，优先要求成员补充证据，或安排另一成员独立交叉核验。
- Lead 可以做必要的范围确认和小规模证据抽查，但不能用“验收”代替成员完成主体工作，也不能未经核验直接接受成员结论。
- 如果成员失败、受阻或确有必要由 Lead 接手，应先向用户说明原因和接手范围，再执行；用户另有明确要求时按用户要求处理。

除非用户另有要求，任务说明、成员报告和最终汇总均使用中文。
目标：${rest.join(' ')}`);
          return;
        }
        const p = action === 'pause' || action === 'resume' ? { action: 'monitor', enabled: action === 'resume' }
          : action === 'task' ? { action: 'read', id: rest[0] } : { action: action || 'status', name: rest[0] };
        if (!['status', 'monitor', 'stop', 'close', 'read', 'recover'].includes(p.action)) throw new Error('用法：/team [status|start <目标>|stop <成员|all>|close <成员|all>|pause|resume|read <成员>|task <ID>|recover <成员>|hide]');
        const revision = p.action === 'status' ? ++panelRevision : panelRevision;
        const result = await execute(p, ctx);
        if (p.action === 'status' && ctx.ui.setWidget) {
          if (revision === panelRevision) { panelVisible = true; refreshPanel(); }
        } else ctx.ui.notify((formatTeamResult(result, true) ?? JSON.stringify(result, null, 2)).slice(0, 24000), 'info');
      } catch (error) { ctx.ui.notify(String(error), 'error'); }
    },
  });
}
