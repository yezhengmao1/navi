import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const install = join(homedir(), ".pi/agent/install");
const root = process.env.PI_PACKAGE_ROOT ?? join(install, "releases",
  readFileSync(join(install, "current-version"), "utf8").trim(),
  "node_modules/@earendil-works/pi-coding-agent");
const require = createRequire(join(root, "package.json"));
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { alias: {
  "@earendil-works/pi-coding-agent": join(root, "dist/index.js"),
  "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui"),
} });
const { renderSelectionCard, default: extension } = await jiti.import(fileURLToPath(new URL("../extensions/magic-ui.ts", import.meta.url)));
const { visibleWidth, stripTerminalSequences } = await import(require.resolve("@earendil-works/pi-tui"));
const theme = {
  fg: (_, text) => `\x1b[36m${text}\x1b[39m`,
  bg: (_, text) => `\x1b[44m${text}\x1b[49m`,
  bold: text => `\x1b[1m${text}\x1b[22m`,
};
const card = {
  theme, title: "每日简报", subtitle: "选择信息源与输出 · 已选 1/2 个来源", cursor: 1,
  items: [
    { label: "HF Papers", checked: true, group: "信息源" },
    { label: "推送飞书（稍后需提供本次 KEY）", checked: false, group: "输出方式" },
    { label: "确认并开始 →", primary: true, group: "操作" },
    { label: "取消" },
  ],
  hints: ["↑↓ 移动 · 空格切换 · a 全选/清空来源", "Enter 切换/执行当前项 · Esc 取消"],
  warning: "请至少选择一个信息源。",
};

test("selection card is bounded across narrow, CJK and wide terminals", () => {
  for (const width of [1, 2, 5, 6, 10, 24, 40, 76, 120]) {
    const lines = renderSelectionCard({ ...card, width });
    assert.ok(lines.length);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
    if (width >= 6) for (const line of lines) assert.equal(visibleWidth(line), Math.min(width, 76));
  }
});

test("card shows borders, groups, checkboxes, focus, warning and hints", () => {
  const lines = renderSelectionCard({ ...card, width: 76 });
  const plain = lines.map(stripTerminalSequences).join("\n");
  for (const text of ["╭", "╯", "信息源", "输出方式", "操作", "[✓] HF Papers", "› [ ] 推送飞书", "请至少选择一个信息源。", "Esc 取消"])
    assert.ok(plain.includes(text), text);
  assert.ok(lines.some(line => line.includes("\x1b[44m")));
});

test("renderer event responds synchronously and removes listener at shutdown", () => {
  const handlers = new Map();
  let listener;
  extension({
    on(name, fn) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
    events: { on(name, fn) {
      assert.equal(name, "magic-ui:selection-card");
      listener = fn;
      return () => { listener = undefined; };
    } },
  });
  const request = { ...card, width: 76 };
  listener(request);
  assert.deepEqual(request.lines, renderSelectionCard(request));
  for (const fn of handlers.get("session_shutdown")) fn({}, { hasUI: false });
  assert.equal(listener, undefined);
});
