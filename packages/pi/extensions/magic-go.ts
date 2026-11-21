import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

const KEY = 'magic-go';
const REPORT = 'magic_go_report';
const DEFAULT_BUDGET = 1_000_000;
const HELP = '/go [--tokens 50k] <目标> · /go status | pause | resume | clear';
type Goal = {
  objective: string; budget: number; used: number; unit?: 'output'; // absent on historical total-token goals
  status: 'active' | 'paused' | 'complete' | 'budget'; note: string;
};
const count = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
function isGoal(g: unknown): g is Goal {
  if (!g || typeof g !== 'object') return false;
  const s = g as Partial<Goal>;
  return typeof s.objective === 'string' && !!s.objective.trim() && count(s.budget) && s.budget > 0 && count(s.used) &&
    typeof s.note === 'string' && ['active', 'paused', 'complete', 'budget'].includes(s.status ?? '');
}
const usageLabel = (g: Goal) => `${g.used}/${g.budget} ${g.unit === 'output' ? '输出 tokens' : '旧版总 tokens'}`;
function prompt(g: Goal) {
  return `当前 /go 目标：${g.objective}\n用量 ${usageLabel(g)}。继续做下一项可验证的工作；不要仅复述计划。` +
    `完成后用 ${REPORT}(status=complete, summary=具体验证结果) 报告。需要用户决定、权限不足或无法取得进展时用 ${REPORT}(status=blocked, summary=原因) 暂停。` +
    '持续执行不扩大用户授权，不跳过确认。';
}

export default function magicGo(pi: ExtensionAPI) {
  let goal: Goal | null = null;
  let trackTurn = false;
  function refresh(ctx: ExtensionContext) {
    const tools = pi.getActiveTools();
    const active = goal?.status === 'active';
    if (active !== tools.includes(REPORT)) pi.setActiveTools(active ? [...tools, REPORT] : tools.filter(t => t !== REPORT));
    ctx.ui.setStatus(KEY, goal ? `Go: ${goal.status} · ${usageLabel(goal)}` : undefined);
  }
  function save(ctx: ExtensionContext, next: Goal | null) {
    pi.appendEntry(KEY, next);
    goal = next;
    refresh(ctx);
  }
  function restore(ctx: ExtensionContext) {
    trackTurn = false;
    const entry = ctx.sessionManager.getBranch().findLast(e => e.type === 'custom' && e.customType === KEY);
    goal = entry?.type === 'custom' && isGoal(entry.data) ? entry.data : null;
    if (goal?.status === 'active') save(ctx, { ...goal, status: 'paused', note: '会话已恢复；/go resume 继续' });
    else refresh(ctx);
  }
  pi.on('session_start', (_e, ctx) => restore(ctx));
  pi.on('session_tree', (_e, ctx) => restore(ctx));
  pi.on('session_shutdown', () => { goal = null; trackTurn = false; });

  function start(ctx: ExtensionContext, next: Goal) {
    save(ctx, next);
    try {
      pi.sendMessage({ customType: KEY, content: prompt(next), display: true }, { triggerTurn: true });
    } catch (e) {
      save(ctx, { ...next, status: 'paused', note: '启动失败；/go resume 重试' });
      throw e;
    }
  }
  pi.registerCommand('go', {
    description: `持续推进当前会话目标。${HELP}`,
    handler: async (args, ctx) => {
      const input = args.trim();
      const tell = (s: string) => ctx.ui.notify(s, 'info');
      if (!input || input === 'status') return tell(goal ? `${goal.status} · ${usageLabel(goal)}\n${goal.objective}\n${goal.note}`.trim() : `没有目标。${HELP}`);
      if (input === 'pause' || input === 'clear') {
        if (!goal) return tell('没有目标。');
        const wasActive = goal.status === 'active';
        if (input === 'pause' && !wasActive) return tell(`目标状态：${goal.status}`);
        save(ctx, input === 'clear' ? null : { ...goal, status: 'paused', note: '用户暂停' });
        if (wasActive && !ctx.isIdle()) ctx.abort();
        return tell(input === 'clear' ? '目标已清除。' : '目标已暂停。');
      }
      if (!ctx.isIdle()) return tell('请等当前任务结束再启动或恢复目标。');
      if (input === 'resume') {
        if (goal?.status !== 'paused' || goal.used >= goal.budget) return tell('没有可恢复的目标；预算耗尽后请新建目标。');
        // A historical total cannot tell us how many tokens were output. Start a
        // fresh output counter only on explicit resume, never mix the two units.
        if (!goal.unit) tell('旧版目标已改为从本次恢复起累计输出 tokens，预算不变。');
        return start(ctx, { ...goal, unit: 'output', used: goal.unit ? goal.used : 0, status: 'active', note: '' });
      }
      if (goal?.status === 'active' || goal?.status === 'paused') return tell('已有目标；请先 /go clear 再替换。');
      let objective = input, budget = DEFAULT_BUDGET;
      if (input.startsWith('--')) {
        const m = /^--tokens\s+(\d+)(k?)\s+([\s\S]+)$/i.exec(input);
        if (!m) return tell(HELP);
        budget = Number(m[1]) * (m[2] ? 1000 : 1);
        if (!count(budget) || budget === 0) return tell('token 预算必须为正整数。');
        objective = m[3].trim();
      }
      start(ctx, { objective, budget, used: 0, unit: 'output', status: 'active', note: '' });
    },
  });

  pi.registerTool({
    name: REPORT, label: 'Go · 目标结果', exposure: 'model-only', defaultActive: false,
    description: 'Report verified completion or a blocker for the active /go goal. Does not start tasks or grant permissions.',
    parameters: Type.Object({ status: Type.Union([Type.Literal('complete'), Type.Literal('blocked')]), summary: Type.String({ minLength: 1, maxLength: 2000 }) }),
    async execute(_id, { status, summary }, signal, _update, ctx) {
      signal?.throwIfAborted();
      if (goal?.status !== 'active' || !summary.trim()) throw new Error('需要进行中的目标及非空结果说明');
      const nextStatus = status === 'complete' ? 'complete' : 'paused';
      save(ctx, { ...goal, status: nextStatus, note: summary.trim() });
      return { content: [{ type: 'text', text: `Go: ${nextStatus}。请向用户总结并结束。` }], details: { status } };
    },
  });
  pi.on('turn_start', () => { trackTurn = goal?.status === 'active'; });
  pi.on('turn_end', (e, ctx) => {
    if (!trackTurn || !goal) return;
    trackTurn = false;
    const delta = e.message.role === 'assistant' ? e.message.usage?.output : undefined;
    const measured = count(delta);
    const next = { ...goal, used: goal.used + (measured ? delta : 0) };
    if (next.status === 'active') {
      if (next.used >= next.budget) { next.status = 'budget'; next.note = '输出 token 预算耗尽'; }
      else if (e.outcome !== 'completed' || !measured) { next.status = 'paused'; next.note = !measured ? '缺少有效的输出 token 用量' : '执行出错或中止'; }
    }
    const stopped = goal.status === 'active' && next.status !== 'active';
    save(ctx, next);
    if (stopped) {
      ctx.ui.notify(`Go: ${next.note}`, 'warning');
      if (e.outcome === 'completed') ctx.abort();
    }
  });
  // This boundary runs after Pi's own queued work/retries. A single returned draft
  // and continuation decision avoid detached timers or stale queued prompts.
  pi.on('agent_before_settle', (e, ctx) => {
    if (goal?.status !== 'active') return;
    if (e.outcome !== 'completed') { save(ctx, { ...goal, status: 'paused', note: '执行出错或中止' }); return; }
    if (e.continue || ctx.hasPendingMessages() || e.context.pendingMessages.length) return;
    return { entries: [...e.entries, { type: 'custom_message' as const, customType: KEY, content: prompt(goal), display: false }], continue: true };
  });
  pi.on('agent_settled', (e, ctx) => {
    if (e.aborted && goal?.status === 'active') save(ctx, { ...goal, status: 'paused', note: '操作已中止' });
  });
}
