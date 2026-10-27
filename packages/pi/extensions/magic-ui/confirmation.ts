import type { ExtensionContext, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, type Focusable, matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { renderSelectionCard } from "./selection-card.js";

export type ConfirmResult = { allow: true } | { allow: false; feedback?: string };

type Stop = "yes" | "no" | "feedback";

export class ConfirmFeedbackDialog implements Focusable {
	focused = false;
	private stop: Stop = "no";
	private feedback = "";
	private cursor = 0;

	constructor(
		private theme: Theme,
		private ui: ExtensionUIContext,
		private done: (result: ConfirmResult) => void,
		private title: string,
		private body: string,
		private yesLabel = "✅ 允许",
		private noLabel = "❌ 拒绝",
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done({ allow: false, feedback: undefined });
			return;
		}

		if (matchesKey(data, "up") || matchesKey(data, "shift+tab")) {
			this.stop = this.stop === "yes" ? "feedback" : this.stop === "no" ? "yes" : "no";
			return;
		}
		if (matchesKey(data, "down") || matchesKey(data, "tab")) {
			this.stop = this.stop === "yes" ? "no" : this.stop === "no" ? "feedback" : "yes";
			return;
		}

		// Left/right also move between the two buttons for convenience.
		if (this.stop !== "feedback" && matchesKey(data, "left")) {
			this.stop = this.stop === "yes" ? "no" : "yes";
			return;
		}
		if (this.stop !== "feedback" && matchesKey(data, "right")) {
			this.stop = this.stop === "yes" ? "no" : "yes";
			return;
		}

		if (matchesKey(data, "return") || matchesKey(data, "enter")) {
			if (this.stop === "yes") {
				this.done({ allow: true });
			} else {
				this.done({ allow: false, feedback: this.feedback.trim() || undefined });
			}
			return;
		}

		// Editing the feedback field.
		if (this.stop === "feedback") {
			if (matchesKey(data, "backspace")) {
				if (this.cursor > 0) {
					this.feedback = this.feedback.slice(0, this.cursor - 1) + this.feedback.slice(this.cursor);
					this.cursor--;
				}
				return;
			}
			if (matchesKey(data, "delete")) {
				if (this.cursor < this.feedback.length) {
					this.feedback = this.feedback.slice(0, this.cursor) + this.feedback.slice(this.cursor + 1);
				}
				return;
			}
			if (matchesKey(data, "left")) {
				this.cursor = Math.max(0, this.cursor - 1);
				return;
			}
			if (matchesKey(data, "right")) {
				this.cursor = Math.min(this.feedback.length, this.cursor + 1);
				return;
			}
			// Ignore other control sequences; accept single printable chars.
			if (data.length === 1 && data.charCodeAt(0) >= 32) {
				this.feedback = this.feedback.slice(0, this.cursor) + data + this.feedback.slice(this.cursor);
				this.cursor++;
			}
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const bodyWidth = Math.max(1, width >= 6 ? width - 4 : width);
		const bodyLines = this.body.split("\n").flatMap(line =>
			wrapTextWithAnsi(th.fg("text", line), bodyWidth));
		const fbSelected = this.stop === "feedback";
		let inputDisplay = this.feedback;
		if (fbSelected) {
			const before = inputDisplay.slice(0, this.cursor);
			const cursorChar = this.cursor < inputDisplay.length ? inputDisplay[this.cursor] : " ";
			const after = inputDisplay.slice(this.cursor + 1);
			const marker = this.focused ? CURSOR_MARKER : "";
			inputDisplay = `${before}${marker}\x1b[7m${cursorChar}\x1b[27m${after}`;
		}
		const placeholder = this.feedback.length === 0 ? th.fg("dim", "(可选，回车拒绝时提交)") : "";
		const inputPart = this.feedback.length > 0 || fbSelected ? inputDisplay : placeholder;
		const plainLabel = (label: string) => label.replace(/^[✅❌🧹]\s*/u, "");
		return renderSelectionCard({
			width, theme: th, title: plainLabel(this.title), bodyLines, compact: true,
			items: [
				{ label: plainLabel(this.yesLabel) },
				{ label: plainLabel(this.noLabel) },
				{ label: `反馈：${inputPart}`, group: "可选反馈（拒绝时提交）" },
			],
			cursor: this.stop === "yes" ? 0 : this.stop === "no" ? 1 : 2,
			hints: [
				"↑↓/Tab 移动 · 反馈行输入文字 · Enter 提交 · Esc 取消",
				"↑↓/Tab 移动 · Enter 提交 · Esc 取消",
				"↑↓ 移动 · ↵ 提交 · Esc 取消",
			],
		});
	}

	invalidate(): void {}
	dispose(): void {}
}


/** Ordinary extension permissions preserve the member's existing lead policy. */
export async function confirmPermission(ctx: ExtensionContext, title: string, body: string): Promise<boolean> {
 const signal = ctx.signal;
 if (!ctx.hasUI || signal?.aborted) return false;
 const confirm = ctx.ui.confirm;
 if ((confirm as any)?.[Symbol.for('navi.team-confirm-relay')]) {
  const allow = await confirm.call(ctx.ui, title, body, { signal });
  return !signal?.aborted && allow === true;
 }
 // Never offer local consent when the managed member relay is unavailable.
 if (process.argv.includes('--team-approval-config')) return false;
 return (await showConfirmation(ctx, title, body, undefined, signal)).allow;
}

/** Presentation only: never routes approvals back into the team broker.
 * Explicit per-operation authorizations (review execution/network) also use this
 * directly: they must not inherit the ordinary permission auto-approval policy.
 */
export async function showConfirmation(
 ctx: ExtensionContext, title: string, body: string,
 labels?: { yes?: string; no?: string }, signal?: AbortSignal,
): Promise<ConfirmResult> {
 if (!ctx.hasUI || signal?.aborted) return { allow: false };
 // RPC clients cannot render terminal components.
 if (ctx.mode === "rpc") {
  const allow = await ctx.ui.confirm(title, body, { signal });
  return { allow: !signal?.aborted && allow === true };
 }
 let cleanup = () => {};
 try {
  const result = await ctx.ui.custom<ConfirmResult>((_tui, theme, _kb, done) => {
   const deny = () => done({ allow: false });
   signal?.addEventListener("abort", deny, { once: true });
   cleanup = () => signal?.removeEventListener("abort", deny);
   if (signal?.aborted) deny();
   return new ConfirmFeedbackDialog(theme, ctx.ui, done, title, body, labels?.yes, labels?.no);
  });
  return signal?.aborted ? { allow: false } : result;
 } finally { cleanup(); }
}
