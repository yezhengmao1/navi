import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

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
	/** Optional compact, fixed action area; input remains owned by the caller. */
	actions?: { label: string; active?: boolean; primary?: boolean }[];
	compact?: boolean;
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
	if (card.subtitle && !card.compact) lines.push(row(theme.fg("muted", card.subtitle)));
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
	if (framed) {
		const label = card.compact && card.subtitle ? truncateToWidth(`─ ${card.subtitle} `, width - 2) : "";
		lines.push(label ? border("├" + label + "─".repeat(Math.max(0, width - 2 - visibleWidth(label))) + "┤") : rule());
	}
	if (card.warning) {
		const warningLines = wrapTextWithAnsi(theme.fg("warning", card.warning), bodyWidth);
		const shown = card.compact ? warningLines.slice(0, 2) : warningLines;
		for (const [index, line] of shown.entries()) lines.push(row(index === shown.length - 1 && shown.length < warningLines.length ? truncateToWidth(line, Math.max(0, bodyWidth - 1)) + "…" : line));
	}
	const compactHint = (available: number) => {
		const hint = card.hints.find(text => visibleWidth(text) <= available) ?? card.hints.at(-1) ?? "";
		return available > 0 ? truncateToWidth(hint, available, "…") : "";
	};
	if (card.actions?.length) {
		const actions = card.actions.map(action => {
			const text = `${action.active ? "›" : " "} ${action.label}`;
			return theme.fg(action.active ? "accent" : "text", action.active ? theme.bold(text) : text);
		});
		let joined = actions.join("    ");
		if (card.compact) {
			// Reserve buttons first; hints only use the remaining columns on the right.
			if (visibleWidth(joined) > bodyWidth) joined = actions.join(" ");
			const actionLines = visibleWidth(joined) <= bodyWidth ? [joined] : actions;
			for (const [index, action] of actionLines.entries()) {
				const hint = index === actionLines.length - 1 ? compactHint(bodyWidth - visibleWidth(action) - 2) : "";
				const padding = hint ? " ".repeat(bodyWidth - visibleWidth(action) - visibleWidth(hint)) : "";
				lines.push(row(action + padding + theme.fg("muted", hint)));
			}
		} else if (visibleWidth(joined) <= bodyWidth) lines.push(row(joined));
		else for (const action of actions) lines.push(row(action));
	}
	if (card.compact) {
		if (!card.actions?.length) {
			const hint = compactHint(bodyWidth);
			if (hint) lines.push(row(theme.fg("muted", hint)));
		}
	} else for (const hint of card.hints) {
		for (const line of wrapTextWithAnsi(theme.fg("muted", hint), bodyWidth)) lines.push(row(line));
	}
	if (framed) lines.push(border("└" + "─".repeat(width - 2) + "┘"));
	return lines;
}

