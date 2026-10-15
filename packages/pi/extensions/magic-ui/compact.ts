/**
 * Compact Display
 *
 * Keeps long thinking blocks and bash calls readable without changing the
 * session, model context, or executed command. Omitted content is summarized
 * with a count instead of the built-in "[truncated]" label.
 */

import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const THINKING_TAIL_LINES = 6;
const MAX_COMMAND_WIDTH = 80;

interface CompactText {
	head: string;
	marker: string;
	tail: string;
	omitted: number;
}

/** Collapse whitespace so a multi-line shell command stays a one-line title. */
export function normalizeCommand(command: string): string {
	return command.replace(/\s+/g, " ").trim();
}

/** Preserve both ends and describe exactly what was folded. */
export function compactText(value: string, maxWidth: number): CompactText {
	if (value.length <= maxWidth) {
		return { head: value, marker: "", tail: "", omitted: 0 };
	}

	// The count can change the marker width, so settle the small feedback loop.
	let marker = " … folded … ";
	let omitted = value.length;
	for (let i = 0; i < 4; i++) {
		const contentWidth = Math.max(2, maxWidth - marker.length);
		omitted = value.length - contentWidth;
		marker = ` … ${omitted} chars folded … `;
	}

	const contentWidth = Math.max(2, maxWidth - marker.length);
	const headWidth = Math.max(1, Math.ceil(contentWidth * 0.65));
	const tailWidth = Math.max(1, contentWidth - headWidth);
	omitted = value.length - headWidth - tailWidth;
	marker = ` … ${omitted} chars folded … `;

	// Rebalance once if the final count crossed a digit boundary.
	const finalContentWidth = Math.max(2, maxWidth - marker.length);
	const finalHeadWidth = Math.max(1, Math.ceil(finalContentWidth * 0.65));
	const finalTailWidth = Math.max(1, finalContentWidth - finalHeadWidth);
	omitted = value.length - finalHeadWidth - finalTailWidth;
	marker = ` … ${omitted} chars folded … `;

	return {
		head: value.slice(0, finalHeadWidth),
		marker,
		tail: value.slice(-finalTailWidth),
		omitted,
	};
}

export function compactThinking(markdown: string, keepLines = THINKING_TAIL_LINES): string {
	// Keep the legacy slice semantics for unusual explicit limits. The normal
	// path counts separators without allocating every historical line.
	if (!Number.isInteger(keepLines) || keepLines < 1) {
		const lines = markdown.split("\n");
		if (lines.length <= keepLines) return markdown;
		const omitted = lines.length - keepLines;
		return `⋯ ${omitted} earlier thinking ${omitted === 1 ? "line" : "lines"} folded ⋯\n\n${lines.slice(-keepLines).join("\n")}`;
	}
	let lineCount = 1;
	for (let at = markdown.indexOf("\n"); at !== -1; at = markdown.indexOf("\n", at + 1)) lineCount++;
	if (lineCount <= keepLines) return markdown;
	let boundary = markdown.length;
	for (let i = 0; i < keepLines; i++) boundary = markdown.lastIndexOf("\n", boundary - 1);
	const omitted = lineCount - keepLines;
	const tail = markdown.slice(boundary + 1);
	return `⋯ ${omitted} earlier thinking ${omitted === 1 ? "line" : "lines"} folded ⋯\n\n${tail}`;
}

export default function (pi: ExtensionAPI) {
	pi.registerMarkdownTransformer((markdown, { messageType }) => {
		if (messageType !== "assistant-thinking") return markdown;
		return compactThinking(markdown);
	});

	const bash = createBashToolDefinition(process.cwd());
	pi.registerTool({
		// Keep native execution/output rendering. Block timing owns the duration
		// label; don't add the native duplicate footer (or touch command output).
		...bash,
		renderResult(result, options, theme, context) {
			return bash.renderResult!(result, options, theme, { ...context, durationMs: undefined });
		},

		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const command = normalizeCommand((args as { command?: string }).command ?? "");
			const compact = compactText(command, MAX_COMMAND_WIDTH);

			let content = theme.fg("toolTitle", theme.bold("bash "));
			content += theme.fg("muted", compact.head);
			if (compact.omitted > 0) {
				content += theme.fg("dim", compact.marker);
				content += theme.fg("muted", compact.tail);
			}

			const timeout = (args as { timeout?: number }).timeout;
			if (typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0) {
				content += theme.fg("dim", ` (timeout ${timeout}s)`);
			}

			text.setText(content);
			return text;
		},
	});
}
