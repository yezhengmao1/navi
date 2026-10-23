import { Container, Markdown, Spacer, Text, truncateToWidth } from '@earendil-works/pi-tui';
import { stripVTControlCharacters } from 'node:util';
import { frameRows } from './team-display.ts';

export function formatSubagentUsage(usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }): string {
  // Pi reports uncached input and cache reads/writes separately. Do not add contextTokens again.
  const total = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite]
    .reduce<number>((sum, value) => sum + (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0), 0);
  const count = total >= 1e8 ? `${(total / 1e8).toFixed(2)}亿` : total >= 1e4 ? `${(total / 1e4).toFixed(1)}万` : `${Math.round(total)}`;
  return `${count} 词元`;
}

/** Restore one background after every SGR change, including Markdown/code resets. */
export function paintCardBackground(line: string, theme: any): string {
  if (!theme.bg) return line;
  const background = theme.bg('customMessageBg', '').replace(/\x1b\[49m$/, '');
  if (!background) return line;
  const tokens = line.split(/(\x1b(?:\[[0-?]*[ -/]*[@-~]|[_\]P^X][\s\S]*?(?:\x07|\x1b\\)))/g);
  return background + tokens.map(token => /^\x1b\[[0-?]*[ -/]*m$/.test(token) ? token + background : token).join('') + '\x1b[49m';
}

export interface SubagentRenderState { subagentUsage?: string; subagentProgress?: string }
export function updateSubagentHeaderUsage(state: SubagentRenderState | undefined, results: { usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }; exitCode?: number; stopReason?: string }[], progress?: { total: number; unit: string }) {
  if (!state) return;
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const result of results) for (const key of Object.keys(total) as (keyof typeof total)[])
    total[key] += result.usage?.[key] ?? 0;
  state.subagentUsage = results.length ? formatSubagentUsage(total) : undefined;
  if (progress) {
    const running = results.filter(r => r.exitCode === -1).length;
    const completed = results.filter(r => r.exitCode === 0 && !['error', 'aborted'].includes(r.stopReason ?? '')).length;
    const failed = results.length - completed - running;
    state.subagentProgress = `${completed}/${progress.total} ${progress.unit}完成${failed ? ` · ${failed} 失败` : ''}${running ? ` · ${running} 执行中` : ''}`;
  } else state.subagentProgress = undefined;
}

/** Read shared row state at render time: result updates also update an already-built call header. */
export function subagentCallHeader(text: string | (() => string), theme: any, readUsage: () => string | undefined) {
  return {
    invalidate() {},
    render(width: number) {
      if (width <= 0) return [];
      const [title, ...rest] = (typeof text === 'function' ? text() : text).split('\n');
      const usage = readUsage();
      return new Text([title + (usage ? theme.fg('dim', ` · ${usage}`) : ''), ...rest].join('\n'), 0, 0)
        .render(width).map(line => truncateToWidth(line, width));
    },
  };
}

export interface ChainCard {
  agent: string; step: number; task: string; status: 'running' | 'failed' | 'completed';
  output: string; error?: string; tools: string[]; usage: string;
}
const labels = { running: '⏳ 执行中', failed: '❌ 失败', completed: '✅ 已完成' };
const plain = (text: string) => stripVTControlCharacters(text);
const singleLine = (text: string) => plain(text).replace(/\s+/g, ' ').trim();

export function renderChainCards(cards: ChainCard[], total: number, _usage: string, expanded: boolean, theme: any, markdownTheme: any, mode: 'single' | 'chain' | 'parallel' = 'chain') {
  const view = new Container();
  // Overall progress and usage belong exclusively to the tool-call heading.
  for (const card of cards) {
    const body = new Container();
    const color = card.status === 'failed' ? 'error' : card.status === 'running' ? 'accent' : 'success';
    body.addChild(new Text(theme.fg(color, `${labels[card.status]} · ${mode === 'single' ? '' : `${mode === 'chain' ? '步骤' : '任务'} ${card.step} · `}${singleLine(card.agent)}${card.usage ? ` · ${card.usage}` : ''}`), 0, 0));
    if (expanded) {
      body.addChild(new Text(theme.fg('muted', '🎯 任务'), 0, 0));
      body.addChild(new Text(plain(card.task), 0, 0));
    }
    if (card.status === 'failed') {
      body.addChild(new Text(theme.fg('error', '⚠️ 失败原因'), 0, 0));
      const error = plain(card.error?.trim() || '未收到明确错误原因；请展开查看执行记录，不能据此认定代码或测试失败。');
      body.addChild(new Text(expanded ? error : error.slice(0, 600), 0, 0));
    }
    if (expanded && card.tools.length) {
      body.addChild(new Text(theme.fg('muted', `🛠️ 执行记录 · ${card.tools.length} 次`), 0, 0));
      for (const call of card.tools) body.addChild(new Text(`  • ${call}`, 0, 0));
    }
    body.addChild(new Text(theme.fg('muted', card.status === 'running' ? '📝 当前进展' : card.status === 'failed' ? '📝 最后输出（非验收结论）' : '📋 结果'), 0, 0));
    if (expanded && card.output.trim()) body.addChild(new Markdown(plain(card.output).trim(), 0, 0, markdownTheme));
    else {
      const output = plain(card.output).trim();
      const prose = output.split(/(?:^|\n)\s*```/)[0].trim();
      const preview = prose.split('\n').slice(0, 5).join('\n').slice(0, 700);
      if (preview) body.addChild(new Markdown(preview, 0, 0, markdownTheme));
      else body.addChild(new Text(output ? '结果包含代码块，展开查看。' : card.status === 'running' ? '等待成员输出…' : '暂无文字结果。', 0, 0));
      if (output.length > preview.length) body.addChild(new Text(theme.fg('dim', '… 展开查看完整结果'), 0, 0));
    }
    view.addChild(new Spacer(1));
    view.addChild({
      invalidate() { body.invalidate(); },
      render(width: number) {
        if (width <= 0) return [];
        const lines = body.render(width >= 6 ? width - 4 : width);
        return frameRows(lines, width, text => theme.fg('dim', text), false, 'dashed');
      },
    });
  }
  view.addChild(new Spacer(1));
  view.addChild(new Text(theme.fg('muted', expanded ? 'Ctrl+O 收起：只看各任务结论' : 'Ctrl+O 展开：任务 · 执行记录 · 完整结果'), 0, 0));
  return {
    invalidate() { view.invalidate(); },
    render(width: number) {
      if (width <= 0) return [];
      return view.render(width).map(line => paintCardBackground(truncateToWidth(line, width, '…', true), theme));
    },
  };
}
