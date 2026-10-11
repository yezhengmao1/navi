import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const sources = ["arxiv", "hfpapers", "zhihu", "hackernews", "github", "producthunt"];
const labels = ["arxiv", "HF Papers", "知乎", "Hacker News", "GitHub", "Product Hunt"];

type Selection = {
  cancelled: boolean;
  sources: string[];
  feishu: boolean;
  siyuan: boolean;
  reason?: string;
};

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "brief_select",
    label: "简报选项",
    description: "在主会话展示简报交互选择界面：多选信息源、飞书推送、思源归档，统一提交。取消或 UI 不可用时不得执行简报。不要通过子 agent 调用。",
    exposure: "model-only",
    parameters: Type.Object({
      sources: Type.Optional(Type.Array(Type.Union(sources.map(s => Type.Literal(s))), {
        description: "预选来源；省略时预选全部。不是已获得用户确认。",
      })),
      feishu: Type.Optional(Type.Boolean({ description: "预选飞书推送，默认 false" })),
      siyuan: Type.Optional(Type.Boolean({ description: "预选思源归档，默认 true" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const cancelled = (reason: string): Selection => ({
        cancelled: true, sources: [], feishu: false, siyuan: false, reason,
      });
      const result = (value: Selection) => ({
        content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value,
      });
      if (ctx.mode !== "tui") return result(cancelled("UI 不可用：请在 Pi 交互式终端运行，或由用户明确提供文字选项。"));
      if (signal?.aborted) return result(cancelled("操作已中止"));

      const selection = await ctx.ui.custom<Selection>((tui, theme, _kb, done) => {
        const selected = new Set(params.sources ?? sources);
        let feishu = params.feishu ?? false;
        let siyuan = params.siyuan ?? true;
        let cursor = 0;
        let warning = "";
        let finished = false;
        const finish = (value: Selection) => {
          if (finished) return;
          finished = true;
          signal?.removeEventListener("abort", abort);
          done(value);
        };
        const abort = () => finish(cancelled("操作已中止"));
        signal?.addEventListener("abort", abort, { once: true });
        const toggle = () => {
          warning = "";
          if (cursor < 6) {
            const source = sources[cursor];
            if (selected.has(source)) selected.delete(source);
            else selected.add(source);
          } else if (cursor === 6) feishu = !feishu;
          else if (cursor === 7) siyuan = !siyuan;
        };
        return {
          render(width) {
            // magic-ui owns presentation; this extension owns workflow and input.
            // Without magic-ui, retain the standalone selector below.
            const card = {
              width, theme,
              title: "每日简报",
              subtitle: `选择信息源与输出 · 已选 ${selected.size}/${sources.length} 个来源`,
              cursor,
              items: [
                ...labels.map((label, i) => ({
                  label, checked: selected.has(sources[i]),
                  ...(i === 0 ? { group: "信息源" } : {}),
                })),
                { label: "推送飞书（稍后需提供本次 KEY）", checked: feishu, group: "输出方式" },
                { label: "写入思源 navi /daily/{日期}", checked: siyuan },
                { label: "确认并开始 →", primary: true, group: "操作" },
                { label: "取消" },
              ],
              hints: ["↑↓ 移动 · 空格切换 · a 全选/清空来源", "Enter 确认并开始 · Esc 取消"],
              warning,
              lines: undefined as string[] | undefined,
            };
            pi.events.emit("magic-ui:selection-card", card);
            if (card.lines) return card.lines;
            const rows = labels.map((label, i) => `[${selected.has(sources[i]) ? "x" : " "}] ${label}`);
            rows.push(`[${feishu ? "x" : " "}] 推送飞书（稍后需提供本次 KEY）`);
            rows.push(`[${siyuan ? "x" : " "}] 写入思源 navi /daily/{日期}`);
            rows.push("确认并开始", "取消");
            return [
              theme.fg("accent", "每日简报 · 选择信息源与输出"),
              ...rows.map((row, i) => i === cursor ? theme.fg("accent", `> ${row}`) : `  ${row}`),
              theme.fg("muted", "↑↓ 移动 · 空格切换 · a 全选/清空来源"),
              theme.fg("muted", "Enter 确认并开始 · Esc 取消"),
              ...(warning ? [theme.fg("warning", warning)] : []),
            ].map(line => truncateToWidth(line, Math.max(1, width)));
          },
          invalidate() {},
          handleInput(data) {
            if (finished) return;
            if (matchesKey(data, Key.escape)) { finish(cancelled("用户取消")); return; }
            if (matchesKey(data, Key.up)) cursor = (cursor + 9) % 10;
            else if (matchesKey(data, Key.down) || matchesKey(data, Key.tab)) cursor = (cursor + 1) % 10;
            else if (data === "a") {
              if (selected.size === sources.length) selected.clear();
              else sources.forEach(s => selected.add(s));
              warning = "";
            } else if (data === " ") toggle();
            else if (matchesKey(data, Key.enter)) {
              if (cursor === 9) { finish(cancelled("用户取消")); return; }
              if (!selected.size) warning = "请至少选择一个信息源。";
              else {
                finish({ cancelled: false, sources: sources.filter(s => selected.has(s)), feishu, siyuan });
                return;
              }
            }
            tui.requestRender();
          },
          dispose() { signal?.removeEventListener("abort", abort); },
        };
      });
      return result(selection);
    },
  });
}
