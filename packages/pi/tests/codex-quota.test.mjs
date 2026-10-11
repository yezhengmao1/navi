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
const { default: register } = await createJiti(import.meta.url).import(fileURLToPath(new URL("../extensions/codex-quota.ts", import.meta.url)));

for (const hasUI of [true, false]) test(`disabled quota clears stale status without requests (UI=${hasUI})`, async t => {
  t.mock.method(globalThis, "fetch", () => assert.fail("No legacy requests"));
  t.mock.method(globalThis, "setInterval", () => assert.fail("No polling"));
  const events = {};
  const commands = {};
  const statuses = [];
  const notifications = [];
  register({ on(name, handler) { events[name] = handler; }, registerCommand(name, command) { commands[name] = command; } });
  const ctx = {
    hasUI,
    modelRegistry: new Proxy({}, { get() { assert.fail("No credential access"); } }),
    ui: {
      setStatus: (key, value) => statuses.push([key, value]),
      notify: (...args) => notifications.push(args),
    },
  };
  for (const name of ["session_start", "session_switch", "model_select", "session_shutdown"]) {
    await events[name]({}, ctx);
  }
  await commands.quota.handler("", ctx);
  assert.deepEqual(statuses, hasUI ? Array.from({ length: 5 }, () => ["codex-quota", undefined]) : []);
  assert.equal(notifications.length, hasUI ? 1 : 0);
  if (hasUI) assert.match(notifications[0][0], /已停用旧接口查询/);
});
