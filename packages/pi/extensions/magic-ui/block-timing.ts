import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// Type-only import: safety-guard remains independently loadable.
import type { GuardTiming } from "../safety-guard.js";

const ENTRY = "magic-ui:block-timing";
const GUARD_ENTRY = "safety-guard:timing";
type Span = { kind: "thinking" | "text"; start: number; end?: number };
type MessageKey = { provider?: string; model?: string; timestamp?: number };
export const messageKey = (m: MessageKey) => JSON.stringify([m.provider, m.model, m.timestamp]);
export const durationLabel = (ms: number) => ms < 60_000 ? `${(Math.max(0, ms) / 1000).toFixed(1)}s`
	: `${Math.floor(ms / 60_000)}m ${Math.floor(ms % 60_000 / 1000)}s`;

/** Per contentIndex, not per turn. Provider wait is deliberately excluded. */
export class BlockClock {
	messages = new Map<string, Map<number, Span>>();
	tools = new Map<string, { start: number; end?: number; duration?: number }>();
	guards = new Map<string, GuardTiming>();
	update(key: string, type: string, index: number, now: number) {
		const kind = type.startsWith("thinking_") ? "thinking" : type.startsWith("text_") ? "text" : undefined;
		if (!kind || !Number.isInteger(index)) return;
		let blocks = this.messages.get(key);
		if (!blocks) this.messages.set(key, blocks = new Map());
		if (type.endsWith("_start") || type.endsWith("_delta")) {
			for (const [other, span] of blocks) if (other !== index) span.end ??= now;
			if (!blocks.has(index)) blocks.set(index, { kind, start: now });
		} else if (type.endsWith("_end")) {
			const span = blocks.get(index);
			if (span) span.end ??= now;
		}
	}
	finish(key: string, now: number) {
		for (const span of this.messages.get(key)?.values() ?? []) span.end ??= now;
	}
	elapsed(key: string, indices: number[], now: number): number | undefined {
		const spans = indices.map(i => this.messages.get(key)?.get(i)).filter((v): v is Span => !!v);
		return spans.length ? spans.reduce((sum, s) => sum + Math.max(0, (s.end ?? now) - s.start), 0) : undefined;
	}
	clear() { this.messages.clear(); this.tools.clear(); this.guards.clear(); }
}

export function guardTimingLabel(guard: GuardTiming | undefined, executionMs: number | undefined, now: number): string | undefined {
	if (!guard) return executionMs === undefined ? undefined : durationLabel(executionMs);
	const parts: string[] = [];
	const elapsed = guard.phaseStarted === undefined ? 0 : Math.max(0, now - guard.phaseStarted);
	if (guard.reviewMs !== undefined) parts.push(`${guard.phase === "review" ? "审查中" : "审查"} ${durationLabel(guard.reviewMs + (guard.phase === "review" ? elapsed : 0))}`);
	if (guard.waitMs !== undefined) parts.push(`等待确认 ${durationLabel(guard.waitMs + (guard.phase === "confirm" ? elapsed : 0))}`);
	if (guard.status === "blocked") parts.push("已阻止");
	else if (guard.status === "interrupted") parts.push("已中断");
	else if (guard.status === "passed" && executionMs !== undefined) parts.push(`执行 ${durationLabel(executionMs)}`);
	return parts.join(" · ") || undefined;
}

/** Remove OSC 8 links from file-tool titles, retaining colors and other styles. */
export const stripToolPathLinks = (text: string) => text.replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "");

export function timingRow(left: string, right: string, width: number, dim: (s: string) => string,
	background: (s: string) => string = s => s): string {
	if (width <= 0) return "";
	const label = truncateToWidth(right, width, "");
	const room = Math.max(0, width - visibleWidth(label) - 2);
	const trimmed = sliceByColumn(left, 0, visibleWidth(stripTerminalSequences(left).trimEnd()), true);
	// truncateToWidth resets ANSI styles before its ellipsis, including background.
	const title = truncateToWidth(trimmed, room, background("…"));
	// The sliced title may close its background. Paint the entire new tail,
	// not just the digits, and do not inherit bold/italic title styling.
	return title + background("\x1b[22;23;39m" + " ".repeat(Math.max(0, width - visibleWidth(title) - visibleWidth(label))) + dim(label));
}

/** Pi 1.1 lacks an assistant-block renderer API. Adapt only mounted instances,
 * guarded by shape; never change package files, prototypes, or message content.
 * Restore on disposal. Unknown component shapes are left untouched.
 */
export function blockTimingAdapter(clock: BlockClock, dim: (s: string) => string, now = () => performance.now(),
	toolBackground: (text: string, node: any) => string = text => text) {
	const restores = new Map<any, () => void>();
	const decorated = new WeakSet<object>();
	function decorate(node: any) {
		const m = node.lastMessage;
		if (!Array.isArray(m?.content) || !Array.isArray(node.contentContainer?.children)) return;
		const children = node.contentContainer.children;
		let cursor = m.content.some((c: any) => c.type === "text" && c.text?.trim() || c.type === "thinking" && c.thinking?.trim()) ? 1 : 0;
		let thinkingRun = 0;
		for (let i = 0; i < m.content.length; i++) {
			const c = m.content[i];
			const indices = [i];
			if (c.type === "thinking") {
				while (m.content[i + 1]?.type === "thinking") indices.push(++i);
				if (!indices.some(j => m.content[j].thinking?.trim())) continue;
			} else if (c.type !== "text" || !c.text?.trim()) continue;
			const hidden = c.type === "thinking" && (node.thinkingVisibilityOverrides?.get(thinkingRun++) ?? node.hideThinkingBlock);
			const child = children[cursor++];
			if (child && typeof child.render === "function" && !decorated.has(child)) {
				decorated.add(child);
				const original = child.render;
				child.render = function (width: number) {
					const lines = original.call(this, width);
					const ms = clock.elapsed(messageKey(m), indices, now());
					if (ms === undefined || !lines.length) return lines;
					const label = durationLabel(ms);
					// Collapsed thinking already has a title; keep its click region and height.
					if (hidden) {
						return [timingRow(lines[0], label, width, dim), ...lines.slice(1)];
					}
					return [timingRow(dim(c.type === "thinking" ? " Thinking" : " Output"), label, width, dim), ...lines];
				};
			}
			if (c.type === "thinking" && m.content.slice(i + 1).some((v: any) => v.type === "text" && v.text?.trim() || v.type === "thinking" && v.thinking?.trim())) cursor++;
		}
	}
	return {
		update(root: unknown) {
			const pending: any[] = [root];
			const seen = new Set<any>();
			while (pending.length) {
				const node = pending.pop();
				if (!node || typeof node !== "object" || seen.has(node)) continue;
				seen.add(node);
				if (node.lastMessage?.role === "assistant" && typeof node.updateContent === "function" && node.contentContainer?.children) {
					if (!restores.has(node)) {
						const original = node.updateContent;
						const wrapped = function (this: any, ...args: any[]) { original.apply(this, args); decorate(this); };
						node.updateContent = wrapped;
						restores.set(node, () => { if (node.updateContent === wrapped) { node.updateContent = original; original.call(node, node.lastMessage); } });
					}
					decorate(node);
					continue;
				}
				if (typeof node.toolCallId === "string" && typeof node.updateResult === "function" && typeof node.render === "function") {
					if (!restores.has(node)) {
						const original = node.render;
						const wrapped = function (this: any, width: number) {
							const lines: string[] = [...original.call(this, width)];
							const span = clock.tools.get(this.toolCallId);
							const ms = !this.isPartial && this.result?.durationMs !== undefined ? this.result.durationMs
								: span ? span.duration ?? (span.end ?? now()) - span.start : undefined;
							const label = guardTimingLabel(clock.guards.get(this.toolCallId), ms, now());
							const row = lines.findIndex(line => stripTerminalSequences(line).trim());
							if (row >= 0 && ["read", "edit", "write"].includes(this.toolName)) {
								lines[row] = stripToolPathLinks(lines[row]);
							}
							if (label && row >= 0) lines[row] = timingRow(lines[row], label, width, dim,
								text => toolBackground(text, this));
							return lines;
						};
						node.render = wrapped;
						restores.set(node, () => { if (node.render === wrapped) node.render = original; });
					}
					continue;
				}
				if (typeof node.getMountedRoots === "function") pending.push(...node.getMountedRoots());
				else if (Array.isArray(node.children)) pending.push(...node.children);
				if (node.child) pending.push(node.child);
			}
			// Release detached nodes; a long session must not retain old render trees.
			for (const [node, restore] of restores) if (!seen.has(node)) { restore(); restores.delete(node); }
		},
		dispose() { for (const restore of restores.values()) restore(); restores.clear(); },
	};
}

export default function registerBlockTiming(pi: ExtensionAPI) {
	const clock = new BlockClock();
	let adapter: ReturnType<typeof blockTimingAdapter> | undefined;
	let root: any;
	let timer: ReturnType<typeof setInterval> | undefined;
	const redraw = () => { if (root) { adapter?.update(root); root.requestRender(); } };
	const stop = () => { if (timer) clearInterval(timer); timer = undefined; };
	const unsubscribeGuard = pi.events.on(GUARD_ENTRY, (data) => {
		const guard = data as GuardTiming;
		if (!guard || typeof guard.toolCallId !== "string") return;
		clock.guards.set(guard.toolCallId, { ...guard });
		// Pi emits tool_execution_start *before* tool_call guards. Restart the
		// live execution estimate after approval; native final duration wins.
		if (guard.status === "passed") {
			const span = clock.tools.get(guard.toolCallId);
			if (span) span.start = performance.now();
		}
		redraw();
	});
	const restore = (_event: unknown, ctx: ExtensionContext) => {
		stop(); adapter?.dispose(); clock.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom") continue;
			if (entry.customType === GUARD_ENTRY) {
				const guard = entry.data as GuardTiming;
				if (guard && typeof guard.toolCallId === "string") clock.guards.set(guard.toolCallId, guard);
				continue;
			}
			if (entry.customType !== ENTRY) continue;
			const data = entry.data as { key?: string; blocks?: [number, Span][] };
			if (typeof data?.key === "string" && Array.isArray(data.blocks)) clock.messages.set(data.key, new Map(data.blocks));
		}
		redraw();
	};
	pi.on("session_start", restore);
	pi.on("session_switch", restore);
	pi.on("session_tree", restore);
	pi.on("agent_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		stop(); timer = setInterval(redraw, 1000); timer.unref();
	});
	pi.on("message_update", (event) => {
		if (event.message.role !== "assistant") return;
		const e = event.assistantMessageEvent;
		if ("contentIndex" in e) clock.update(messageKey(event.message), e.type, e.contentIndex, performance.now());
		redraw();
	});
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		const key = messageKey(event.message);
		clock.finish(key, performance.now());
		const blocks = clock.messages.get(key);
		if (blocks?.size) pi.appendEntry(ENTRY, { key, blocks: [...blocks] });
		redraw();
	});
	pi.on("tool_execution_start", (event) => { clock.tools.set(event.toolCallId, { start: performance.now() }); redraw(); });
	pi.on("tool_execution_end", (event) => {
		const span = clock.tools.get(event.toolCallId);
		if (span) { span.end = performance.now(); span.duration = event.durationMs; }
		redraw();
	});
	pi.on("agent_end", () => {
		const now = performance.now();
		for (const key of clock.messages.keys()) clock.finish(key, now);
		for (const span of clock.tools.values()) span.end ??= now;
		stop(); redraw();
	});
	pi.on("session_shutdown", () => { unsubscribeGuard(); stop(); adapter?.dispose(); adapter = undefined; root = undefined; clock.clear(); });
	return {
		mount(tui: unknown, ctx: ExtensionContext) {
			adapter?.dispose(); root = tui;
			adapter = blockTimingAdapter(clock, text => ctx.ui.theme.fg("dim", text), () => performance.now(),
				(text, node) => node.getRenderShell?.() === "self" ? text : ctx.ui.theme.bg(
					node.isPartial ? "toolPendingBg" : node.result?.isError ? "toolErrorBg" : "toolSuccessBg", text));
		},
		update() { if (root) adapter?.update(root); },
		dispose() { adapter?.dispose(); adapter = undefined; root = undefined; },
	};
}
