import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * The new openai ChatGPT OAuth token cannot query the legacy wham usage API.
 * Keep the command for explanation, but do not fetch credentials, poll that API,
 * or display a placeholder until a compatible quota source has been verified.
 */
export default function (pi: ExtensionAPI) {
	const clear = (ctx: ExtensionContext) => {
		if (ctx.hasUI) ctx.ui.setStatus("codex-quota", undefined);
	};
	pi.on("session_start", (_event, ctx) => clear(ctx));
	pi.on("session_switch", (_event, ctx) => clear(ctx));
	pi.on("model_select", (_event, ctx) => clear(ctx));
	pi.on("session_shutdown", (_event, ctx) => clear(ctx));
	pi.registerCommand("quota", {
		description: "说明新版 OpenAI 订阅额度查询的支持状态",
		handler: async (_args, ctx) => {
			clear(ctx);
			if (ctx.hasUI) ctx.ui.notify(
				"尚未接入支持新版 OpenAI 登录的周额度接口；已停用旧接口查询并隐藏周剩余状态。",
				"info",
			);
		},
	});
}
