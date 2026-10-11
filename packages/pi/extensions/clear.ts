/**
 * Clear Extension
 *
 * Adds a /clear command that clears the conversation by starting a fresh
 * session, freeing the model context. This mirrors the behavior of the
 * built-in /new command (in upstream pi, /clear and /new are aliases that
 * both start a new session).
 *
 * Usage:
 *   /clear
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { confirmOrFeedback } from "./command-guard.js";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("clear", {
		description: "清空当前对话并开始新会话",
		handler: async (_args, ctx) => {
			// Confirm before discarding the current conversation, but only
			// when there is an interactive UI and an actual conversation to
			// clear. In non-interactive modes just start the new session.
			const entries = ctx.sessionManager.getEntries();
			const hasConversation = entries.length > 0;

			if (ctx.hasUI && hasConversation) {
				const result = await confirmOrFeedback(
					ctx,
					"🧹 清空当前对话？",
					"这将开始一个新会话，并从模型上下文中清除当前对话。\n当前会话文件仍会保留在磁盘上。",
					{ yes: "✅ 是", no: "❌ 否" },
				);
				if (!result.allow) return;
			}

			const result = await ctx.newSession({
				withSession: async (ctx) => {
					ctx.ui.notify("对话已清空，已开始新会话。", "info");
				},
			});

			if (result.cancelled) return;
		},
	});
}
