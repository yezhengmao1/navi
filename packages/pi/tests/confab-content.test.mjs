import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';
const { snapshot } = await load('confab-data');
const credential = { backend: 'https://example.test', token: 'literal-private-credential' };
const msg = (role, content, extra = {}) => ({ type: 'message', timestamp: '2026-11-12T08:00:00Z', message: { role, content, ...extra } });
test('tools preserve order, hashed association, arguments, error and structured details', () => {
  const branch = [
    msg('assistant', [{ type: 'thinking', thinking: 'checking file', signature: 'NO_SIGNATURE' },
      { type: 'toolCall', id: 'original-id', name: 'bash', arguments: { command: 'ls', password: 'NO_PASSWORD', nested: { access_token: 'NO_TOKEN' } } }]),
    msg('toolResult', [{ type: 'text', text: 'failed safely' }, { type: 'image', data: 'NO_IMAGE' }],
      { toolCallId: 'original-id', isError: true, details: { exitCode: 1, cookie: 'NO_COOKIE', output: 'literal-private-credential', image: 'NO_BINARY' } }),
  ];
  const s = snapshot(branch, credential), records = s.lines.map(JSON.parse);
  const call = records[0].message.content[1], result = records[1].message.content[0];
  assert.equal(records[0].message.content[0].type, 'thinking');
  assert.equal(call.type, 'tool_use'); assert.equal(call.name, 'bash'); assert.equal(call.input.command, 'ls');
  assert.equal(result.type, 'tool_result'); assert.equal(result.tool_use_id, call.id); assert.equal(result.is_error, true);
  assert.equal(records[1].type, 'user');
  assert.equal(records[1].toolUseResult.exitCode, 1);
  assert.equal(records[1].toolUseResult.cookie, '[REDACTED FIELD]');
  assert.equal(records[0].toolUseResult, undefined);
  assert.doesNotMatch(JSON.stringify(result.content), /exitCode|工具附加信息/);
  assert.doesNotMatch(s.lines.join(''), /NO_|original-id|literal-private-credential/);
  assert.deepEqual(snapshot(branch, credential), s);
});
test('cross tool and thinking secret fragments are redacted together', () => {
  const branch = [msg('assistant', [{ type: 'thinking', thinking: '-----BEGIN PRIVATE KEY-----\nPRIVATE_PART_A' },
    { type: 'toolCall', id: 'id', name: 'read', arguments: { path: 'PRIVATE_PART_B\n-----END PRIVATE KEY-----' } }])];
  assert.doesNotMatch(snapshot(branch, credential).lines.join(''), /PRIVATE_PART/);
});
test('tool names remain replayable after redaction without revealing the original identifier', () => {
  for (const [prefix, name, expected] of [
    ['token=', 'HIDDEN_FRAGMENT', 'redacted_tool'],
    ['', credential.token, 'redacted_tool'],
    ['', '[REDACTED cross-block secret]', 'redacted_tool'],
    ['', 'read\n', 'redacted_tool'],
    ['', 'mcp.example-get_v2', 'mcp.example-get_v2'],
  ]) {
    const branch = [msg('assistant', [{ type: 'text', text: prefix }, { type: 'toolCall', id: 'id', name, arguments: {} }]),
      msg('toolResult', 'done', { toolCallId: 'id' })];
    const [a, r] = snapshot(branch, credential).lines.map(JSON.parse);
    const call = a.message.content[1];
    assert.equal(call.name, expected);
    assert.equal(r.message.content[0].tool_use_id, call.id);
    assert.doesNotMatch(JSON.stringify([a, r]), /HIDDEN_FRAGMENT|literal-private-credential/);
  }
});
test('cross-block matches redact only intersecting leaves, not the whole session', () => {
  const branch = [msg('user', 'keep earlier request'),
    msg('assistant', [{ type: 'thinking', thinking: '-----BEGIN PRIVATE KEY-----\nPRIVATE_A' },
      { type: 'text', text: '' },
      { type: 'text', text: 'PRIVATE_B\n-----END PRIVATE KEY-----' },
      { type: 'toolCall', id: 'call', name: 'read', arguments: { path: '/safe/report.md' } }]),
    msg('toolResult', 'keep tool output', { toolCallId: 'call', details: { output: 'keep metadata' } }),
    msg('assistant', 'keep final summary')];
  const before = structuredClone(branch);
  const records = snapshot(branch, credential).lines.map(JSON.parse);
  assert.equal(records[0].message.content[0].text, 'keep earlier request');
  assert.equal(records[1].message.content[0].thinking, '-----BEGIN PRIVATE KEY-----\n[REDACTED PEM]');
  assert.equal(records[1].message.content[2].text, '[REDACTED PEM]\n-----END PRIVATE KEY-----');
  assert.equal(records[1].message.content[3].name, 'read');
  assert.equal(records[1].message.content[3].input.path, '/safe/report.md');
  assert.equal(records[2].message.content[0].content[0].text, 'keep tool output');
  assert.equal(records[2].toolUseResult.output, 'keep metadata');
  assert.equal(records[3].message.content[0].text, 'keep final summary');
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE_A|PRIVATE_B/);
  assert.deepEqual(branch, before);
  assert.deepEqual(snapshot(branch, credential).lines.map(JSON.parse), records);
});
test('quoted assignments and folded auth protect cross-message fragments locally', () => {
  for (const fragments of [
    ['password="FIRST_FRAGMENT', 'SECOND_FRAGMENT"'],
    ['Authorization: FIRST_FRAGMENT', '  SECOND_FRAGMENT'],
    ['token=', 'SECOND_FRAGMENT'],
  ]) {
    const branch = ['keep before', ...fragments, 'keep after'].map(text => msg('user', text));
    const records = snapshot(branch, credential).lines.map(JSON.parse);
    assert.equal(records[0].message.content[0].text, 'keep before');
    assert.equal(records.at(-1).message.content[0].text, 'keep after');
    assert.doesNotMatch(JSON.stringify(records), /FIRST_FRAGMENT|SECOND_FRAGMENT/);
  }
});
test('standalone secrets do not taint adjacent normal blocks', () => {
  const branch = [msg('user', 'sk-abcdefghijklm'), msg('user', credential.token), msg('user', 'normal output')];
  const records = snapshot(branch, credential).lines.map(JSON.parse);
  assert.equal(records[2].message.content[0].text, 'normal output');
  assert.doesNotMatch(JSON.stringify(records), /sk-abcdefghijklm|literal-private-credential|cross-block/);
});
test('mentioning a PEM marker in prose does not redact later conversation', () => {
  const texts = ['示例：`-----BEGIN PRIVATE KEY-----`', 'tool output', 'next message'];
  const out = snapshot(texts.map(t => msg('user', t)), credential).lines.map(JSON.parse);
  assert.deepEqual(out.map(r => r.message.content[0].text), texts);
});
test('unterminated PEM hides payload but stops at ordinary conversation', () => {
  const records = snapshot(['keep before', '-----BEGIN PRIVATE KEY-----', 'PRIVATE_TAIL', 'ordinary tool output']
    .map(text => msg('user', text)), credential).lines.map(JSON.parse);
  assert.equal(records[0].message.content[0].text, 'keep before');
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE_TAIL/);
  assert.equal(records.at(-1).message.content[0].text, 'ordinary tool output');
});
test('multi-megabyte snapshots remain complete and oversized individual lines fail explicitly', () => {
  // Exceed both former aggregate byte caps without exceeding the per-line budget.
  const payload = ('normal output '.repeat(8000) + '\n').repeat(4);
  const branch = Array.from({ length: 151 }, (_, i) => msg('user', `record ${i}: ` + payload));
  const s = snapshot(branch, credential);
  assert.equal(s.lines.length, branch.length);
  assert.ok(s.lines.reduce((n, l) => n + Buffer.byteLength(l), 0) > 64 * 1024 * 1024);
  assert.ok(s.lines.every(l => Buffer.byteLength(JSON.stringify(l)) + 1 <= 512 * 1024));
  const large = snapshot([msg('user', 'normal output '.repeat(50000))], credential);
  assert.equal(large.lines.length, 1);
  assert.ok(Buffer.byteLength(large.lines[0]) > 512 * 1024);
  assert.throws(() => snapshot([msg('user', 'x'.repeat(15 * 1024 * 1024))], credential), { code: 'line_limit' });
});
test('28-level details retain structure and redact deeply nested secrets', () => {
  let details = { text: 'deep output', password: 'NO_DEEP_SECRET' };
  for (let i = 0; i < 28; i++) details = { nested: details };
  const s = snapshot([msg('toolResult', 'done', { toolCallId: 'call', details })], credential);
  assert.match(s.lines[0], /deep output/);
  assert.doesNotMatch(s.lines[0], /NO_DEEP_SECRET/);
  for (let i = 0; i < 110; i++) details = { nested: details };
  assert.throws(() => snapshot([msg('toolResult', 'done', { toolCallId: 'call', details })], credential), { code: 'depth_limit' });
});
test('metadata stays separate, remains redacted across boundaries, and affects identity', () => {
  const make = details => [msg('toolResult', 'normal output', { toolCallId: 'call', details })];
  const a = snapshot(make({ exitCode: 0 }), credential);
  const b = snapshot(make({ exitCode: 1 }), credential);
  assert.notEqual(a.externalId, b.externalId);
  assert.deepEqual(JSON.parse(a.lines[0]).message.content[0].content, [{ type: 'text', text: 'normal output' }]);
  for (const details of [null, false, 5, 'metadata string', [{ status: 'ok' }]]) {
    const r = JSON.parse(snapshot(make(details), credential).lines[0]);
    assert.ok(typeof r.toolUseResult === 'object' || typeof r.toolUseResult === 'string');
  }
  const cross = snapshot([msg('toolResult', '-----BEGIN PRIVATE KEY-----\nFIRST_SECRET',
    { toolCallId: 'call', details: { output: 'SECOND_SECRET\n-----END PRIVATE KEY-----' } })], credential);
  assert.doesNotMatch(cross.lines.join(''), /FIRST_SECRET|SECOND_SECRET/);
});
test('summaries and custom messages preserved; opaque custom state omitted', () => {
  const stamp = { timestamp: '2026-11-12T08:00:00Z' };
  const s = snapshot([{ ...stamp, type: 'compaction', summary: 'summary text' },
    { ...stamp, type: 'custom_message', content: 'extension text' },
    { ...stamp, type: 'custom', data: 'NO_INTERNAL_STATE' }], credential);
  assert.equal(s.lines.length, 2); assert.match(s.lines.join(''), /summary text/);
  assert.doesNotMatch(s.lines.join(''), /NO_INTERNAL_STATE/);
});
