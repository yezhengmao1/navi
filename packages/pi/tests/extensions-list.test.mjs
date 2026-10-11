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
const { extensionListText, extensionListAdapter, renderNaviWordmark } = await jiti.import(fileURLToPath(new URL("../extensions/magic-ui/header.ts", import.meta.url)));
const { Text, visibleWidth } = await import(require.resolve("@earendil-works/pi-tui"));
const dim = text => `\x1b[2m${text}\x1b[22m`;
const compact = "[Extensions]\n  clear.ts, magic-header.ts, magic-ui.ts";

test("NAVI wordmark uses theme colors and includes tagline/version", () => {
  const calls = [];
  const lines = renderNaviWordmark(80, (color, text) => {
    calls.push(color);
    return `\x1b[36m${text}\x1b[39m`;
  }, "1.1.0");
  assert.equal(lines.length, 8);
  assert.equal(calls.filter(c => c === "accent").length, 6);
  assert.equal(calls.at(-1), "muted");
  assert.match(lines.join("\n"), /Hey Listen!  ·  π 1\.1\.0/);
  assert.doesNotMatch(lines.join("\n"), /已就绪|╭── 终端/);
});

test("NAVI wordmark handles narrow widths and resize without clipping the big logo", () => {
  for (const width of [0, 1, 5, 12, 24, 30, 32, 40, 80, 10, 80]) {
    const lines = renderNaviWordmark(width, (_, text) => text);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
    if (width >= 6 && width < 30) assert.equal(lines[0], "  NAVI");
    if (width >= 40) assert.ok(lines[0].includes("███"));
  }
});

test("list formatting preserves header, themes each item, and is idempotent", () => {
  const result = extensionListText(compact, dim, 24);
  assert.equal(result, "[Extensions]\n" + ["clear.ts", "magic-header.ts", "magic-ui.ts"]
    .map(name => dim(`  - ${name}`)).join("\n"));
  assert.equal(extensionListText(result, dim), result);
  assert.equal(extensionListText("[Extensions]\n  only.ts", x => x), "[Extensions]\n  - only.ts");
  for (const width of [1, 8, 20, 80]) {
    for (const line of new Text(result, 0, 0).render(width)) assert.ok(visibleWidth(line) <= width);
  }
});

test("unrelated and expanded sections remain unchanged", () => {
  for (const text of ["[Themes]\n  a, b", "[Skills]\n  User\n    /path/to/a", "[Extensions]\n  User\n    a.ts", "[Extensions]\n  ", "assistant text"])
    assert.equal(extensionListText(text, dim), text);
});

test("skills use the same themed list formatting", () => {
  const result = extensionListText("[Skills]\n  arxiv, brief, 中文", dim, 12);
  assert.equal(result, "[Skills]\n" + ["arxiv", "brief", "中文"].map(name => dim(`  - ${name}`)).join("\n"));
  assert.equal(extensionListText(result, dim), result);
  assert.equal(extensionListText("[Skills]\n  arxiv", dim), "[Skills]\n" + dim("  - arxiv"));
  for (const width of [2, 8, 20, 80]) {
    for (const line of new Text(result, 0, 0).render(width)) assert.ok(visibleWidth(line) <= width);
  }
});

function section(expanded = false, title = "Extensions") {
  return {
    state: { expanded },
    build() { return (this.state.expanded ? "[Extensions]\n  /path/to/only.ts" : compact).replace("[Extensions]", `[${title}]`); },
    setExpanded(value) { this.state.expanded = value; },
    invalidate() { this.invalidations = (this.invalidations ?? 0) + 1; },
  };
}

for (const fullscreen of [false, true]) test(`adapter lifecycle (${fullscreen ? "fullscreen" : "regular"})`, () => {
  const node = section(true);
  const original = node.build;
  const document = { children: [node] };
  const root = fullscreen ? { getMountedRoots: () => [{ child: document }] } : { children: [document] };
  const adapter = extensionListAdapter(x => x);
  adapter.update(root);
  const wrapped = node.build;
  assert.notEqual(wrapped, original);
  assert.equal(node.build(), "[Extensions]\n  /path/to/only.ts");
  node.setExpanded(false);
  assert.equal(node.build(), extensionListText(compact, x => x));
  adapter.update(root);
  assert.equal(node.build, wrapped);
  assert.equal(node.invalidations, 2); // First collapse establishes the shared grid.
  adapter.update(root);
  assert.equal(node.invalidations, 2);
  const replacement = section();
  document.children = [replacement];
  adapter.update(root);
  assert.ok(replacement.build().includes("  - clear.ts"));
  adapter.dispose();
  assert.equal(node.build, original);
  assert.equal(replacement.build(), compact);
  adapter.dispose();
});

for (const fullscreen of [false, true]) test(`all resource sections are patched (${fullscreen ? "fullscreen" : "regular"})`, () => {
  const skills = section(false, "Skills");
  const extensions = section();
  const originals = [skills.build, extensions.build];
  const document = { children: [skills, extensions] };
  const root = fullscreen ? { getMountedRoots: () => [{ child: document }] } : { children: [document] };
  const adapter = extensionListAdapter(x => x);
  adapter.update(root);
  for (const node of [skills, extensions]) {
    assert.ok(node.build().includes("\n  - clear.ts"));
    node.setExpanded(true);
    assert.ok(node.build().includes("\n  /path/to/only.ts"));
    node.setExpanded(false);
  }
  const replacement = section(false, "Skills");
  document.children = [skills, replacement, extensions];
  adapter.update(root);
  assert.ok(replacement.build().includes("\n  - clear.ts"));
  assert.equal(skills.invalidations, 1);
  assert.equal(extensions.invalidations, 1);
  adapter.dispose();
  assert.equal(skills.build, originals[0]);
  assert.equal(extensions.build, originals[1]);
});

for (const fullscreen of [false, true]) test(`sections share a grid (${fullscreen ? "fullscreen" : "regular"})`, () => {
  const skills = section(false, "Skills");
  skills.build = () => "[Skills]\n  arxiv, brief, dlc, feishu, 中文";
  const extensions = section();
  extensions.build = () => "[Extensions]\n  clear.ts, command-guard.ts, herdr-agent-state.ts, magic-ui, subagent";
  const document = { children: [skills] };
  const root = fullscreen ? { getMountedRoots: () => [document] } : document;
  const adapter = extensionListAdapter(x => x);
  adapter.update(root, 100);
  const original = skills.build();
  document.children.push(extensions);
  for (const width of [100, 80, 50, 24, 100]) {
    adapter.update(root, width);
    const rows = [skills, extensions].map(node => node.build().split("\n").slice(1));
    const starts = row => [...row.matchAll(/- /g)].map(match => visibleWidth(row.slice(0, match.index)));
    assert.deepEqual(starts(rows[0][0]), starts(rows[1][0]));
    for (const lines of rows) for (const line of lines) assert.ok(visibleWidth(line) <= width);
  }
  assert.notEqual(skills.build(), original);
  document.children = [skills];
  adapter.update(root, 100);
  assert.equal(skills.build(), original);
  adapter.dispose();
});

test("unknown shapes and cycles are safe", () => {
  const root = { children: [] };
  root.children.push(root, null, { build: "not a function" });
  const adapter = extensionListAdapter(dim);
  adapter.update(root);
  adapter.dispose();
});

test("tables align wide characters and adapt to resize", () => {
  const text = "[Skills]\n  中文, abcd, xy, brief, last";
  const wide = extensionListText(text, x => x, 80);
  assert.equal(wide, "[Skills]\n  - 中文    - abcd    - xy      - brief\n  - last");
  for (const width of [0, 1, 8, 20, 40, 80]) {
    for (const line of extensionListText(text, dim, width).split("\n").slice(1))
      assert.ok(visibleWidth(line) <= width);
  }
  const node = section();
  const root = { children: [node] };
  const adapter = extensionListAdapter(x => x);
  adapter.update(root, 80);
  const before = node.build();
  adapter.update(root, 24);
  assert.equal(node.build().split("\n").length, 4);
  assert.equal(node.invalidations, 2);
  adapter.update(root, 80);
  assert.equal(node.build(), before);
  adapter.dispose();
});
