import { Container, Markdown, Spacer, Text, truncateToWidth } from '@earendil-works/pi-tui';
import { stripVTControlCharacters } from 'node:util';
import { frameRows } from './team-display.ts';

export interface ChainCard {
  agent: string; step: number; task: string; status: 'running' | 'failed' | 'completed';
  output: string; error?: string; tools: string[]; usage: string;
}
const labels = { running: '⏳ 执行中', failed: '❌ 失败', completed: '✅ 已完成' };
const plain = (text: string) => stripVTControlCharacters(text);
const singleLine = (text: string) => plain(text).replace(/\s+/g, ' ').trim();

export function renderChainCards(cards: ChainCard[], total: number, usage: string, expanded: boolean, theme: any, markdownTheme: any) {
  const view = new Container();
  const completed = cards.filter(c => c.status === 'completed').length;
  const failed = cards.filter(c => c.status === 'failed').length;
  const running = cards.filter(c => c.status === 'running').length;
  const waiting = Math.max(0, total - cards.length);
  view.addChild(new Text(theme.fg('accent', `🔗 串行任务 · ${completed}/${total} 步完成`) +
    (failed ? theme.fg('error', `  ❌ ${failed} 步失败`) : '') +
    (running ? theme.fg('muted', `  ⏳ ${running} 步执行中`) : '') +
    (waiting ? theme.fg('muted', `  ${failed ? '⏭️' : '◷'} ${waiting} 步未执行`) : ''), 0, 0));
  for (const card of cards) {
    const body = new Container();
    const color = card.status === 'failed' ? 'error' : card.status === 'running' ? 'accent' : 'success';
    body.addChild(new Text(theme.fg(color, `${labels[card.status]}  步骤 ${card.step} · ${singleLine(card.agent)}`), 0, 0));
    body.addChild(new Spacer(1));
    if (expanded) {
      body.addChild(new Text(theme.fg('muted', '🎯 任务'), 0, 0));
      body.addChild(new Text(plain(card.task), 0, 0));
      body.addChild(new Spacer(1));
    }
    if (card.status === 'failed') {
      body.addChild(new Text(theme.fg('error', '⚠️ 失败原因'), 0, 0));
      const error = plain(card.error?.trim() || '未收到明确错误原因；请展开查看执行记录，不能据此认定代码或测试失败。');
      body.addChild(new Text(expanded ? error : error.slice(0, 600), 0, 0));
      body.addChild(new Spacer(1));
    }
    if (expanded && card.tools.length) {
      body.addChild(new Text(theme.fg('muted', '🛠️ 执行记录'), 0, 0));
      for (const call of card.tools) body.addChild(new Text(`  • ${call}`, 0, 0));
      body.addChild(new Spacer(1));
    }
    body.addChild(new Text(theme.fg('muted', card.status === 'running' ? '📝 当前进展' : card.status === 'failed' ? '📝 最后输出（非验收结论）' : '📋 结果'), 0, 0));
    if (expanded && card.output.trim()) body.addChild(new Markdown(plain(card.output).trim(), 0, 0, markdownTheme));
    else {
      const output = plain(card.output).trim();
      const prose = output.split(/(?:^|\n)\s*```/)[0].trim();
      const preview = prose.split('\n').slice(0, 5).join('\n').slice(0, 700);
      body.addChild(new Text(preview || (output ? '结果包含代码块，展开查看。' : card.status === 'running' ? '等待成员输出…' : '暂无文字结果。'), 0, 0));
      if (output.length > preview.length) body.addChild(new Text(theme.fg('dim', '… 展开查看完整结果'), 0, 0));
    }
    body.addChild(new Spacer(1));
    body.addChild(new Text(theme.fg('dim', `🛠️ ${card.tools.length} 次工具调用${card.usage ? `  ·  📊 ${card.usage}` : ''}`), 0, 0));
    view.addChild(new Spacer(1));
    view.addChild({
      invalidate() { body.invalidate(); },
      render(width: number) {
        if (width <= 0) return [];
        const lines = body.render(width >= 6 ? width - 4 : width);
        return frameRows(lines, width, text => theme.fg('dim', text)).map(line => theme.bg ? theme.bg('customMessageBg', line) : line);
      },
    });
  }
  view.addChild(new Spacer(1));
  if (usage) view.addChild(new Text(theme.fg('dim', `📊 总用量  ${usage}`), 0, 0));
  view.addChild(new Text(theme.fg('muted', expanded ? 'Ctrl+O 收起：只看各步骤结论' : 'Ctrl+O 展开：任务 · 执行记录 · 完整结果'), 0, 0));
  return {
    invalidate() { view.invalidate(); },
    render(width: number) {
      if (width <= 0) return [];
      return view.render(width).map(line => truncateToWidth(line, width));
    },
  };
}
