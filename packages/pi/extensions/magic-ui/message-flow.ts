import type { Theme } from "@earendil-works/pi-coding-agent";
import { mixColors, rgbColor } from "@earendil-works/pi-tui";

const staticBackgrounds = new WeakMap<object, { colors: object; name: string; appearance: string; ansi: string }>();

/** A softly bright, uniform surface. Color conversion runs once per theme. */
export function staticMessageBackground(theme: Theme): string {
	const cached = staticBackgrounds.get(theme);
	if (cached && cached.colors === theme.colors && cached.name === theme.name && cached.appearance === theme.appearance) return cached.ansi;
	const base = theme.name === "magic" ? rgbColor(36, 27, 27) : theme.colors.userMessageBg;
	const tint = mixColors(theme.colors.accent, theme.colors.warning, 0.3);
	const ansi = theme.style("", { bg: mixColors(base, tint, 0.18) }).replace(/\x1b\[49m$/, "");
	staticBackgrounds.set(theme, { colors: theme.colors, name: theme.name, appearance: theme.appearance, ansi });
	return ansi;
}

/** Preserve OSC zones/foreground; restore the uniform background after SGR resets. */
export function paintStaticMessage(line: string, background: string): string {
	const tokens = line.split(/(\x1b(?:\[[0-?]*[ -/]*[@-~]|[_\]P^X][\s\S]*?(?:\x07|\x1b\\)))/g);
	return tokens.map(token => token.startsWith("\x1b")
		? (/^\x1b\[[0-?]*[ -/]*m$/.test(token) ? token + background : token)
		: (token ? background + token : "")).join("") + "\x1b[49m";
}
