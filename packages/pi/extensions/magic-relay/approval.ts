import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { renderSelectionCard } from '../magic-ui/selection-card.js';

type Consent = { allow: boolean };

// Never feed untrusted escape sequences to the terminal or to ANSI-aware layout.
// Keep line breaks in the task, but don't let a path manufacture extra UI rows.
function display(text: string, multiline = false) {
  return text.replace(/[\p{Cc}\p{Bidi_Control}\p{Zl}\p{Zp}]/gu, ch => {
    if (multiline && ch === '\n') return ch;
    const code = ch.codePointAt(0)!;
    return code < 256 ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u${code.toString(16)}`;
  });
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// Word wrapping trims whitespace at line boundaries. Hard-wrap the payload so
// code indentation and blank lines remain inspectable, even across pages.
function wrapPreview(text: string, width: number): string[] {
  const rows: string[] = [];
  for (const line of text.split('\n')) {
    if (visibleWidth(line) <= width) { rows.push(line); continue; }
    let row = '', used = 0;
    for (const { segment } of graphemes.segment(line)) {
      const size = visibleWidth(segment);
      if (used + size > width) { rows.push(row); row = ''; used = 0; }
      row += segment;
      used += size;
    }
    rows.push(row);
  }
  return rows;
}

export async function showRelayApproval(ctx: ExtensionContext, task: string, signal?: AbortSignal): Promise<Consent> {
  if (ctx.mode !== 'tui' || !ctx.hasUI || signal?.aborted) return { allow: false };
  const directory = `目录：${display(ctx.cwd)}`;
  const preview = display(task, true);
  let cleanup = () => {};
  try {
    const answer = await ctx.ui.custom<Consent>((tui, theme, _kb, done) => {
      let allow = false, page = 0, pages = 0;
      let cachedWidth = 0, rows: string[] = [];
      const deny = () => done({ allow: false });
      signal?.addEventListener('abort', deny, { once: true });
      cleanup = () => signal?.removeEventListener('abort', deny);
      if (signal?.aborted) deny();

      return {
        render(width) {
          const inner = width - 4; // Shared selection card has a frame and a space on either side.
          const risk = wrapTextWithAnsi('外部 agy 可能修改文件并产生费用。', Math.max(1, inner));
          // Six frame/title/action rows, plus the directory header and risk.
          const perPage = Math.min(3, tui.terminal.rows - 7 - risk.length);
          if (inner < 16 || perPage < 1) {
            allow = false;
            pages = 0;
            return width > 0 && tui.terminal.rows > 0 ? [truncateToWidth('请放大终端 · Esc 取消', width)] : [];
          }
          const longPath = visibleWidth(directory) > inner;
          if (cachedWidth !== inner) {
            rows = wrapPreview(longPath ? `${directory}\n任务：\n${preview}` : preview, inner);
            cachedWidth = inner;
          }
          pages = Math.ceil(rows.length / perPage);
          page = Math.min(page, pages - 1);
          return renderSelectionCard({
            width, theme, compact: true, title: '委派给 agy？',
            bodyLines: [...risk.map(s => theme.fg('warning', s)),
              theme.fg('muted', longPath ? '目录及任务：' : directory), ...rows.slice(page * perPage, (page + 1) * perPage)],
            subtitle: `任务 ${page + 1}/${pages}${pages > 1 ? ' · ↑↓ 翻页' : ''}`,
            items: [], cursor: -1,
            actions: [{ label: '拒绝', active: !allow }, { label: '允许', active: allow }],
            hints: ['←→ 选择 · Enter 确认 · Esc 取消', '←→ 选择 · ↵ 确认', '←→ ↵'],
          });
        },
        handleInput(data) {
          if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) return deny();
          if (matchesKey(data, 'enter')) return done({ allow: pages > 0 && allow && !signal?.aborted });
          if (!pages) return;
          if (matchesKey(data, 'up') || matchesKey(data, 'pageUp')) page = Math.max(0, page - 1);
          else if (matchesKey(data, 'down') || matchesKey(data, 'pageDown')) page = Math.min(pages - 1, page + 1);
          else if (matchesKey(data, 'left')) allow = false;
          else if (matchesKey(data, 'right')) allow = true;
          else return;
          tui.requestRender();
        },
        invalidate() { cachedWidth = 0; },
      };
    }, { blocked: { kind: 'permission', message: '委派给 agy？' } });
    return { allow: !signal?.aborted && answer?.allow === true };
  } finally { cleanup(); }
}
