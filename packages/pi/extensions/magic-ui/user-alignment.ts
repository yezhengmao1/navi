import { visibleWidth } from "@earendil-works/pi-tui";

type PaintRow = (text: string, width: number, row: number, height: number) => string;

/** Keep native left-aligned Markdown, padding and OSC zones; decorate its surface only. */
export function userAlignmentAdapter(paint: PaintRow = text => text) {
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
						const wrapped = function (this: any, width: number) {
							const lines: string[] = original.call(this, width);
							return lines.map((line, row) => paint(
								line + " ".repeat(Math.max(0, width - visibleWidth(line))), width, row, lines.length));
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
