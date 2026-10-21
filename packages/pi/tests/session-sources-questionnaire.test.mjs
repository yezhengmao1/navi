import test from 'node:test';
import assert from 'node:assert/strict';
import { load, tui } from './helpers.mjs';

const { default: registerSources } = await load('session-mention');
const { default: registerQuestionnaire } = await load('questionnaire');
const { sourceId } = await load('external-sessions');
const theme = { fg: (_c, s) => s, bg: (_c, s) => s, bold: s => s };
const registered = ['/external/甲', '/external/乙'].map((directory, i) => ({
  directory, name: `来源${i}`, status: ['ok'], indexed: i,
}));
const options = registered.map(s => ({ value: sourceId(s.directory),
  label: `codex · ${s.name} · ${s.directory}` }));
const listParams = {
  title: '外部会话来源 · 2 个 · 只读有界扫描', submitLabel: '查看详情',
  questions: [{ id: 'source', type: 'single', prompt: '选择来源查看诊断（不修改注册）',
    options: options.map((o, i) => ({ ...o, label: `${o.label} · ok · 已索引 ${i}` })) }],
};
const removeParams = {
  title: '移除外部会话来源注册', submitLabel: '下一步',
  questions: [{ id: 'source', type: 'single', prompt: '选择来源（不会删除原始文件）', options }],
};
const confirmParams = {
  title: '确认仅移除注册', submitLabel: '确认移除注册',
  questions: [{ id: 'remove', type: 'confirm', default: false,
    prompt: `移除 codex · ${registered[1].name} · ${registered[1].directory}？原始目录和会话文件保持不变。` }],
};

function harness(scripts, directList = false) {
  const frames = [], results = [], notices = [], removed = [], handlers = new Map();
  let tool;
  const pi = { events: { on() {}, emit() {} }, on: (n, f) => handlers.set(n, f),
    registerCommand() {}, registerTool(t) { tool = t; } };
  registerQuestionnaire(pi);
  registerSources(pi, {
    scan: async () => ({ sources: registered, sessions: [], warnings: [] }),
    list: async () => registered,
    remove: async id => { removed.push(id); return true; },
  });
  const ctx = { hasUI: true, mode: 'tui', ui: {
    notify: (...args) => notices.push(args),
    custom: factory => new Promise((resolve, reject) => {
      let finished = false;
      const terminal = { rows: 24 };
      const view = factory({ terminal, requestRender() {} }, theme, {}, result => {
        finished = true; results.push(result); resolve(result);
      });
      const snapshot = () => {
        for (const [width, rows] of [[100, 24], [40, 18], [24, 18], [12, 8], [100, 24]]) {
          terminal.rows = rows;
          const lines = view.render(width);
          assert.ok(lines.every(line => tui.visibleWidth(line) <= width));
          assert.ok(lines.length <= rows - (directList ? 0 : 4));
          frames.push(lines);
        }
      };
      snapshot();
      const keys = scripts.shift();
      assert.ok(keys, 'unexpected additional dialog');
      for (const key of keys) { view.handleInput(key); snapshot(); }
      view.dispose?.();
      if (!finished) reject(new Error('dialog did not finish'));
    }),
  } };
  return { frames, results, notices, removed,
    command: text => handlers.get('input')({ text }, ctx),
    tool: params => tool.execute('parity', params, undefined, undefined, ctx),
  };
}

for (const [name, keys, selected] of [
  ['Enter immediately opens first source', ['\r'], 0],
  ['Down then Enter opens current source', ['\x1b[B', '\r'], 1],
  ['Up returns to first source', ['\x1b[B', '\x1b[A', '\r'], 0],
  ['Escape opens nothing', ['\x1b'], undefined],
  ['Space does not select; Escape opens nothing', ['\x1b[B', ' ', '\x1b'], undefined],
]) {
  test(`source list direct selection: ${name}`, async () => {
    const command = harness([[...keys]], true);
    await command.command('/session list');
    const initial = command.frames[0].join('\n');
    assert.match(initial, /2 个来源/);
    assert.match(initial, /↑↓ 选择 · Enter 查看详情 · Esc 取消/);
    assert.doesNotMatch(initial, /☐|☑|□|✓|提交|Space|Tab|搜索|\[查看详情\]|\[取消\]/);
    assert.equal(command.results.length, 1);
    assert.equal(command.notices.length, selected === undefined ? 0 : 1);
    if (selected !== undefined) {
      assert.ok(command.notices[0][0].includes(sourceId(registered[selected].directory)));
      assert.ok(!command.notices[0][0].includes(sourceId(registered[1 - selected].directory)));
    }
    assert.deepEqual(command.removed, []);
  });
}

for (const [name, confirmKeys, removes] of [
  ['default no', ['\r'], false], ['explicit yes', [' ', '\r'], true],
  ['cancel after yes', [' ', '\x1b'], false],
]) {
  test(`source remove uses questionnaire for selection AND confirmation: ${name}`, async () => {
    const selectKeys = ['\t', ' ', '\r'];
    const command = harness([[...selectKeys], [...confirmKeys]]);
    const tool = harness([[...selectKeys], [...confirmKeys]]);
    await command.command('/session remove');
    await tool.tool(removeParams); await tool.tool(confirmParams);
    assert.deepEqual(command.frames, tool.frames);
    assert.deepEqual(command.results, tool.results);
    assert.deepEqual(command.removed, removes ? [sourceId(registered[1].directory)] : []);
    assert.ok(!command.notices.some(([, level]) => level === 'error'));
  });
}

test('direct source picker scrolls 64 entries and remains bounded after resize', async () => {
  const { createSessionPicker } = await load('herdr-fork/picker');
  const terminal = { rows: 24 }, results = [];
  const labels = Array.from({ length: 64 }, (_, i) => `来源-${i}`);
  const view = createSessionPicker({ terminal, requestRender() {} }, theme,
    result => results.push(result), labels, {
      title: '外部会话来源', itemNoun: '来源', enterHint: 'Enter 查看详情 · Esc 取消',
    });
  for (let i = 0; i < 70; i++) view.handleInput('\x1b[B');
  for (const [width, rows] of [[100, 24], [24, 18], [12, 8], [40, 18], [100, 24]]) {
    terminal.rows = rows;
    const lines = view.render(width);
    assert.ok(lines.length <= rows);
    assert.ok(lines.every(line => tui.visibleWidth(line) <= width));
    if (width >= 24) assert.match(lines.join('\n'), /来源-63/);
  }
  view.handleInput('\r');
  view.handleInput('\r');
  view.handleInput('\x1b');
  assert.deepEqual(results, ['来源-63']);
});

test('wide shared questionnaire hint advertises Tab navigation', async () => {
  const h = harness([['\x1b']]);
  await h.tool(listParams);
  const footer = h.frames[0].find(line => line.includes('查看详情'));
  assert.match(footer, /↑↓\/Tab 移动/);
  assert.match(footer, /取消.*Enter 提交.*Esc 取消/);
});
