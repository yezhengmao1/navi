import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const NEW_LOGIN_MESSAGE = "新版 OpenAI ChatGPT 登录尚无已验证的订阅额度查询接口；旧接口不接受此凭证。请查看 https://chatgpt.com/settings/usage 。不会把 API 速率限制当作订阅额度。";

/** Legacy Codex JWT only. Never accept API keys or invent an account ID. */
export function legacyAccountId(token: string): string | undefined {
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    const id = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof id === "string" && /^[\w-]{1,200}$/.test(id) ? id : undefined;
  } catch { return undefined; }
}

/** A duration is mandatory: primary/secondary do not always mean 5h/week. */
export function quotaSummary(payload: unknown): string | undefined {
  const data = payload as { rate_limit?: { primary_window?: unknown; secondary_window?: unknown } };
  if (!data || typeof data !== "object") return undefined;
  const parts: string[] = [];
  for (const item of [data.rate_limit?.primary_window, data.rate_limit?.secondary_window]) {
    const w = item as { used_percent?: unknown; limit_window_seconds?: unknown } | undefined;
    if (!w || typeof w.used_percent !== "number" || !Number.isFinite(w.used_percent)
      || w.used_percent < 0 || w.used_percent > 100 || typeof w.limit_window_seconds !== "number"
      || !Number.isFinite(w.limit_window_seconds) || w.limit_window_seconds <= 0) continue;
    const seconds = w.limit_window_seconds;
    const label = seconds === 604800 ? "周" : seconds % 3600 === 0 ? `${seconds / 3600}h` : `${seconds}s`;
    parts.push(`${label}剩余 ${Number((100 - w.used_percent).toFixed(1))}%`);
  }
  return parts.length ? parts.join(" · ") : undefined;
}

export default function registerQuota(pi: ExtensionAPI) {
  let generation = 0;
  let request: AbortController | undefined;
  const clear = (ctx: ExtensionContext) => {
    generation++;
    request?.abort();
    request = undefined;
    if (ctx.hasUI) ctx.ui.setStatus("codex-quota", undefined);
  };
  for (const event of ["session_start", "session_switch", "model_select", "session_shutdown"] as const) {
    pi.on(event, (_event, ctx) => clear(ctx));
  }
  pi.registerCommand("quota", {
    description: "手动查询旧 Codex 订阅额度；新版 OpenAI 登录显示支持状态，不后台轮询",
    handler: async (_args, ctx) => {
      clear(ctx);
      if (!ctx.hasUI) return;
      const model = ctx.model;
      if (model?.provider === "openai") { ctx.ui.notify(NEW_LOGIN_MESSAGE, "info"); return; }
      if (model?.provider !== "openai-codex") {
        ctx.ui.notify("当前模型不是 OpenAI Codex；未查询其他账号或凭证。", "info"); return;
      }
      // Do not forward a custom gateway's credential to the official endpoint.
      let url: URL;
      try { url = new URL(model.baseUrl); } catch { return; }
      if (url.origin !== "https://chatgpt.com" || !ctx.modelRegistry.isUsingOAuth(model)) {
        ctx.ui.notify("仅支持官方 ChatGPT 地址的旧 Codex OAuth，不支持 API key 或自定义网关。", "warning"); return;
      }
      const current = generation;
      const controller = new AbortController();
      request = controller;
      const timer = setTimeout(() => controller.abort(), 15_000);
      timer.unref();
      try {
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (generation !== current || controller.signal.aborted) return;
        if (!auth.ok) throw new Error("auth");
        if (auth.baseUrl && new URL(auth.baseUrl).origin !== "https://chatgpt.com") throw new Error("gateway");
        const token = auth.apiKey;
        const account = token && legacyAccountId(token);
        if (!token || !account) {
          ctx.ui.notify("凭证没有旧 Codex 账号声明；不尝试额度请求。", "warning"); return;
        }
        const response = await fetch(USAGE_URL, {
          headers: { Authorization: `Bearer ${token}`, "ChatGPT-Account-Id": account, Accept: "application/json" },
          signal: controller.signal, redirect: "error",
        });
        if (generation !== current) return;
        if (!response.ok) {
          ctx.ui.notify(`额度接口返回 HTTP ${response.status}，未更新额度；不会自动重试。`, "warning"); return;
        }
        const summary = quotaSummary(await response.json());
        if (generation !== current || controller.signal.aborted) return;
        if (!summary) { ctx.ui.notify("额度响应缺少有效窗口数据，无法显示。", "warning"); return; }
        const snapshot = `${summary}（${new Date().toLocaleTimeString()} 快照）`;
        ctx.ui.setStatus("codex-quota", snapshot);
        ctx.ui.notify(snapshot, "info");
      } catch {
        if (generation === current) ctx.ui.notify("额度查询失败或超时；未记录认证信息。", "warning");
      } finally {
        clearTimeout(timer);
        if (request === controller) request = undefined;
      }
    },
  });
}
