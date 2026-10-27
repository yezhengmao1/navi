import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Input, matchesKey } from '@earendil-works/pi-tui';
import { renderSelectionCard } from './selection-card.js';
import { createSessionPicker } from './herdr-fork/picker.js';

/** Ordinary selection, not an authorization: RPC retains the native protocol. */
export async function selectCard(ctx: ExtensionContext, title: string, choices: string[]) {
 if (!ctx.hasUI || ctx.signal?.aborted) return undefined;
 if (ctx.mode === 'rpc') return ctx.ui.select(title, choices, { signal: ctx.signal });
 return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) =>
  createSessionPicker(tui, theme, done, choices, {
   title, scope: '请选择', itemNoun: '选项', enterHint: 'Enter 提交 · Esc 取消',
  }));
}

/** Use the standard Input for paste, Unicode editing, IME focus and scrolling. */
export function createInputCard(theme: any, done: (value?: string) => void, title: string) {
 const input = new Input();
 let finished = false;
 const finish = (value?: string) => { if (!finished) { finished = true; done(value); } };
 input.onSubmit = finish;
 input.onEscape = () => finish();
 return {
  get focused() { return input.focused; },
  set focused(value: boolean) { input.focused = value; },
  invalidate() { input.invalidate(); },
  handleInput(data: string) {
   if (finished) return;
   if (matchesKey(data, 'ctrl+c')) finish();
   else input.handleInput(data);
  },
  render(width: number) {
   return renderSelectionCard({
    width, theme, title, compact: true,
    bodyLines: input.render(Math.max(1, width >= 6 ? width - 4 : width)),
    items: [], cursor: -1,
    hints: ['Enter 提交 · Esc 取消', '↵ 提交 · Esc 取消'],
   });
  },
 };
}

export async function inputCard(ctx: ExtensionContext, title: string) {
 if (!ctx.hasUI || ctx.signal?.aborted) return undefined;
 if (ctx.mode === 'rpc') return ctx.ui.input(title, undefined, { signal: ctx.signal });
 return ctx.ui.custom<string | undefined>((_tui, theme, _kb, done) =>
  createInputCard(theme, done, title));
}
