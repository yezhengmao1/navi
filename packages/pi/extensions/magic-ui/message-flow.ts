import type { Theme } from "@earendil-works/pi-coding-agent";
import { mixColors, rgbColor, visibleWidth } from "@earendil-works/pi-tui";

/** Match the installed editor's warm surface and eight-second diagonal light band. */
export function messageFlowPalette(width: number, theme: Theme, elapsed: number, row = 0, height = 1): string[] {
	const phase = (Math.max(0, elapsed) % 8000) / 8000;
	const tint = mixColors(theme.colors.accent, theme.colors.warning, 0.3);
	const base = theme.name === "magic" ? rgbColor(36, 27, 27) : theme.colors.userMessageBg;
	return Array.from({ length: width }, (_, column) => {
		const position = (column + 0.5 + row * 2) / Math.max(1, width + (height - 1) * 2);
		const wave = Math.max(0, 1 - Math.abs(position - (-0.45 + phase * 1.9)) / 0.45);
		const strength = wave * wave * (3 - 2 * wave) * 0.18;
		return theme.style("", { bg: mixColors(base, tint, strength) }).replace(/\x1b\[49m$/, "");
	});
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** Preserve foreground/OSC markers and repaint after native background resets. */
export function paintMessageFlow(line: string, palette: string[]): string {
	const tokens = line.split(/(\x1b(?:\[[0-?]*[ -/]*[@-~]|[_\]P^X][\s\S]*?(?:\x07|\x1b\\)))/g);
	let column = 0;
	let active = "";
	let output = "";
	for (const token of tokens) {
		if (token.startsWith("\x1b")) {
			output += token;
			if (/^\x1b\[[0-?]*[ -/]*m$/.test(token)) active = "";
			continue;
		}
		for (const { segment } of graphemes.segment(token)) {
			const background = palette[Math.min(column, palette.length - 1)] ?? "";
			if (active !== background) { output += background; active = background; }
			output += segment;
			column += visibleWidth(segment);
		}
	}
	return output + "\x1b[49m";
}
