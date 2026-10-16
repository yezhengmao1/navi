/**
 * Stable Codex-style input box and footer for pi.
 *
 * Keeps the native editor behavior and keybindings while adding a simple
 * prompt and placeholder. Rendering intentionally stays static so terminals
 * never receive animation artifacts or pi internal cursor markers.
 */

import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import {
	getAgentDir,
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
	type SessionEntry,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	colorToRgb,
	rgbColor,
	truncateToWidth,
	wrapTextWithAnsi,
	visibleWidth,
	stripTerminalSequences,
	type AutocompleteProvider,
	type EditorTheme,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

import { staticMessageBackground, paintStaticMessage } from "./message-flow.js";
import { contextUsageCache } from "./context-usage.js";
import { UsageLedger, type UsageRecord } from "./usage-ledger.js";

const PLACEHOLDER = "输入消息…";
const PROMPT_WIDTH = 2;
const EDITOR_PADDING = 1;
const FOOTER_SEPARATOR = " · ";
const UPSTREAM_ENTRY = "pi.upstream-response";
const ID_HEADERS = new Set([
	"request-id", "x-request-id", "x-ms-request-id",
	"trace-id", "x-trace-id", "traceparent", "x-amzn-trace-id",
	"correlation-id", "x-correlation-id",
	"session-id", "x-session-id", "conversation-id", "x-conversation-id",
]);

export function upstreamIdHeaders(headers: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.entries(headers)
		.map(([key, value]) => [key.toLowerCase(), value] as const)
		.filter(([key, value]) => ID_HEADERS.has(key) && typeof value === "string" && value.length > 0));
}

/** Read the active branch, including old sessions which only have responseId. */
export function upstreamSessionInfo(entries: SessionEntry[]): string {
	const lines = ["上游信息（当前分支最近一次响应）"];
	let foundMessage = false;
	let foundResponse = false;
	let foundHeaders = false;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.type === "message") {
			const message = entry.message;
			if (message.role === "assistant") {
				if (foundMessage) break;
				foundMessage = true;
				lines.push(`模型: ${message.provider}/${message.model}`);
				if (message.responseId) {
					lines.push(`Response ID: ${message.responseId}`);
					foundResponse = true;
				}
			} else if (foundMessage && message.role === "user") break;
		}
		if (entry.type === "custom" && entry.customType === UPSTREAM_ENTRY) {
			const data = entry.data as { status?: number; headers?: Record<string, string> } | undefined;
			lines.push(`响应时间: ${entry.timestamp}`);
			if (typeof data?.status === "number") lines.push(`HTTP: ${data.status}`);
			for (const [name, value] of Object.entries(upstreamIdHeaders(data?.headers ?? {}))) {
				// Headers are untrusted terminal output; suppress control sequences.
				lines.push(`${name}: ${stripTerminalSequences(value).replace(/[\x00-\x1f\x7f]/g, "")}`);
				foundHeaders = true;
			}
			// A newer header entry may belong to an in-flight request. Never pair it
			// with the previous assistant response, or reuse headers from an older call.
			break;
		}
	}
	if (!foundResponse) lines.push("Response ID: 暂无记录");
	if (!foundHeaders) lines.push("上游请求 / 追踪 / 会话 ID: 未返回或尚未记录");
	return lines.join("\n");
}

/** Pi assigns the built-in submit handler after creating the custom editor. */
export function appendSessionInfoOnSubmit(
	editor: { onSubmit?: (text: string) => void },
	showInfo: () => void,
): void {
	let submit = editor.onSubmit;
	const wrap = (handler: typeof submit) => handler && (async (text: string) => {
		await handler(text);
		if (text.trim() === "/session") showInfo();
	});
	let wrapped = wrap(submit);
	Object.defineProperty(editor, "onSubmit", {
		configurable: true,
		get: () => wrapped,
		set: (handler: typeof submit) => { submit = handler; wrapped = wrap(submit); },
	});
}

function formatTokens(count: number): string {
	if (count < 10_000) return String(count);
	if (count < 100_000_000) return `${Number((count / 10_000).toFixed(1))}万`;
	return `${Number((count / 100_000_000).toFixed(2))}亿`;
}

/** Use the machine's local calendar day, matching pi's session timestamps. */
export function localDay(date: Date): string {
	return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function dailyUsage(records: any[], now = new Date()): number {
	const seen = new Set<string>();
	let total = 0;
	for (const entry of records) {
		const message = entry.message;
		if (entry.type !== "message" || message?.role !== "assistant") continue;
		const timestamp = message.timestamp ?? entry.timestamp;
		if (localDay(new Date(timestamp)) !== localDay(now)) continue;
		// Branching copies existing entries into another session file.
		const key = JSON.stringify([entry.id, timestamp, message.provider, message.model]);
		if (seen.has(key)) continue;
		seen.add(key);
		const usage = message.usage;
		if (!usage) continue;
		const count = usage.totalTokens ??
			((usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0));
		if (Number.isFinite(count) && count >= 0) total += count;
	}
	return total;
}

/** Necessary (not sufficient) condition for a complete JSONL session object.
 * Inspect only the tail; avoid concatenating/decoding a large unfinished record.
 */
export function mayBeCompleteObject(chunks: Buffer[]): boolean {
	for (let c = chunks.length - 1; c >= 0; c--) {
		for (let i = chunks[c]!.length - 1; i >= 0; i--) {
			const byte = chunks[c]![i];
			if (byte !== 32 && byte !== 9 && byte !== 10 && byte !== 13) return byte === 125;
		}
	}
	return false;
}

type UsageFile = {
	signature: string;
	identity: string;
	offset: number;
	pending: Buffer[];
	/** A valid final JSON record without a newline is provisional until appended. */
	tail?: UsageRecord;
};

/** Incremental, bounded reads; never perform filesystem I/O inside render(). */
export class DailyTokenCounter {
	private cache = new Map<string, UsageFile>();
	private day = "";
	private ledger = new UsageLedger();
	private discoveryKey = "";
	private discoveredAt = -Infinity;
	async read(roots: string[], now = new Date(), options: { discoveryIntervalMs?: number; activeFile?: string } = {}): Promise<number> {
		const day = localDay(now);
		if (day !== this.day) {
			this.cache.clear(); this.ledger.clear(); this.day = day; this.discoveredAt = -Infinity;
		}
		const key = JSON.stringify([...new Set(roots)].sort());
		const discover = key !== this.discoveryKey || now.getTime() < this.discoveredAt
			|| now.getTime() - this.discoveredAt >= (options.discoveryIntervalMs ?? 0);
		const files = new Set<string>();
		const visit = async (directory: string) => {
			let entries;
			try { entries = await readdir(directory, { withFileTypes: true }); }
			catch (error: any) { if (error.code === "ENOENT") return; throw error; }
			for (const entry of entries) {
				const path = join(directory, entry.name);
				if (entry.isDirectory()) await visit(path);
				else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.add(path);
			}
		};
		if (discover) for (const root of new Set(roots)) await visit(root);
		// Fast refreshes only stat/read the active session; other sessions are eventual.
		if (options.activeFile) files.add(options.activeFile);
		const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
		for (const path of files) {
			try {
				const info = await stat(path);
				if (info.mtimeMs < midnight.getTime()) {
					this.cache.delete(path); this.ledger.delete(path);
					continue;
				}
				const signatureOf = (s: typeof info) => `${s.dev}:${s.ino}:${s.mtimeMs}:${s.ctimeMs}:${s.size}`;
				const previous = this.cache.get(path);
				if (previous?.signature === signatureOf(info)) continue;
				const file = await open(path, "r");
				try {
					// Stat the opened file too: it may have been replaced since discovery.
					const snapshot = await file.stat();
					const identity = `${snapshot.dev}:${snapshot.ino}`;
					const append = previous?.identity === identity && snapshot.size > previous.offset;
					// Stage only new usage records. Commit after all reads succeed, without
					// copying historical usage for tool-output-only appends.
					const records: UsageRecord[] = [];
					let offset = append ? previous.offset : 0;
					let pending = append ? [...previous.pending] : [];
					const consume = (line: Buffer) => {
						try {
							const entry = JSON.parse(line.toString("utf8"));
							if (entry.type !== "message" || entry.message?.role !== "assistant") return;
							const { timestamp, provider, model, usage } = entry.message;
							if (localDay(new Date(timestamp ?? entry.timestamp)) !== day) return;
							// Normalize once at ingestion, not on every later global aggregation.
							const key = JSON.stringify([entry.id, timestamp ?? entry.timestamp, provider, model]);
							const count = usage?.totalTokens ?? ((usage?.input ?? 0) + (usage?.output ?? 0)
								+ (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0));
							records.push({ key, count: Number.isFinite(count) && count >= 0 ? count : 0 });
						} catch { /* Ignore malformed complete lines; retain incomplete lines below. */ }
					};
					while (offset < snapshot.size) {
						// Yield between chunks, and avoid decoding split UTF-8 characters.
						const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, snapshot.size - offset));
						const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
						if (!bytesRead) throw new Error("Session file truncated during usage scan");
						offset += bytesRead;
						let start = 0;
						for (let end = buffer.indexOf(10); end >= 0 && end < bytesRead; end = buffer.indexOf(10, start)) {
							const part = buffer.subarray(start, end);
							consume(pending.length ? Buffer.concat([...pending, part]) : part);
							pending = [];
							start = end + 1;
						}
						if (start < bytesRead) pending.push(Buffer.from(buffer.subarray(start, bytesRead)));
					}
					const completeCount = records.length;
					if (mayBeCompleteObject(pending)) consume(Buffer.concat(pending));
					const tail = records[completeCount];
					if (append) this.ledger.append(path, records, previous.tail);
					else this.ledger.replace(path, records);
					this.cache.set(path, { signature: signatureOf(snapshot), identity, offset, pending, tail });
				} finally { await file.close(); }
			} catch (error: any) {
				if (error.code === "ENOENT") { this.cache.delete(path); this.ledger.delete(path); }
				else throw error;
			}
		}
		if (discover) {
			for (const path of this.cache.keys()) if (!files.has(path)) { this.cache.delete(path); this.ledger.delete(path); }
			this.discoveryKey = key;
			this.discoveredAt = now.getTime();
		}
		return this.ledger.total;
	}
}

export function outputSpeed(output: number | undefined, elapsedMs: number): number | undefined {
	return typeof output === "number" && Number.isFinite(output) && output > 0 && elapsedMs > 0
		? output * 1000 / elapsedMs : undefined;
}

/** Warm red → gold → pale gold; callers can supply the active theme's colors. */
export function speedColor(
	speed: number,
	stops: [number, number, number][] = [[217, 109, 90], [220, 180, 122], [240, 210, 163]],
): [number, number, number] {
	const position = Math.max(0, Math.min(150, speed)) / 75;
	const segment = Math.min(1, Math.floor(position));
	const fraction = position - segment;
	return stops[segment]!.map((channel, index) =>
		Math.round(channel + (stops[segment + 1]![index]! - channel) * fraction),
	) as [number, number, number];
}

function colorSpeed(text: string, speed: number, theme: Theme): string {
	const stops = [theme.colors.accent, theme.colors.warning, theme.colors.thinkingText]
		.map(color => {
			const { r, g, b } = colorToRgb(color);
			return [r, g, b] as [number, number, number];
		});
	// Let pi handle truecolor / 256-color conversion and active-theme changes.
	return theme.style(text, { fg: rgbColor(...speedColor(speed, stops)) });
}

/** Shared selection-card contract, requested synchronously through pi.events. */
export interface MagicSelectionCard {
	width: number;
	theme: Theme;
	title: string;
	subtitle?: string;
	items: { label: string; checked?: boolean; group?: string; primary?: boolean }[];
	cursor: number;
	hints: string[];
	/** Pre-rendered searchable content, kept inside the shared card frame. */
	bodyLines?: string[];
	warning?: string;
	lines?: string[];
}

export function renderSelectionCard(card: MagicSelectionCard): string[] {
	const { theme, items, cursor } = card;
	const width = Math.max(0, Math.floor(card.width));
	if (width === 0) return [];
	const framed = width >= 6;
	const bodyWidth = framed ? width - 4 : width;
	const border = (text: string) => theme.fg("border", text);
	const row = (text = "", selected = false) => {
		let body = truncateToWidth(text, bodyWidth, "…", true);
		if (selected) body = theme.bg("selectedBg", body);
		return framed ? border("│") + " " + body + " " + border("│") : body;
	};
	const rule = () => border("├" + "─".repeat(width - 2) + "┤");
	const lines: string[] = [];
	if (framed) lines.push(border("┌" + "─".repeat(width - 2) + "┐"));
	lines.push(row(theme.fg("accent", theme.bold(card.title))));
	if (card.subtitle) lines.push(row(theme.fg("muted", card.subtitle)));
	if (framed) lines.push(rule());
	if (card.bodyLines) lines.push(...card.bodyLines.map(line => row(line)));
	items.forEach((item, index) => {
		if (item.group) {
			if (index) lines.push(row());
			lines.push(row(theme.fg("muted", item.group)));
		}
		const active = index === cursor;
		const marker = active ? theme.fg("accent", "› ") : "  ";
		const checkbox = item.checked === undefined ? "" :
			theme.fg(item.checked ? "success" : "dim", item.checked ? "[✓] " : "[ ] ");
		const label = theme.fg(active || item.primary ? "accent" : "text", item.label);
		lines.push(row(marker + checkbox + (item.primary ? theme.bold(label) : label), active));
	});
	if (framed) lines.push(rule());
	if (card.warning) {
		for (const line of wrapTextWithAnsi(theme.fg("warning", card.warning), bodyWidth)) lines.push(row(line));
	}
	for (const hint of card.hints) {
		for (const line of wrapTextWithAnsi(theme.fg("muted", hint), bodyWidth)) lines.push(row(line));
	}
	if (framed) lines.push(border("└" + "─".repeat(width - 2) + "┘"));
	return lines;
}

export default function (pi: ExtensionAPI) {
	// Opt-in renderer: other extensions keep ownership of input and selection state.
	const unsubscribeCard = pi.events.on("magic-ui:selection-card", (data) => {
		const card = data as MagicSelectionCard;
		card.lines = renderSelectionCard(card);
	});
	pi.on("session_shutdown", () => unsubscribeCard());
	let workingPhase: string | undefined;
	let phaseTimer: ReturnType<typeof setInterval> | undefined;
	const runningTools = new Set<string>();
	let responseStart: number | undefined;
	let speed: number | undefined;
	let refreshUsage: (() => void) | undefined;
	let refreshContext: ((ctx: ExtensionContext) => void) | undefined;
	// Include context edits/loadout changes before requests and non-assistant messages.
	const invalidateContext = (_event: unknown, ctx: ExtensionContext) => refreshContext?.(ctx);
	pi.on("session_switch", invalidateContext);
	pi.on("session_tree", invalidateContext);
	pi.on("session_compact", invalidateContext);
	pi.on("model_select", invalidateContext);
	pi.on("message_start", invalidateContext);
	pi.on("message_end", invalidateContext);
	pi.on("agent_end", invalidateContext);
	pi.on("before_provider_request", invalidateContext);
	pi.on("before_provider_request", () => { responseStart = performance.now(); });
	pi.on("message_start", (event) => {
		if (event.message.role === "assistant") responseStart ??= performance.now();
	});
	const setPhase = (ctx: ExtensionContext, phase?: string) => {
		if (workingPhase === phase) return;
		if (phaseTimer) clearInterval(phaseTimer);
		phaseTimer = undefined;
		workingPhase = phase;
		if (!ctx.hasUI) return;
		if (!phase) { ctx.ui.setWorkingMessage(); return; }
		const started = performance.now();
		const update = () => {
			const seconds = Math.floor((performance.now() - started) / 1000);
			const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
			ctx.ui.setWorkingMessage(`${phase}${FOOTER_SEPARATOR}${elapsed}`);
		};
		update();
		phaseTimer = setInterval(update, 1000);
		phaseTimer.unref();
	};
	pi.on("agent_start", (_event, ctx) => setPhase(ctx, "Working"));
	pi.on("message_update", (event, ctx) => {
		const type = event.assistantMessageEvent.type;
		if (type === "thinking_start" || type === "thinking_delta") setPhase(ctx, "Thinking");
		else if (type === "text_start" || type === "text_delta") setPhase(ctx, "Responding");
		else if (type === "toolcall_start" || type === "toolcall_delta") setPhase(ctx, "Preparing tool");
	});
	pi.on("message_end", (event, ctx) => {
		if (event.message.role === "assistant") {
			speed = responseStart === undefined ? undefined
				: outputSpeed(event.message.usage?.output, performance.now() - responseStart);
			responseStart = undefined;
			setPhase(ctx, "Working");
			// Allow pi to persist the message before reading session files.
			setTimeout(() => refreshUsage?.(), 0).unref();
		}
	});
	pi.on("tool_execution_start", (event, ctx) => {
		runningTools.add(event.toolCallId);
		setPhase(ctx, "Running tools");
	});
	pi.on("tool_execution_end", (event, ctx) => {
		runningTools.delete(event.toolCallId);
		if (runningTools.size === 0) setPhase(ctx, "Working");
	});
	const resetPhase = (ctx: ExtensionContext) => {
		runningTools.clear();
		setPhase(ctx);
	};
	pi.on("agent_end", (_event, ctx) => resetPhase(ctx));
	pi.on("session_switch", (_event, ctx) => resetPhase(ctx));
	pi.on("session_shutdown", (_event, ctx) => resetPhase(ctx));

	pi.on("after_provider_response", (event) => {
		pi.appendEntry(UPSTREAM_ENTRY, {
			status: event.status,
			headers: upstreamIdHeaders(event.headers),
		});
	});

	pi.on("session_start", (_event, ctx) => {
		resetPhase(ctx);
		if (ctx.mode !== "tui") return;
		class MagicEditor extends CustomEditor {
			private renderedContentHeight = 0;

			setAutocompleteProvider(provider: AutocompleteProvider) {
				const event = { ctx, provider };
				pi.events.emit("magic-ui:session-completion", event);
				super.setAutocompleteProvider(event.provider);
			}

			handleInput(data: string) {
				super.handleInput(data);
				// Older running Pi editors ignore provider.triggerCharacters even after
				// /reload. Request the normal (not force/Tab) picker after inserting $.
				if (data === "$") {
					const { line, col } = this.getCursor();
					if (/(?:^|\s)\$$/.test((this.getText().split("\n")[line] ?? "").slice(0, col))) {
						(this as unknown as { tryTriggerAutocomplete(): void }).tryTriggerAutocomplete();
					}
				}
			}

			constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
				super(tui, theme, keybindings, { paddingX: EDITOR_PADDING });
			}

			render(width: number): string[] {
				this.renderedContentHeight = 0;
				if (width < 6) return super.render(width);

				// Keep one blank gutter on each side, without vertical borders.
				// Preserve wrapping and mouse coordinates within those gutters.
				const innerWidth = width - 2;
				// Keep CURSOR_MARKER in the native output. It has zero display width,
				// but the TUI needs it to position the terminal cursor for IME input.
				// Removing it makes composed text briefly appear and then disappear in
				// terminals that report pre-edit updates relative to that cursor.
				const lines = super.render(innerWidth);
				if (lines.length < 3) return lines;

				const bottomIndex = lines.findIndex((line, index) => {
					if (index === 0) return false;
					const plain = stripTerminalSequences(line);
					return plain.includes("─") && /^[─ ↑↓0-9a-z]+$/i.test(plain);
				});
				if (bottomIndex < 2) return lines;

				const theme = ctx.ui.theme;
				const prompt = theme.fg("accent", ">") + " ";
				const continuation = " ".repeat(PROMPT_WIDTH);
				const nativePadding = " ".repeat(EDITOR_PADDING);
				const contentLines = lines.slice(1, bottomIndex);

				for (let index = 0; index < contentLines.length; index++) {
					if (index === 0 && this.getText().length === 0) {
						const cursor = this.focused
							? CURSOR_MARKER + "\x1b[7m \x1b[27m"
							: "";
						contentLines[index] = truncateToWidth(
							prompt + cursor + theme.fg("dim", PLACEHOLDER),
							innerWidth,
							"",
							true,
						);
						continue;
					}

					const nativeLine = contentLines[index]!;
					// The native editor always emits its configured left padding. Replace
					// that single cell with the two-cell prompt/continuation prefix.
					const body = nativeLine.startsWith(nativePadding)
						? nativeLine.slice(EDITOR_PADDING)
						: nativeLine;
					const prefix = index === 0 ? prompt : continuation;
					contentLines[index] = truncateToWidth(prefix + body, innerWidth, "", true);
				}

				// A borderless color block with one background-only row above and below.
				const background = staticMessageBackground(theme);
				const pad = (line: string) => paintStaticMessage(
					" " + truncateToWidth(line, innerWidth, "", true) + " ", background);
				const autocomplete = lines
					.slice(bottomIndex + 1)
					.map((line) => " " + truncateToWidth(line, innerWidth, "", true) + " ");

				this.renderedContentHeight = contentLines.length;
				return ["", pad(""), ...contentLines.map(line => pad(line)),
					pad(""), "", ...autocomplete];
			}

			handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
				if (!this.renderedContentHeight) return super.handleMouse(event);
				const bottomGap = this.renderedContentHeight + 3;
				if (event.y === 0 || event.y === bottomGap) return undefined;
				return super.handleMouse({
					...event,
					// Remove exterior spacing from native editor/completion coordinates.
					y: event.y - (event.y > bottomGap ? 2 : 1),
					x: Math.max(0, event.x - 1),
					width: Math.max(1, event.width - 2),
				});
			}
		}

		ctx.ui.setEditorComponent(
			(tui, theme, keybindings) => {
				const editor = new MagicEditor(tui, theme, keybindings);
				appendSessionInfoOnSubmit(editor, () => {
					ctx.ui.notify(upstreamSessionInfo(ctx.sessionManager.getBranch()), "info");
				});
				return editor;
			},
		);

		ctx.ui.setFooter((tui, theme, _footerData) => {
			const counter = new DailyTokenCounter();
			const context = contextUsageCache(() => tui.requestRender());
			refreshContext = context.invalidate;
			context.invalidate(ctx);
			let today: number | undefined;
			let busy = false;
			let disposed = false;
			let subagentLines: string[] | undefined;
			const unsubscribeSubagents = pi.events.on("magic-ui:subagent-status", (data) => {
				const event = data as { lines?: string[]; handled: boolean };
				subagentLines = event.lines;
				event.handled = true;
				tui.requestRender();
			});
			const refresh = async () => {
				if (busy || disposed) return;
				busy = true;
				let next: number | undefined;
				try {
					next = await counter.read([join(getAgentDir(), "sessions"), ctx.sessionManager.getSessionDir()], new Date(), {
						discoveryIntervalMs: 60_000,
						activeFile: ctx.sessionManager.getSessionFile?.(),
					});
				} catch { next = undefined; }
				finally { busy = false; }
				if (!disposed && next !== today) {
					today = next;
					tui.requestRender();
				}
			};
			refreshUsage = refresh;
			void refresh();
			// Safety refresh also covers changes without a dedicated UI lifecycle event.
			const timer = setInterval(() => { void refresh(); context.invalidate(ctx); }, 15_000);
			timer.unref();
			ctx.ui.setWidget("magic-stats", (_tui, widgetTheme) => ({
				invalidate() {},
				render(width: number): string[] {
					const usage = context.get();
					const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const percent = usage?.percent == null ? "?" : `${usage.percent.toFixed(1)}%`;
					const contextColor = (usage?.percent ?? 0) > 90 ? "error"
						: (usage?.percent ?? 0) > 70 ? "warning" : "muted";
					const speedLabel = `速度 ${speed === undefined ? "—" : speed.toFixed(1)} 词元/秒`;
					const items = [
						widgetTheme.fg(contextColor, `上下文 ${percent}/${formatTokens(window)}（自动压缩）`),
						widgetTheme.fg(today === undefined ? "dim" : "accent", `今日 ${today === undefined ? "—" : formatTokens(today)} 词元`),
						speed === undefined ? widgetTheme.fg("dim", speedLabel) : colorSpeed(speedLabel, speed, widgetTheme),
					];
					const quota = _footerData.getExtensionStatuses().get("codex-quota");
					if (quota) items.push(widgetTheme.fg("accent", quota));
					const statusLines: string[] = [];
					if (subagentLines?.length) {
						statusLines.push(truncateToWidth(widgetTheme.fg("accent", widgetTheme.bold(subagentLines[0])), width));
						const rows = subagentLines.slice(1);
						const boxWidth = Math.min(width, Math.max(0, ...rows.map(line => visibleWidth(line))) + 4);
						const innerWidth = Math.max(0, boxWidth - 4);
						const border = (text: string) => widgetTheme.fg("dim", text);
						if (boxWidth >= 6) statusLines.push(border(`┌${"─".repeat(boxWidth - 2)}┐`));
						for (const line of rows) {
							const color = line.startsWith("[+]") ? "success"
								: line.startsWith("[!]") ? "error" : line.startsWith("[>]") ? "accent" : "muted";
							const text = truncateToWidth(line, boxWidth >= 6 ? innerWidth : Math.max(0, width));
							const styled = widgetTheme.fg(color, text);
							statusLines.push(boxWidth >= 6
								? border("│ ") + styled + " ".repeat(innerWidth - visibleWidth(text)) + border(" │")
								: styled);
						}
						if (boxWidth >= 6) statusLines.push(border(`└${"─".repeat(boxWidth - 2)}┘`));
					}
					return [...statusLines, ...(statusLines.length ? [""] : []),
						...wrapTextWithAnsi(items.join(widgetTheme.fg("dim", FOOTER_SEPARATOR)), Math.max(1, width))];
				},
			}), { placement: "aboveEditor" });
			return {
				dispose() {
					disposed = true;
					context.dispose();
					if (refreshContext === context.invalidate) refreshContext = undefined;
					unsubscribeSubagents();
					clearInterval(timer);
					if (refreshUsage === refresh) refreshUsage = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					const thinkingLevel = pi.getThinkingLevel();
					const thinkingNames: Record<string, string> = {
						off: "关闭", minimal: "最低", low: "低", medium: "中",
						high: "高", xhigh: "极高", max: "最高",
					};
					const modelLabel = (ctx.model?.id ?? "未选模型") + (ctx.model?.reasoning
						? `（思考：${thinkingNames[thinkingLevel] ?? thinkingLevel}）` : "");
					const directoryLabel = ctx.cwd;
					const fixedWidth = visibleWidth(modelLabel) + visibleWidth(FOOTER_SEPARATOR);
					const directoryWidth = Math.max(0, width - fixedWidth);
					const directory =
						directoryWidth > 0
							? truncateToWidth(directoryLabel, directoryWidth, "…")
							: "";

					const model = theme.fg("text", modelLabel);
					const cwd = theme.fg("muted", directory);
					const gap = Math.max(1, width - visibleWidth(directory) - visibleWidth(modelLabel));
					const line = directory ? cwd + " ".repeat(gap) + model : model;
					return [truncateToWidth(line, width, "")];
				},
			};
		});
	});
}
