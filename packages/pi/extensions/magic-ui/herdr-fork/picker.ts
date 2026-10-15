import { matchesKey } from '@earendil-works/pi-tui';
import { renderSelectionCard } from '../editor-footer.js';

/** Keyboard-only session card. Navigation never creates a pane until Enter. */
export function createSessionPicker(tui: any, theme: any, done: (value?: string) => void, labels: string[], options: { title?: string; scope?: string; enterHint?: string } = {}) {
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
      const height = Math.max(1, Math.min(8, (tui.terminal.rows || 24) - 10));
      const start = Math.max(0, Math.min(cursor - Math.floor(height / 2), labels.length - height));
      return ['', ...renderSelectionCard({
        width, theme,
        title: options.title ?? '复制会话到新分屏',
        subtitle: `${options.scope ?? '当前项目'} · ${labels.length} 个会话 · ${labels.length ? cursor + 1 : 0}/${labels.length}`,
        items: labels.slice(start, start + height).map(label => ({ label })),
        cursor: cursor - start,
        warning: labels.length ? undefined : '没有可选择的会话',
        hints: ['←/→ 跳过 10 个 · ↑↓ 选择', options.enterHint ?? 'Enter 创建分屏 · Esc 取消'],
      })];
    },
    handleInput(data: string) {
      if (finished) return;
      if (matchesKey(data, 'escape')) { finish(); return; }
      if (matchesKey(data, 'enter')) {
        if (labels.length) finish(labels[cursor]);
        return;
      }
      if (matchesKey(data, 'left') || matchesKey(data, 'up')) {
        cursor = Math.max(0, cursor - (matchesKey(data, 'left') ? 10 : 1));
      } else if (matchesKey(data, 'right') || matchesKey(data, 'down')) {
        cursor = Math.min(Math.max(0, labels.length - 1), cursor + (matchesKey(data, 'right') ? 10 : 1));
      } else return;
      tui.requestRender();
    },
  };
}
