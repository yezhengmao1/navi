import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { renderSelectionCard } from "./editor-footer.js";
import { Type } from "typebox";

const Option = Type.Object({
  value: Type.String({ minLength: 1 }),
  label: Type.String({ minLength: 1 }),
});
const common = {
  id: Type.String({ minLength: 1 }),
  prompt: Type.String({ minLength: 1 }),
};
const Question = Type.Union([
  Type.Object({ ...common, type: Type.Literal("single"),
    options: Type.Array(Option, { minItems: 1, maxItems: 30 }),
    default: Type.Optional(Type.String()),
  }),
  Type.Object({ ...common, type: Type.Literal("multiple"),
    options: Type.Array(Option, { minItems: 1, maxItems: 30 }),
    default: Type.Optional(Type.Array(Type.String())),
    min: Type.Optional(Type.Integer({ minimum: 0 })),
    max: Type.Optional(Type.Integer({ minimum: 0 })),
  }),
  Type.Object({ ...common, type: Type.Literal("confirm"),
    default: Type.Optional(Type.Boolean()),
  }),
]);

type Choice = { value: string; label: string };
type QuestionSpec = { id: string; prompt: string } & (
  | { type: "single"; options: Choice[]; default?: string }
  | { type: "multiple"; options: Choice[]; default?: string[]; min?: number; max?: number }
  | { type: "confirm"; default?: boolean }
);
type Answer = string | string[] | boolean;
type Result = { cancelled: boolean; answers: Record<string, Answer>; reason?: string };

/** Validate cross-field constraints before any UI opens. No business semantics. */
export function validateQuestions(questions: QuestionSpec[]) {
  if (!questions.length || questions.length > 12) throw new Error("需要 1–12 个问题");
  const ids = new Set<string>();
  for (const q of questions) {
    if (!q.id || ids.has(q.id)) throw new Error("问题 ID 必须非空且唯一");
    ids.add(q.id);
    if (q.type === "confirm") continue;
    const values = new Set(q.options.map(o => o.value));
    if (!q.options.length || values.size !== q.options.length) throw new Error("选项值必须唯一且选项不能为空");
    const defaults = q.default === undefined ? [] : Array.isArray(q.default) ? q.default : [q.default];
    if (defaults.some(v => !values.has(v)) || new Set(defaults).size !== defaults.length) {
      throw new Error("默认值必须为不重复的有效选项");
    }
    if (q.type === "multiple") {
      const min = q.min ?? 0, max = q.max ?? values.size;
      if (min < 0 || min > max || max > values.size) throw new Error("多选数量限制无效");
      // An empty default is allowed even when min > 0: the user must answer.
      if (defaults.length > max) throw new Error("默认选项超出最大数量");
    }
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "questionnaire",
    label: "交互问卷",
    description: "向用户展示单选、多选、是/否确认问题，统一提交后返回 answers（以问题 ID 为键）。预选不等于同意。取消、中止或非交互模式返回 cancelled:true 和空 answers，不得据此执行后续动作。仅主会话调用，不用于收集凭证。",
    exposure: "model-only",
    parameters: Type.Object({
      title: Type.String({ minLength: 1, description: "界面标题" }),
      questions: Type.Array(Question, { minItems: 1, maxItems: 12 }),
      submitLabel: Type.Optional(Type.String({ minLength: 1, description: "提交按钮文字，默认确认提交" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const result = (value: Result) => ({
        content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value,
      });
      return result(await showQuestionnaire(pi, ctx, params, signal));
    },
  });
}

/** Shared command/tool UI; commands may supply up to 64 registered sources. */
export async function showQuestionnaire(pi: ExtensionAPI, ctx: ExtensionContext,
  params: { title: string; questions: QuestionSpec[]; submitLabel?: string }, signal?: AbortSignal): Promise<Result> {
      const cancelled = (reason: string): Result => ({ cancelled: true, answers: {}, reason });
      validateQuestions(params.questions);
      if (ctx.mode !== "tui") return cancelled("UI 不可用；请在交互式终端运行或由用户明确提供文字答案");
      if (signal?.aborted) return cancelled("操作已中止");

      return await ctx.ui.custom<Result>((tui, theme, _kb, done) => {
        const questions = params.questions;
        const answers = new Map<string, Answer>();
        const rows: { question: number; option?: string; label: string; group?: string }[] = [];
        for (const [index, q] of questions.entries()) {
          if (q.type === "confirm") {
            answers.set(q.id, q.default ?? false);
            rows.push({ question: index, label: q.prompt, group: "是 / 否" });
          } else {
            if (q.type === "multiple") answers.set(q.id, [...(q.default ?? [])]);
            else if (q.default !== undefined) answers.set(q.id, q.default);
            q.options.forEach((o, i) => rows.push({ question: index, option: o.value, label: o.label,
              ...(i === 0 ? { group: `${q.prompt}（${q.type === "single" ? "单选" : "多选"}）` } : {}),
            }));
          }
        }
        const submitIndex = rows.length, cancelIndex = submitIndex + 1;
        let cursor = 0, warning = "", finished = false, usable = true;
        const finish = (value: Result) => {
          if (finished) return;
          finished = true;
          signal?.removeEventListener("abort", abort);
          done(value);
        };
        const abort = () => finish(cancelled("操作已中止"));
        signal?.addEventListener("abort", abort, { once: true });
        const submit = () => {
          for (const q of questions) {
            const value = answers.get(q.id);
            if (q.type === "single" && value === undefined) { warning = `请选择：${q.prompt}`; return; }
            if (q.type === "multiple") {
              const count = (value as string[]).length;
              if (count < (q.min ?? 0) || count > (q.max ?? q.options.length)) {
                warning = `${q.prompt}：请选择 ${q.min ?? 0}–${q.max ?? q.options.length} 项`; return;
              }
            }
          }
          finish({ cancelled: false, answers: Object.fromEntries(answers) });
        };
        const toggle = () => {
          const row = rows[cursor];
          if (!row) return;
          const q = questions[row.question];
          const value = answers.get(q.id);
          if (q.type === "confirm") answers.set(q.id, !value);
          else if (q.type === "single") answers.set(q.id, row.option!);
          else {
            const selected = new Set(value as string[]);
            if (selected.has(row.option!)) selected.delete(row.option!); else selected.add(row.option!);
            answers.set(q.id, q.options.filter(o => selected.has(o.value)).map(o => o.value));
          }
        };
        return {
          render(width) {
            const height = Math.max(1, Math.min(28, (tui.terminal?.rows ?? 24) - 4));
            usable = width >= 24 && height >= 10;
            if (!usable) return width > 0 ? [truncateToWidth("窗口过小，请放大；Esc 取消", width)] : [];
            const items = rows.map(row => {
              const q = questions[row.question], value = answers.get(q.id);
              const checked = q.type === "confirm" ? value === true
                : q.type === "single" ? value === row.option : (value as string[]).includes(row.option!);
              return { label: row.label, group: row.group, checked };
            });
            // Measure actual group/warning rows; actions never scroll with options.
            const focus = Math.min(cursor, rows.length - 1);
            for (let count = Math.min(12, items.length); count >= 1; count--) {
              const start = Math.max(0, Math.min(focus - Math.floor(count / 2), items.length - count));
              const visible = items.slice(start, start + count).map(item => ({ ...item }));
              if (start > 0 && !visible[0].group) visible[0].group = questions[rows[start].question].prompt;
              const q = rows[cursor] && questions[rows[cursor].question];
              const actionHint = cursor === cancelIndex ? '取消' : '提交';
              const hints = [
                `↑↓/Tab 移动 · 空格选择${q?.type === 'multiple' ? ' · a 全选/清空' : ''} · Enter ${actionHint} · Esc 取消`,
                `↑↓ 移动 · 空格选择 · Enter ${actionHint}`, `↑↓ / 空格 · ↵ ${actionHint}`,
              ];
              const card = {
                width, theme, title: params.title, compact: true,
                subtitle: `${start + 1}–${start + visible.length} / ${items.length} · ${questions.length} 题`,
                cursor: cursor < rows.length ? cursor - start : -1, items: visible, hints, warning,
                actions: [
                  { label: params.submitLabel ?? '确认提交', active: cursor === submitIndex, primary: true },
                  { label: '取消', active: cursor === cancelIndex },
                ],
                lines: undefined as string[] | undefined,
              };
              const rendered = renderSelectionCard(card);
              if (rendered.length > height && count > 1) continue;
              if (rendered.length > height) {
                usable = false;
                return [truncateToWidth('窗口过小，请放大；Esc 取消', width)];
              }
              pi.events.emit('magic-ui:selection-card', card);
              return card.lines ?? rendered;
            }
            return [];
          },
          invalidate() {},
          handleInput(data) {
            if (finished) return;
            if (matchesKey(data, Key.escape)) { finish(cancelled("用户取消")); return; }
            if (!usable) return;
            warning = "";
            if (matchesKey(data, Key.up) || matchesKey(data, Key.shift("tab"))) cursor = (cursor + cancelIndex) % (cancelIndex + 1);
            else if (matchesKey(data, Key.down) || matchesKey(data, Key.tab)) cursor = (cursor + 1) % (cancelIndex + 1);
            else if (data === " ") toggle();
            else if (data === "a") {
              const row = rows[cursor], q = row && questions[row.question];
              if (q?.type === "multiple") {
                const value = answers.get(q.id) as string[];
                answers.set(q.id, value.length === q.options.length ? [] : q.options.map(o => o.value));
              }
            } else if (matchesKey(data, Key.enter)) {
              if (cursor === cancelIndex) finish(cancelled("用户取消")); else submit();
            }
            tui.requestRender();
          },
          dispose() { signal?.removeEventListener("abort", abort); },
        };
      });
}
