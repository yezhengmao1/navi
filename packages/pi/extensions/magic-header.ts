/**
 * Magic Header
 *
 * Replaces pi's built-in startup header with a theme-integrated version.
 *
 * Under the `magic` theme the header is rendered as an animated Matrix-style
 * "digital rain": faint katakana/digit columns fall through the header block
 * while a bright cascade sweeps across the `pi` logo. Colors are pulled live
 * from `ctx.ui.theme` (the green token drives the rain), so switching themes
 * re-themes the header on the next render. Any non-`magic` theme falls back to
 * the original soft, theme-integrated palette.
 *
 * Animation is driven by a `setInterval` loop that calls `tui.requestRender()`,
 * mirroring the built-in working indicator. The timer is torn down in
 * `dispose()` so the header never leaks a background loop.
 */

import {
	type ExtensionAPI,
	type ExtensionContext,
	VERSION,
	keyHint,
	keyText,
	rawKeyHint,
} from "@earendil-works/pi-coding-agent";
import {
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

// Glyphs used for the falling rain. Half-width katakana + digits give the
// classic "code stream" look without relying on wide (double-cell) characters.
const RAIN_GLYPHS =
	"ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉ0123456789ABCDEFZ$#*+=<>";

// Timing / density tuned for an ambient, low-CPU background effect.
const FRAME_INTERVAL_MS = 90;
const MAX_COLUMNS = 26;
const MIN_WIDTH = 40;

const pick = (glyphs: string) => glyphs[(Math.random() * glyphs.length) | 0]!;

interface RainColumn {
	x: number;
	head: number;
	speed: number;
	length: number;
}

function themeName(theme: { name?: string }): string {
	return theme.name ?? "";
}

const LIST_SECTIONS = new Set(["[Extensions]", "[Skills]"]);

/** Only compact resource lists; leave expanded paths and other text alone. */
export function extensionListText(text: string, dim: (text: string) => string): string {
	const lines = text.split("\n");
	if (lines.length !== 2 || !LIST_SECTIONS.has(stripTerminalSequences(lines[0]!).trim())) return text;
	const body = stripTerminalSequences(lines[1]!);
	if (!body.startsWith("  ") || !body.trim() || body.trimStart().startsWith("- ")) return text;
	return lines[0] + "\n" + body.trim().split(", ").map(label => dim(`  - ${label}`)).join("\n");
}

/**
 * Pi 1.1 has no public startup-resource renderer hook. Adapt only the matching
 * ExpandableText instances in memory, not package files or global prototypes.
 * Guard the internal shape and restore it when this header is disposed.
 */
export function extensionListAdapter(dim: (text: string) => string) {
	type Node = {
		children?: unknown[];
		child?: unknown;
		getMountedRoots?: () => unknown[];
		build?: () => string;
		state?: { expanded?: boolean };
		setExpanded?: unknown;
		invalidate?: () => void;
	};
	const patched = new Map<Node, { original: () => string; wrapped: () => string }>();
	return {
		update(root: unknown) {
			const pending = [root];
			const seen = new Set<unknown>();
			// Do not walk an unbounded transcript or follow arbitrary object fields.
			while (pending.length && seen.size < 256) {
				const value = pending.shift();
				if (!value || typeof value !== "object" || seen.has(value)) continue;
				seen.add(value);
				const node = value as Node;
				if (typeof node.build === "function" && typeof node.setExpanded === "function"
					&& typeof node.invalidate === "function" && typeof node.state?.expanded === "boolean") {
					if (patched.has(node)) continue;
					const text = node.build();
					if (typeof text === "string" && LIST_SECTIONS.has(stripTerminalSequences(text.split("\n")[0]!).trim())) {
						const original = node.build;
						const wrapped = () => {
							const text = original.call(node);
							return node.state?.expanded === false ? extensionListText(text, dim) : text;
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
		},
		dispose() {
			for (const [node, { original, wrapped }] of patched) {
				if (node.build === wrapped) {
					node.build = original;
					node.invalidate?.();
				}
			}
			patched.clear();
		},
	};
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		// Only the interactive TUI renders a header.
		if (ctx.mode !== "tui") return;

		// Keep the header static: slicing styled ANSI strings by character index can
		// corrupt escape sequences and make the rendered width exceed the terminal.
		renderSoftHeader(ctx);
	});
}

/**
 * Original theme-integrated header: soft palette, no bold, no bright accent.
 */
function renderSoftHeader(ctx: ExtensionContext) {
	ctx.ui.setHeader((tui, theme) => {
		const extensionList = extensionListAdapter(text => ctx.ui.theme.fg("dim", text));
		const logo =
			theme.fg("borderAccent", "╭── ") +
			theme.fg("warning", "终端") +
			theme.fg("borderAccent", " ──╮") +
			"\n" +
			theme.fg("borderAccent", "╰─ ") +
			theme.fg("text", "π") +
			theme.fg("muted", ` 版本 ${VERSION} · 已就绪`);
		const hint = (keybinding: Parameters<typeof keyHint>[0], description: string) =>
			keyHint(keybinding, description);
		const sep = theme.fg("dim", " · ");
		const onboarding = theme.fg(
			"dim",
			`按 ${keyText("app.tools.expand")} 查看完整帮助与已加载资源。`,
		);
		const tagline = theme.fg(
			"dim",
			"可以询问 Pi 的用法、功能与扩展方式。",
		);

		const compact =
			logo +
			"\n" +
			[
				hint("app.interrupt", "中断"),
				rawKeyHint(`${keyText("app.clear")}/${keyText("app.exit")}`, "清屏/退出"),
				rawKeyHint("/", "命令"),
				rawKeyHint("!", "终端"),
				hint("app.tools.expand", "更多"),
			].join(sep);

		const expanded =
			logo +
			"\n" +
			[
				hint("app.interrupt", "中断"),
				hint("app.clear", "清屏"),
				rawKeyHint(`${keyText("app.clear")} twice`, "退出"),
				hint("app.exit", "空输入时退出"),
				hint("app.suspend", "挂起"),
				hint("tui.editor.deleteToLineEnd", "删除至行尾"),
				hint("app.thinking.cycle", "切换思考级别"),
				rawKeyHint(`${keyText("app.model.cycleForward")}/${keyText("app.model.cycleBackward")}`, "切换模型"),
				hint("app.model.select", "选择模型"),
				hint("app.tools.expand", "展开工具信息"),
				hint("app.thinking.toggle", "展开思考内容"),
				hint("app.editor.external", "打开外部编辑器"),
				rawKeyHint("/", "打开命令"),
				rawKeyHint("!", "运行终端"),
				rawKeyHint("!!", "运行终端（不加入上下文）"),
				hint("app.message.followUp", "加入后续消息"),
				hint("app.message.dequeue", "编辑待发消息"),
				hint("app.clipboard.pasteImage", "粘贴图片"),
				rawKeyHint("拖入文件", "附加文件"),
			].join("\n");

		const body = () => (ctx.ui.getToolsExpanded() ? expanded : compact);
		const fitLines = (value: string, width: number) =>
			value.split("\n").map((line) => truncateToWidth(line, width, "", true));

		return {
			render(width: number): string[] {
				extensionList.update(tui);
				return [
					...fitLines(body(), width),
					"",
					...fitLines(onboarding, width),
					"",
					...fitLines(tagline, width),
				];
			},
			invalidate() {},
			dispose() { extensionList.dispose(); },
		};
	});
}

/**
 * Matrix-style animated header: digital rain + cascading logo glow.
 */
function renderMatrixHeader(ctx: ExtensionContext) {
	ctx.ui.setHeader((tui: any, theme: any) => {
		// Green drives the effect. Prefer the theme's `green` token; fall back to
		// a literal Matrix green so the effect still reads on stripped themes.
		const greenToken = "accent" as const;
		const base = (text: string) => theme.fg(greenToken, text);
		const dim = (text: string) => theme.fg("dim", text);
		const muted = (text: string) => theme.fg("muted", text);
		const bright = (text: string) => theme.bold(theme.fg(greenToken, text));
		// The leading "head" of each rain streak / the logo cascade uses the
		// theme's default text color (near-white) bolded, for that hot core.
		const head = (text: string) => theme.bold(theme.fg("text", text));

		const logoPlain = `pi v${VERSION}`;
		const hint = (keybinding: Parameters<typeof keyHint>[0], description: string) =>
			keyHint(keybinding, description);
		const sep = dim(" · ");
		const onboarding = dim(
			`按 ${keyText("app.tools.expand")} 查看完整帮助与已加载资源。`,
		);
		const tagline = dim(
			"可以询问 Pi 的用法、功能与扩展方式。",
		);

		const buildHints = (expanded: boolean) =>
			expanded
				? [
						hint("app.interrupt", "中断"),
						hint("app.clear", "清屏"),
						rawKeyHint(`${keyText("app.clear")} twice`, "退出"),
						hint("app.exit", "空输入时退出"),
						hint("app.suspend", "挂起"),
						hint("tui.editor.deleteToLineEnd", "删除至行尾"),
						hint("app.thinking.cycle", "切换思考级别"),
						rawKeyHint(`${keyText("app.model.cycleForward")}/${keyText("app.model.cycleBackward")}`, "切换模型"),
						hint("app.model.select", "选择模型"),
						hint("app.tools.expand", "展开工具信息"),
						hint("app.thinking.toggle", "展开思考内容"),
						hint("app.editor.external", "打开外部编辑器"),
						rawKeyHint("/", "打开命令"),
						rawKeyHint("!", "运行终端"),
						rawKeyHint("!!", "运行终端（不加入上下文）"),
						hint("app.message.followUp", "加入后续消息"),
						hint("app.message.dequeue", "编辑待发消息"),
						hint("app.clipboard.pasteImage", "粘贴图片"),
						rawKeyHint("拖入文件", "附加文件"),
					].join("\n")
				: [
						hint("app.interrupt", "中断"),
						rawKeyHint(`${keyText("app.clear")}/${keyText("app.exit")}`, "清屏/退出"),
						rawKeyHint("/", "命令"),
						rawKeyHint("!", "终端"),
						hint("app.tools.expand", "更多"),
					].join(sep);

		const logoLine = (expanded: boolean) =>
			bright("pi") + dim(` v${VERSION}`) + (expanded ? "" : "");

		let columns: RainColumn[] = [];
		let colsForWidth = 0;

		const ensureColumns = (width: number) => {
			const target = Math.max(0, Math.min(MAX_COLUMNS, Math.floor(width / 6)));
			if (target === colsForWidth && columns.length) return;
			colsForWidth = target;
			columns = [];
			for (let i = 0; i < target; i++) {
				columns.push(spawnColumn(width, true));
			}
		};

		const spawnColumn = (width: number, randomHead: boolean): RainColumn => {
			const speed = 1 + Math.floor(Math.random() * 2); // cells per frame
			const length = 4 + Math.floor(Math.random() * 6);
			return {
				x: Math.floor(Math.random() * width),
				head: randomHead ? Math.floor(Math.random() * 40) : -length - Math.random() * 10,
				speed,
				length,
			};
		};

		const step = (width: number, height: number) => {
			for (let i = 0; i < columns.length; i++) {
				const col = columns[i]!;
				col.head += col.speed;
				if (col.head - col.length > height) {
					columns[i] = spawnColumn(width, false);
				}
			}
		};

		// Build the per-line mask of cells that must stay clear of rain so text
		// stays readable. Returns, for each line, the set of reserved columns.
		const buildMasks = (lines: string[], width: number, expanded: boolean) => {
			const contentWidths = lines.map((line) =>
				Math.min(width, visibleWidth(stripTerminalSequences(line))),
			);
			const logoCols = visibleWidth(logoPlain) + 2; // "pi" + " v0.87.0" + padding
			const cascadeCols = expanded ? 0 : logoCols;
			return { contentWidths, cascadeCols };
		};

		const stamp = (line: string, col: number, text: string): string => {
			if (col < 0 || col >= line.length) return line;
			const before = line.slice(0, col);
			const after = line.slice(col + visibleWidth(text));
			return before + text + after;
		};

		const renderRain = (
			lines: string[],
			width: number,
			expanded: boolean,
			frame: number,
		): string[] => {
			const out = lines.map((line) => truncateToWidth(line, width, "", true).padEnd(width, " "));
			const height = out.length;
			const { contentWidths, cascadeCols } = buildMasks(lines, width, expanded);

			// Reserve content cells on every line, plus the logo cascade band on
			// the logo line (line 0) so rain never overwrites the cascade.
			const reserved = out.map((_, y) => {
				const mask = new Uint8Array(width);
				const content = contentWidths[y] ?? 0;
				for (let x = 0; x < content; x++) mask[x] = 1;
				if (y === 0) {
					for (let x = 0; x < cascadeCols; x++) mask[x] = 1;
				}
				return mask;
			});

			for (const col of columns) {
				const x = col.x;
				if (x < 0 || x >= width) continue;
				for (let k = 0; k < col.length; k++) {
					const y = col.head - k;
					if (y < 0 || y >= height) continue;
					const mask = reserved[y]!;
					if (mask[x]) continue;
					let styled: string;
					if (k === 0) styled = head(pick(RAIN_GLYPHS));
					else if (k < 3) styled = bright(pick(RAIN_GLYPHS));
					else if (k < col.length >> 1) styled = base(pick(RAIN_GLYPHS));
					else styled = dim(pick(RAIN_GLYPHS));
					out[y] = stamp(out[y]!, x, styled);
					mask[x] = 1; // one glyph per cell
				}
			}

			return out;
		};

		// Composite the cascading glow onto the logo characters (line 0).
		const applyCascade = (line: string, frame: number): string => {
			const chars = [...logoPlain];
			const n = chars.length;
			// A bright head sweeps left→right, leaving a short fading trail.
			const headPos = (frame * 2) % (n + 8) - 4;
			let result = "";
			for (let i = 0; i < n; i++) {
				const ch = chars[i]!;
				const d = headPos - i;
				if (d === 0) result += head(ch);
				else if (d > 0 && d <= 2) result += bright(ch);
				else if (d > 2 && d <= 4) result += base(ch);
				else result += dim(ch);
			}
			// Splice the animated logo back into the (padded) line.
			const rest = line.slice(visibleWidth(bright("pi") + ` v${VERSION}`));
			return result + rest;
		};

		let frame = 0;
		let timer: ReturnType<typeof setInterval> | null = null;
		let lastWidth = 0;

		const start = () => {
			if (timer) return;
			timer = setInterval(() => {
				frame++;
				tui.requestRender();
			}, FRAME_INTERVAL_MS);
		};

		return {
			render(width: number): string[] {
				if (width < MIN_WIDTH) {
					// Too narrow for the effect; show a clean static logo.
					return [bright("pi") + dim(` v${VERSION}`), "", onboarding, "", tagline].map((line) =>
						truncateToWidth(line, width, "", true),
					);
				}
				const expanded = ctx.ui.getToolsExpanded();
				ensureColumns(width);
				lastWidth = width;

				const cascadeLogo = bright("pi") + dim(` v${VERSION}`);
				const lines = [
					cascadeLogo,
					"",
					...buildHints(expanded).split("\n"),
					"",
					onboarding,
					"",
					tagline,
				];

				step(width, lines.length);
				const rain = renderRain(lines, width, expanded, frame);
				// Layer the cascade on top of the rain for the logo line.
				rain[0] = applyCascade(rain[0] ?? "", frame);
				return rain;
			},
			invalidate() {
				colsForWidth = 0;
			},
			dispose() {
				if (timer) {
					clearInterval(timer);
					timer = null;
				}
			},
		};
	});
}
