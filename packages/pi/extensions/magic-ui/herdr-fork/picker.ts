import { matchesKey } from '@earendil-works/pi-tui';
import { renderSelectionCard } from '../selection-card.js';

export type SessionPickerOptions = { title?: string; scope?: string; enterHint?: string; itemNoun?: string };

export function sessionPickerCursor(data: string, cursor: number, count: number): number | undefined {
  const delta = matchesKey(data, 'left') ? -10 : matchesKey(data, 'right') ? 10
    : matchesKey(data, 'up') ? -1 : matchesKey(data, 'down') ? 1 : undefined;
  return delta === undefined ? undefined : Math.max(0, Math.min(Math.max(0, count - 1), cursor + delta));
}

export function renderSessionPicker(width: number, rows: number, theme: any, labels: string[], cursor: number, options: SessionPickerOptions = {}) {
  const height = Math.max(1, Math.min(8, (rows || 24) - 10));
  const start = Math.max(0, Math.min(cursor - Math.floor(height / 2), labels.length - height));
  return renderSelectionCard({
    width, theme, compact: true,
    title: options.title ?? '复制会话到新分屏',
    subtitle: `${options.scope ?? '当前项目'} · ${labels.length} 个${options.itemNoun ?? '会话'} · ${labels.length ? cursor + 1 : 0}/${labels.length}`,
    items: labels.slice(start, start + height).map(label => ({ label })),
    cursor: cursor - start,
    warning: labels.length ? undefined : '没有可选择的会话',
    hints: [`↑↓ 选择 · ${options.enterHint ?? 'Enter 创建分屏 · Esc 取消'}`, options.enterHint ?? 'Enter 创建分屏 · Esc 取消'],
  });
}

/** Keyboard-only session card. Navigation never creates a pane until Enter. */
export function createSessionPicker(tui: any, theme: any, done: (value?: string) => void, labels: string[], options: SessionPickerOptions = {}) {
  let cursor = 0;
  let finished = false;
  const finish = (value?: string) => {
    if (finished) return;
    finished = true;
    done(value);
  };
  return {
    invalidate() {},
    render(width: number) {
      return ['', ...renderSessionPicker(width, tui.terminal.rows, theme, labels, cursor, options)];
    },
    handleInput(data: string) {
      if (finished) return;
      if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) { finish(); return; }
      if (matchesKey(data, 'enter')) {
        if (labels.length) finish(labels[cursor]);
        return;
      }
      const next = sessionPickerCursor(data, cursor, labels.length);
      if (next === undefined) return;
      cursor = next;
      tui.requestRender();
    },
  };
}
