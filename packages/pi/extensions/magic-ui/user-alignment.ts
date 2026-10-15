import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type PaintRow = (text: string, width: number, row: number, height: number) => string;

/** Keep native left-aligned Markdown, padding and OSC zones; decorate its surface only. */
export function userAlignmentAdapter(paint: PaintRow = text => text,
	labelStyle: (text: string) => string = text => text,
	cacheKey?: () => string) {
	const restores = new Map<any, () => void>();
	return {
		update(root: unknown) {
			const pending: any[] = [root];
			const seen = new Set<any>();
			while (pending.length) {
				const node = pending.pop();
				if (!node || typeof node !== "object" || seen.has(node)) continue;
				seen.add(node);
				if (node.constructor?.name === "UserMessageComponent" && typeof node.text === "string"
					&& typeof node.render === "function" && typeof node.setOutputPad === "function") {
					if (!restores.has(node)) {
						const original = node.render;
						let cached: { width: number; key: string; source: string[]; output: string[] } | undefined;
						const wrapped = function (this: any, width: number) {
							const source: string[] = original.call(this, width);
							const key = cacheKey?.();
							if (key !== undefined && cached && cached.width === width && cached.key === key
								&& source.length === cached.source.length && source.every((line, i) => line === cached!.source[i])) return cached.output;
							const lines = [...source];
							// Use native top padding without moving the OSC prompt boundary.
							if (lines.length && !stripTerminalSequences(lines[0]).trim()) {
								const zone = lines[0].match(/^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/)?.[0] ?? "";
								lines[0] = zone + labelStyle(truncateToWidth(" User", width, ""));
							}
							const output = lines.map((line, row) => paint(
								line + " ".repeat(Math.max(0, width - visibleWidth(line))), width, row, lines.length));
							if (key !== undefined) cached = { width, key, source: [...source], output };
							return output;
						};
						node.render = wrapped;
						node.invalidate?.();
						restores.set(node, () => {
							if (node.render === wrapped) { node.render = original; node.invalidate?.(); }
						});
					}
					continue;
				}
				if (typeof node.getMountedRoots === "function") pending.push(...node.getMountedRoots());
				else if (Array.isArray(node.children)) pending.push(...node.children);
				if (node.child) pending.push(node.child);
			}
			for (const [node, restore] of restores) if (!seen.has(node)) { restore(); restores.delete(node); }
		},
		dispose() { for (const restore of restores.values()) restore(); restores.clear(); },
	};
}
