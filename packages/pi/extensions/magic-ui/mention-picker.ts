import type { SessionInfo } from '@earendil-works/pi-coding-agent';
import type { AutocompleteItem } from '@earendil-works/pi-tui';
import { externalIdentity } from './external-sessions.js';

export const mentionPickerOptions = {
  title: '引用其他会话', scope: '全部项目',
  enterHint: 'Enter 插入路径引用 · Esc 取消 · 正文按需读取',
};

export function mentionLabel(session: SessionInfo): string {
  const clean = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
  return `${clean(externalIdentity(session))} ${clean(session.name || session.firstMessage || '未命名').slice(0, 80)} · ${clean(session.cwd)} · ${clean(session.id)}`;
}

export function mentionSearchText(session: SessionInfo): string {
  return `${externalIdentity(session)} ${session.name ?? ''} ${session.firstMessage} ${session.cwd} ${session.id}`.toLowerCase();
}

/** Pi has no public autocomplete presentation hook. Keep this compatibility
 * boundary guarded: unsupported runtimes retain their native completion UI.
 * Selection/insertion/undo and asynchronous cancellation remain owned by Pi.
 */
export function mentionCompletionState(editor: unknown) {
  const owner = editor as { isShowingAutocomplete(): boolean; autocompleteList?: {
    filteredItems?: AutocompleteItem[];
    getSelectedItem?: () => AutocompleteItem | undefined;
    setSelectedIndex?: (index: number) => void;
  } };
  if (!owner.isShowingAutocomplete()) return;
  const list = owner.autocompleteList;
  const items = list?.filteredItems;
  if (!Array.isArray(items) || !items.length || typeof list?.getSelectedItem !== 'function'
    || typeof list.setSelectedIndex !== 'function'
    || !items.every(item => typeof item?.value === 'string' && item.value.startsWith('$session:'))) return;
  const cursor = items.indexOf(list.getSelectedItem()!);
  if (cursor < 0) return;
  return { labels: items.map(item => item.label ?? item.value), cursor,
    select: (index: number) => list.setSelectedIndex!(index) };
}
