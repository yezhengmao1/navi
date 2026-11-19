import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { renderSelectionCard } from "./selection-card.js";

/** Never render Input itself: only a mask reaches terminal output. */
export async function promptConfabKey(ctx: ExtensionContext, signal: AbortSignal): Promise<string | undefined> {
  if (ctx.mode !== "tui" || !ctx.hasUI || signal.aborted) return undefined;
  return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
    let input: Input | undefined = new Input();
    let finished = false;
    let cursor = 0; // input, submit, cancel
    let pasting = false;
    let warning = "";
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      input?.setValue("");
      input = undefined;
    };
    const finish = (value?: string) => {
      if (finished) return;
      finished = true;
      cleanup();
      done(value);
    };
    const abort = () => finish();
    input.onEscape = () => finish();
    input.onSubmit = value => {
      const token = value.trim();
      warning = !token ? "尚未收到密钥，请直接粘贴后再提交。"
        : token.length > 4096 ? "密钥超过 4096 字符，请检查复制的内容。"
        : /[\s\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(token) ? "密钥含空白或控制字符，请仅复制 API key。" : "";
      if (warning) {
        cursor = 0;
        tui.requestRender();
        return;
      }
      finish(token);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) finish();
    return {
      get focused() { return input?.focused ?? false; },
      set focused(value: boolean) { if (input) input.focused = value; },
      render(width: number) {
        // Same card renderer as questionnaire; never publish the secret through tools/events.
        return renderSelectionCard({
          width, theme, title: "Confab — API key 授权", compact: true,
          subtitle: `1 / 1 · ${input?.getValue() ? `已输入 ${input.getValue().length} 个字符` : "等待输入"}`,
          bodyLines: wrapTextWithAnsi("请输入或粘贴 API key；密钥仅用于登录校验与私密保存，不写入会话记录。", Math.max(1, width - 4)),
          items: [{ label: "密钥：" + (input?.getValue() ? "*".repeat(Math.min(input.getValue().length, 48)) : "（等待输入）") }],
          cursor: cursor === 0 ? 0 : -1,
          warning: warning || undefined,
          actions: [
            { label: "确认提交", active: cursor === 1, primary: true },
            { label: "取消", active: cursor === 2 },
          ],
          hints: ["Tab 切换 · Enter 提交 · Esc 取消", "Tab / ↵ / Esc"],
        });
      },
      handleInput(data: string) {
        if (finished) return;
        // Bracketed paste may arrive in separate chunks. Do not interpret its content as navigation/submit.
        if (pasting || data.includes("\x1b[200~")) {
          cursor = 0;
          pasting = !data.includes("\x1b[201~");
          warning = "";
          input?.handleInput(data);
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.escape)) { finish(); return; }
        if (matchesKey(data, Key.tab) || matchesKey(data, Key.down)) cursor = (cursor + 1) % 3;
        else if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.up)) cursor = (cursor + 2) % 3;
        else if (matchesKey(data, Key.enter)) {
          if (cursor === 2) finish(); else input?.onSubmit?.(input.getValue());
        } else {
          // Typing/pasting while an action is focused must not silently discard the key.
          cursor = 0;
          warning = "";
          input?.handleInput(data);
        }
        tui.requestRender();
      },
      invalidate() {},
      dispose() { finished = true; cleanup(); },
    };
  }, { blocked: { kind: "auth", message: "输入 Confab API key" } });
}
