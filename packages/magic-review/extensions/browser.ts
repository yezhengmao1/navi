import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';

export type BrowserResult = {
  action: 'status' | 'recheck' | 'discuss' | 'cancel' | 'resume';
  findingId?: string;
  status?: 'open' | 'accepted' | 'dismissed' | 'resolved';
};

type Finding = {
  id: string; title?: string; priority?: string; status?: string; location?: string;
  evidence?: string; triggerOrClaim?: string; trigger?: string; consequence?: string;
  verification?: string; suggestion?: string; confidenceBasis?: string;
  verificationDecision?: string; verdict?: {reason?: string; evidence?: string};
};
type ReviewRun = {
  id?: string; state?: string; stage?: string; target?: string; calls?: number;
  createdAt?: string; updatedAt?: string; elapsedMs?: number;
  budget?: { maxCalls?: number; maxTokens?: number; timeoutMs?: number };
  usage?: { input?: number; output?: number; totalTokens?: number; cost?: number };
  findings?: readonly Finding[];
};

// Source text is never terminal markup. Strip control bytes (including C1),
// bidi overrides and line separators before adding trusted theme styling.
function clean(value: unknown): string {
  return String(value ?? '—').replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ');
}
function number(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}
function elapsed(run: ReviewRun): number {
  if (run.elapsedMs !== undefined) return number(run.elapsedMs);
  const start = Date.parse(run.createdAt ?? '');
  const end = ['running', 'verifying'].includes(run.state ?? '') ? Date.now() : Date.parse(run.updatedAt ?? '');
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
}

function tokens(value: number | undefined): string {
  const n = number(value);
  return n >= 1e8 ? `${(n / 1e8).toFixed(2)}亿` : n >= 1e4 ? `${(n / 1e4).toFixed(1)}万` : `${Math.round(n)}`;
}
function duration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Plain, sanitized strings, also used by the browser and non-TUI fallback. */
export function widgetLines(run: ReviewRun): string[] {
  const states: Record<string, string> = { prepared: '◷ 待审查', running: '⏳ 执行中', verifying: '⏳ 独立验证中', completed: '✅ 已完成', failed: '❌ 失败', cancelled: '⏹️ 已取消', interrupted: '⚠️ 已中断' };
  const stages: Record<string, string> = { discovery: '发现问题', recheck: '复查', timeout: '超时' };
  const stage = stages[run.stage ?? ''];
  return [
    `🔍 魔法审查 · ${states[run.state ?? ''] ?? clean(run.state)}${stage ? ` · ${stage}` : ''} · ${run.findings?.length ?? 0} 项发现`,
    `调用 ${number(run.calls)}/${clean(run.budget?.maxCalls)} · ${tokens(run.usage?.totalTokens)}/${run.budget?.maxTokens === undefined ? '—' : tokens(run.budget.maxTokens)} 词元`,
    `$${number(run.usage?.cost).toFixed(4)} · ${duration(elapsed(run))} / ${run.budget?.timeoutMs === undefined ? '—' : duration(number(run.budget.timeoutMs))}`,
  ];
}

/** Subagent-style dashed card; keep this package independent of project extensions. */
export function reviewWidget(run: ReviewRun, theme: { fg(color: any, text: string): string }) {
  return {
    invalidate() {},
    render(width: number): string[] {
      width = Math.max(0, Math.floor(width));
      if (!width) return [];
      const framed = width >= 6;
      const inner = framed ? width - 4 : width;
      const color = run.state === 'completed' ? 'success' : ['failed', 'interrupted'].includes(run.state ?? '') ? 'error' : 'accent';
      const rows = widgetLines(run).map((line, index) => theme.fg(index === 0 ? color : 'dim', truncateToWidth(line, inner, '…')));
      if (!framed) return rows;
      const border = (text: string) => theme.fg('dim', text);
      return [border(`┌${'╌'.repeat(width - 2)}┐`), ...rows.map(line =>
        border('╎ ') + line + ' '.repeat(Math.max(0, inner - visibleWidth(line))) + border(' ╎')),
      border(`└${'╌'.repeat(width - 2)}┘`)];
    },
  };
}

/** Returns intent only: persistence, confirmation and execution belong to the caller. */
export async function browseReview(ctx: ExtensionContext, run: ReviewRun): Promise<BrowserResult | undefined> {
  if (ctx.mode !== 'tui' || typeof ctx.ui?.custom !== 'function') {
    ctx.ui?.notify?.(widgetLines(run).join('\n') + '\n交互审查需要 TUI 模式。', 'info');
    return undefined;
  }
  return ctx.ui.custom<BrowserResult | undefined>((tui, theme, _keys, done) => {
    const priorities = ['all', 'must-fix', 'should-fix', 'optional'];
    const statuses = ['all', 'open', 'accepted', 'dismissed', 'resolved'];
    const decisions = ['confirmed', 'all', 'uncertain', 'rejected', 'duplicate'];
    let decision = 0;
    let priority = 0, status = 0, selected = 0, offset = 0;
    let detail = false, finished = false;
    const pageSize = 10;
    let detailLength = 0;
    const filtered = () => (run.findings ?? []).filter(f =>
      (decisions[decision] === 'all' || (f.verificationDecision ?? 'confirmed') === decisions[decision]) &&
      (!priority || f.priority === priorities[priority]) &&
      (!status || (f.status ?? 'open') === statuses[status]));
    const finish = (result?: BrowserResult) => {
      if (!finished) { finished = true; done(result); }
    };
    return {
      invalidate() { /* No themed or width-dependent output is cached. */ },
      render(width: number) {
        if (width < 1) return [];
        const activeTheme = ctx.ui.theme ?? theme;
        const fit = (text: string) => truncateToWidth(text, width, '');
        const findings = filtered();
        selected = Math.max(0, Math.min(selected, findings.length - 1));
        const finding = findings[selected];
        const lines = widgetLines(run).map(line => activeTheme.fg('muted', fit(line)));
        lines[0] = activeTheme.fg('accent', fit(widgetLines(run)[0]));
        lines.push(fit(`优先级[p] ${priorities[priority]} · 状态[s] ${statuses[status]} · 复核[c] ${decisions[decision]} · ${findings.length ? selected + 1 : 0}/${findings.length}`));
        if (detail && finding) {
          const fields = [
            ['标题', finding.title], ['位置', finding.location], ['证据', finding.evidence],
            ['触发条件/主张', finding.triggerOrClaim ?? finding.trigger], ['后果', finding.consequence],
            ['置信依据', finding.confidenceBasis], ['验证', finding.verification], ['独立复核', finding.verificationDecision], ['复核理由', finding.verdict?.reason], ['复核证据', finding.verdict?.evidence], ['建议', finding.suggestion],
          ];
          const body = fields.flatMap(([label, value]) => wrapTextWithAnsi(`${label}: ${clean(value)}`, width));
          detailLength = body.length;
          offset = Math.min(offset, Math.max(0, body.length - pageSize));
          lines.push(...body.slice(offset, offset + pageSize).map(fit));
          lines.push(fit(`详情行 ${offset + 1}–${Math.min(offset + pageSize, body.length)}/${body.length}`));
        } else {
          const start = Math.max(0, selected - pageSize + 1);
          lines.push(...findings.slice(start, start + pageSize).map((f, i) => {
            const text = fit(`${start + i === selected ? '›' : ' '} [${clean(f.priority)}][${clean(f.status ?? 'open')}] ${clean(f.title)}`);
            return start + i === selected ? activeTheme.fg('accent', text) : text;
          }));
          if (!findings.length) lines.push(fit('没有匹配的发现'));
        }
        const help = [detail ? '↑↓ 滚动 · esc 返回' : '↑↓ 选择 · enter 详情 · esc 退出',
          'p 优先级 · s 状态 · c 复核结论筛选',
          ...(finding ? ['a 接受 · d 忽略 · r 解决 · o 重开', 'v 复查 · q 讨论'] : []),
          'x 取消运行 · u 恢复运行'];
        lines.push(...help.map(line => activeTheme.fg('dim', fit(line))));
        return lines;
      },
      handleInput(data: string) {
        if (finished) return;
        const findings = filtered();
        selected = Math.max(0, Math.min(selected, findings.length - 1));
        const finding = findings[selected];
        if (matchesKey(data, Key.escape)) {
          if (detail) { detail = false; offset = 0; } else return finish();
        } else if (matchesKey(data, 'x')) return finish({ action: 'cancel' });
        else if (matchesKey(data, 'u')) return finish({ action: 'resume' });
        else if (matchesKey(data, 'p') || matchesKey(data, 's') || matchesKey(data, 'c')) {
          if (matchesKey(data, 'p')) priority = (priority + 1) % priorities.length;
          else if (matchesKey(data, 's')) status = (status + 1) % statuses.length;
          else decision = (decision + 1) % decisions.length;
          selected = 0; offset = 0; detail = false;
        } else if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
          const delta = matchesKey(data, Key.up) ? -1 : 1;
          if (detail) offset = Math.max(0, Math.min(offset + delta, Math.max(0, detailLength - pageSize)));
          else selected = Math.max(0, Math.min(selected + delta, findings.length - 1));
        } else if (finding) {
          if (matchesKey(data, Key.enter)) { detail = true; offset = 0; }
          else if (matchesKey(data, 'v')) return finish({ action: 'recheck', findingId: finding.id });
          else if (matchesKey(data, 'q')) return finish({ action: 'discuss', findingId: finding.id });
          else {
            const choices = { a: 'accepted', d: 'dismissed', r: 'resolved', o: 'open' } as const;
            for (const key of Object.keys(choices) as (keyof typeof choices)[]) {
              if (matchesKey(data, key)) return finish({ action: 'status', findingId: finding.id, status: choices[key] });
            }
          }
        }
        tui.requestRender();
      },
    };
  });
}
