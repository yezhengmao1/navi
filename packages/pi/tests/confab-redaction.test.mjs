import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';
const { redact } = await load('confab-redaction');
const { snapshot } = await load('confab-data');
const credential = { backend: 'https://example.test', token: 'confab-test-credential' };
const msg = (role, content, extra = {}) => ({ type: 'message', timestamp: '2026-11-12T08:00:00Z', message: { role, content, ...extra } });

test('cloud AK/SK assignments are scrubbed without depending on the credential value format', () => {
  for (const key of ['DLC_AK', 'DLC_SK', 'AK', 'SK', 'dlc_ak', 'aliyun-sk']) {
    for (const input of [`export ${key}=FAKE_PRIVATE_VALUE`, `${key}: FAKE_PRIVATE_VALUE`, `"${key}": "FAKE_PRIVATE_VALUE"`, `${key}='FAKE_PRIVATE_VALUE'`, `${key}=\`FAKE_PRIVATE_VALUE\``]) {
      assert.doesNotMatch(redact(input), /FAKE_PRIVATE_VALUE/);
    }
  }
  assert.equal(redact('task=normal\nmask=normal\nDLC_REGION=cn-test\n使用 DLC_AK 和 DLC_SK'), 'task=normal\nmask=normal\nDLC_REGION=cn-test\n使用 DLC_AK 和 DLC_SK');
});

test('assignment credentials repeated as positional arguments are scrubbed within and across messages', () => {
  const assignment = 'export DLC_AK=FAKE_ACCESS_VALUE\nexport DLC_SK=FAKE_SECRET_VALUE';
  const command = 'python submit.py FAKE_ACCESS_VALUE FAKE_SECRET_VALUE';
  assert.doesNotMatch(redact(`${assignment}\n${command}`), /FAKE_/);
  for (const texts of [[assignment, command], [command, assignment]]) {
    const branch = texts.map(text => msg('user', text));
    assert.doesNotMatch(snapshot(branch, credential).lines.join('\n'), /FAKE_/);
  }
});

test('standalone Alibaba access key IDs are scrubbed', () => {
  assert.doesNotMatch(redact('id LTAI5tFakeAccessKey123456 end'), /LTAI5tFakeAccessKey123456/);
});

test('AK/SK scrub covers tool arguments, output, details, thinking and summaries without source mutation', () => {
  const branch = [
    msg('assistant', [{ type: 'thinking', thinking: 'DLC_AK=FAKE_THINKING' }, { type: 'toolCall', id: 'call', name: 'bash', arguments: { command: 'export DLC_SK=FAKE_COMMAND', DLC_AK: 'FAKE_ARGUMENT', nested: { SK: ['FAKE_ARRAY'] }, task: 'keep task' } }]),
    msg('toolResult', 'export DLC_AK=FAKE_OUTPUT_A\nexport DLC_SK=FAKE_OUTPUT_S', { toolCallId: 'call', details: { DLC_SK: 'FAKE_DETAIL', output: 'AK=FAKE_DETAIL_OUTPUT' } }),
    { type: 'compaction', timestamp: '2026-11-12T08:00:00Z', summary: 'DLC_SK=FAKE_SUMMARY' },
  ];
  const before = structuredClone(branch);
  const output = snapshot(branch, credential).lines.join('\n');
  assert.doesNotMatch(output, /FAKE_/);
  assert.match(output, /keep task/);
  assert.deepEqual(branch, before);
});

test('AK/SK assignments split across blocks are scrubbed without erasing adjacent messages', () => {
  for (const fragments of [['DLC_SK=', 'FAKE_FRAGMENT'], ['DLC_AK="FAKE_FIRST', 'FAKE_SECOND"']]) {
    const records = snapshot(['keep before', ...fragments, 'keep after'].map(text => msg('user', text)), credential).lines.map(JSON.parse);
    assert.doesNotMatch(JSON.stringify(records), /FAKE_/);
    assert.equal(records[0].message.content[0].text, 'keep before');
    assert.equal(records.at(-1).message.content[0].text, 'keep after');
  }
});
