import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { load, root } from './helpers.mjs';
const { resolveHerdrBridge } = await load('../../../../.pi/extensions/agent-team/herdr-bridge');

test('read-only bridge discovery fails closed, never uses repository-provided extension', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-bridge-check-'));
  try {
    assert.throws(() => resolveHerdrBridge(dir), /Install\/repair/);
    mkdirSync(join(dir, 'extensions'));
    const path = join(dir, 'extensions/herdr-agent-state.ts');
    writeFileSync(path, '// HERDR_INTEGRATION_ID=pi\n// pane.report_agent_session\nexport default function () {}');
    assert.equal(resolveHerdrBridge(dir), path);
    writeFileSync(path, '// HERDR_INTEGRATION_ID=pi\n// pane.report_agent_session\npi.registerTool({});');
    assert.throws(() => resolveHerdrBridge(dir), /not a recognized status-only integration/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('installed Herdr bridge reports Pi identity and lifecycle to a local fake socket, with no model/tools', async t => {
  let bridge;
  try { bridge = resolveHerdrBridge(join(homedir(), '.pi/agent')); }
  catch { t.skip('Herdr-managed Pi integration not installed on this test machine'); return; }
  if (process.platform === 'win32') { t.skip('Unix-socket contract fixture'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'pi-bridge-socket-'));
  const socket = join(dir, 'socket');
  const old = { ...process.env };
  const messages = [];
  const server = net.createServer(client => {
    let data = '';
    client.on('data', chunk => {
      data += chunk.toString();
      if (data.includes('\n')) { messages.push(JSON.parse(data.trim())); client.end('{"result":{}}\n'); }
    });
  });
  server.listen(socket); await once(server, 'listening');
  Object.assign(process.env, { HERDR_ENV: '1', HERDR_PANE_ID: 'fake:p1', HERDR_SOCKET_PATH: socket });
  const waitFor = async predicate => {
    const deadline = Date.now() + 2000;
    while (!predicate()) { if (Date.now() > deadline) assert.fail('bridge did not report expected lifecycle'); await new Promise(resolve => setTimeout(resolve, 5)); }
  };
  try {
    const require = createRequire(join(root, 'package.json'));
    const { createJiti } = require('jiti');
    const jiti = createJiti(import.meta.url, { moduleCache: false });
    const { default: register } = await jiti.import(bridge);
    const hooks = new Map();
    // The retained extension may only observe/report; registering model tools is forbidden by this fixture.
    register({ events: { on() {} }, on(name, fn) { hooks.set(name, fn); } });
    let idle = true;
    const ctx = { mode: 'tui', isIdle: () => idle, sessionManager: { getSessionFile: () => '/fake/session.jsonl', getSessionId: () => 'session-id' } };
    await hooks.get('session_start')({ reason: 'new' }, ctx);
    await waitFor(() => messages.some(m => m.params.state === 'idle'));
    assert.ok(messages.some(m => m.method === 'pane.report_agent_session' && m.params.agent_session_path === '/fake/session.jsonl'));
    idle = false; hooks.get('agent_start')({}, ctx);
    await waitFor(() => messages.some(m => m.params.state === 'working'));
    idle = true; hooks.get('agent_settled')({}, ctx);
    await waitFor(() => messages.filter(m => m.params.state === 'idle').length === 2);
    assert.ok(messages.every(m => m.params.pane_id === 'fake:p1'));
    // Let acknowledgement handlers finish before removing the socket.
    await new Promise(resolve => setTimeout(resolve, 20));
  } finally {
    await new Promise(resolve => server.close(resolve));
    for (const key of ['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_SOCKET_PATH']) {
      if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key];
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
