/** Static NAVI header and compact startup resource lists. No animation timers. */
import { type ExtensionAPI, VERSION, keyHint, keyText, rawKeyHint } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const LIST_SECTIONS = new Set(["[Extensions]", "[Skills]"]);
const NAVI_WORDMARK = [
	"  ███╗   ██╗ █████╗ ██╗   ██╗██╗",
	"  ████╗  ██║██╔══██╗██║   ██║██║",
	"  ██╔██╗ ██║███████║██║   ██║██║",
	"  ██║╚██╗██║██╔══██║╚██╗ ██╔╝██║",
	"  ██║ ╚████║██║  ██║ ╚████╔╝ ██║",
	"  ╚═╝  ╚═══╝╚═╝  ╚═╝  ╚═══╝ ╚═╝",
];
const WORDMARK_WIDTH = Math.max(...NAVI_WORDMARK.map(visibleWidth));

export function renderNaviWordmark(width: number, fg: (color: "accent" | "muted", text: string) => string, version = VERSION): string[] {
	const available = Math.max(0, width);
	const logo = available >= WORDMARK_WIDTH ? NAVI_WORDMARK : ["  NAVI"];
	return [...logo.map(line => fg("accent", line)), "", fg("muted", `  Hey Listen!  ·  π ${version}`)]
		.map(line => truncateToWidth(line, available, ""));
}

function compactListLabels(text: string): string[] | undefined {
	const lines = text.split("\n");
	if (lines.length !== 2 || !LIST_SECTIONS.has(stripTerminalSequences(lines[0]!).trim())) return;
	const body = stripTerminalSequences(lines[1]!);
	if (!body.startsWith("  ") || !body.trim() || body.trimStart().startsWith("- ")) return;
	return body.trim().split(", ").map(label => `- ${label}`);
}

/** Only compact resource lists; leave expanded paths and other text alone. */
export function extensionListText(text: string, dim: (text: string) => string, width = 80, sharedCellWidth = 0): string {
	const labels = compactListLabels(text);
	if (!labels) return text;
	const lines = text.split("\n");
	const available = Math.max(0, width - 2);
	const cellWidth = Math.max(sharedCellWidth, ...labels.map(visibleWidth));
	const gap = 3;
	const columns = Math.max(1, Math.min(4, Math.floor((available + gap) / (cellWidth + gap))));
	const rows: string[] = [];
	for (let i = 0; i < labels.length; i += columns) {
		const row = labels.slice(i, i + columns).map((label, column, cells) =>
			column === cells.length - 1 ? label : label + " ".repeat(cellWidth - visibleWidth(label) + gap),
		).join("");
		rows.push(dim(truncateToWidth(`  ${row}`, Math.max(0, width), "")));
	}
	return lines[0] + "\n" + rows.join("\n");
}

/** Adapt mounted ExpandableText instances only; never patch global prototypes. */
export function extensionListAdapter(dim: (text: string) => string) {
	type Node = {
		children?: unknown[]; child?: unknown; getMountedRoots?: () => unknown[];
		build?: () => string; state?: { expanded?: boolean }; setExpanded?: unknown; invalidate?: () => void;
	};
	const patched = new Map<Node, { original: () => string; wrapped: () => string }>();
	let width = 80;
	let sharedCellWidth = 0;
	const cellWidths = new Map<Node, number>();
	return {
		update(root: unknown, nextWidth = 80) {
			const previouslyPatched = new Set(patched.keys());
			const mounted = new Set<Node>();
			if (width !== nextWidth) {
				width = nextWidth;
				for (const node of patched.keys()) node.invalidate?.();
			}
			const pending = [root];
			const seen = new Set<unknown>();
			// Startup discovery is bounded; do not walk an unbounded transcript.
			for (let cursor = 0; cursor < pending.length && seen.size < 256; cursor++) {
				const value = pending[cursor];
				if (!value || typeof value !== "object" || seen.has(value)) continue;
				seen.add(value);
				const node = value as Node;
				if (typeof node.build === "function" && typeof node.setExpanded === "function"
					&& typeof node.invalidate === "function" && typeof node.state?.expanded === "boolean") {
					const text = (patched.get(node)?.original ?? node.build).call(node);
					mounted.add(node);
					if (!node.state.expanded) {
						const labels = compactListLabels(text);
						cellWidths.set(node, labels ? Math.max(...labels.map(visibleWidth)) : 0);
					}
					if (patched.has(node)) continue;
					if (typeof text === "string" && LIST_SECTIONS.has(stripTerminalSequences(text.split("\n")[0]!).trim())) {
						const original = node.build;
						const wrapped = () => {
							const text = original.call(node);
							return node.state?.expanded === false ? extensionListText(text, dim, width, sharedCellWidth) : text;
						};
						patched.set(node, { original, wrapped });
						node.build = wrapped;
						node.invalidate();
					}
				}
				if (typeof node.getMountedRoots === "function") pending.push(...node.getMountedRoots());
				else if (Array.isArray(node.children)) pending.push(...node.children);
				if (node.child) pending.push(node.child);
			}
			for (const node of cellWidths.keys()) if (!mounted.has(node)) cellWidths.delete(node);
			for (const [node, { original, wrapped }] of patched) {
				if (mounted.has(node)) continue;
				if (node.build === wrapped) { node.build = original; node.invalidate?.(); }
				patched.delete(node);
			}
			const nextCellWidth = Math.max(0, ...cellWidths.values());
			if (sharedCellWidth !== nextCellWidth) {
				sharedCellWidth = nextCellWidth;
				for (const node of previouslyPatched) node.invalidate?.();
			}
		},
		dispose() {
			for (const [node, { original, wrapped }] of patched) {
				if (node.build === wrapped) { node.build = original; node.invalidate?.(); }
			}
			patched.clear(); cellWidths.clear();
		},
	};
}

type BlockTiming = ReturnType<typeof import("./block-timing.js").default>;

export default function (pi: ExtensionAPI, timing?: BlockTiming) {
	let resourcesDirty = true;
	const markResourcesDirty = () => { resourcesDirty = true; };
	pi.on("session_start", markResourcesDirty);
	pi.on("session_switch", markResourcesDirty);
	pi.on("session_tree", markResourcesDirty);
	pi.on("session_compact", markResourcesDirty);
	pi.on("agent_end", markResourcesDirty);
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setHeader((tui) => {
			timing?.mount(tui, ctx);
			const lists = extensionListAdapter(text => ctx.ui.theme.fg("dim", text));
			let cached: { width: number; expanded: boolean; theme: unknown; lines: string[] } | undefined;
			// Resource nodes can be attached after the factory/first layout finishes.
			const startup = setTimeout(() => { resourcesDirty = true; tui.requestRender(); }, 0);
			startup.unref();
			return {
				render(width: number): string[] {
					timing?.update();
					const expanded = ctx.ui.getToolsExpanded();
					const theme = ctx.ui.theme;
					if (resourcesDirty || !cached || cached.width !== width || cached.expanded !== expanded) {
						resourcesDirty = false;
						lists.update(tui, width);
					}
					if (cached && cached.width === width && cached.expanded === expanded && cached.theme === theme) return cached.lines;
					const hint = (key: Parameters<typeof keyHint>[0], text: string) => keyHint(key, text);
					const sep = theme.fg("dim", " · ");
					const hints = expanded ? [
						hint("app.interrupt", "中断"), hint("app.clear", "清屏"),
						rawKeyHint(`${keyText("app.clear")} twice`, "退出"), hint("app.exit", "空输入时退出"),
						hint("app.suspend", "挂起"), hint("tui.editor.deleteToLineEnd", "删除至行尾"),
						hint("app.thinking.cycle", "切换思考级别"),
						rawKeyHint(`${keyText("app.model.cycleForward")}/${keyText("app.model.cycleBackward")}`, "切换模型"),
						hint("app.model.select", "选择模型"), hint("app.tools.expand", "展开工具信息"),
						hint("app.thinking.toggle", "展开思考内容"), hint("app.editor.external", "打开外部编辑器"),
						rawKeyHint("/", "打开命令"), rawKeyHint("!", "运行终端"), rawKeyHint("!!", "运行终端（不加入上下文）"),
						hint("app.message.followUp", "加入后续消息"), hint("app.message.dequeue", "编辑待发消息"),
						hint("app.clipboard.pasteImage", "粘贴图片"), rawKeyHint("拖入文件", "附加文件"),
					] : [
						[hint("app.interrupt", "中断"), rawKeyHint(`${keyText("app.clear")}/${keyText("app.exit")}`, "清屏/退出")].join(sep),
						[rawKeyHint("/", "命令"), rawKeyHint("!", "终端"), hint("app.tools.expand", "更多")].join(sep),
					];
					const fit = (line: string) => truncateToWidth(line, width, "", true);
					const lines = [...renderNaviWordmark(width, (color, text) => theme.fg(color, text)), "", ...hints.map(fit), "",
						fit(theme.fg("dim", `按 ${keyText("app.tools.expand")} 查看完整帮助与已加载资源。`)), "",
						fit(theme.fg("dim", "可以询问 Pi 的用法、功能与扩展方式。"))];
					cached = { width, expanded, theme, lines };
					return lines;
				},
				invalidate() { cached = undefined; },
				dispose() { clearTimeout(startup); lists.dispose(); timing?.dispose(); },
			};
		});
	});
}
