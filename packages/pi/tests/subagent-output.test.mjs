import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from './helpers.mjs';
const { BoundedLines, boundedText, appendTail, finalAssistantText } = await load('../../../../.pi/extensions/agent-team/output');

test('bounded lines preserve split UTF-8, multiple lines and unterminated final line', () => {
 const lines = [];
 const reader = new BoundedLines(line => lines.push(line), () => assert.fail('overflow'), 32);
 for (const byte of Buffer.from('你好\n\n世界\nlast')) reader.push(Buffer.from([byte]));
 reader.end();
 assert.deepEqual(lines, ['你好', '', '世界', 'last']);
});

test('oversized lines fail once, discard subsequent output, and do not accumulate', () => {
 let failures = 0;
 const lines = [];
 const reader = new BoundedLines(line => lines.push(line), () => failures++, 10);
 reader.push(Buffer.from('ok\n12345'));
 reader.push(Buffer.from('678901\nignored\n'));
 for (let i = 0; i < 100; i++) reader.push(Buffer.alloc(1024));
 reader.end();
 assert.equal(failures, 1);
 assert.deepEqual(lines, ['ok']);
 assert.equal(reader.pending, '');
});

test('bounded lines cap individual lines, not total stream', () => {
 let count = 0;
 const reader = new BoundedLines(() => count++, () => assert.fail('overflow'), 10);
 reader.push(Buffer.from('0123456789\n'.repeat(1000)));
 reader.end(); assert.equal(count, 1000);
});

test('output retains bounded text only and a bounded stderr tail', () => {
 const msg = {content: [{type: 'thinking', thinking: 'secret'}, {type: 'toolCall', arguments: {huge: 'x'.repeat(100000)}}, {type: 'text', text: 'x'.repeat(20000)}]};
 assert.equal(finalAssistantText(msg), boundedText('x'.repeat(20000)));
 assert.match(finalAssistantText(msg), /truncated/);
 assert.equal(appendTail('a'.repeat(16000), 'b'.repeat(1000)).length, 16000);
 assert.ok(appendTail('old', 'b'.repeat(20000)).endsWith('b'.repeat(16000)));
});

test('real child process: lightweight retains no history, full mode unchanged, usage preserved', async t => {
 const { runSingleAgent } = await load('../../../../.pi/extensions/agent-team/index');
 const dir = mkdtempSync(join(tmpdir(), 'pi-output-test-'));
 const script = join(dir, 'child.cjs');
 const original = process.argv[1];
 t.after(() => { process.argv[1] = original; rmSync(dir, {recursive: true, force: true}); });
 writeFileSync(script, `
 const send = message => console.log(JSON.stringify({type: 'message_end', message}));
 for (let i = 0; i < 100; i++) {
  send({role: 'toolResult', content: [{type: 'text', text: 'x'.repeat(10000)}]});
  send({role: 'assistant', content: [{type: 'thinking', thinking: 'x'.repeat(10000)}, {type: 'text', text: 'intermediate'}], usage: {input: 1, output: 2}});
 }
 send({role: 'assistant', content: [{type: 'text', text: '最终结果'}], stopReason: 'stop'});
 process.stderr.write('e'.repeat(100000));
 `);
 process.argv[1] = script;
 const agent = {name: 'fixture', source: 'user', systemPrompt: ''};
 const run = lightweight => runSingleAgent(dir, {}, [agent], 'fixture', 'check', undefined, undefined, undefined, undefined, results => ({results}), lightweight);
 const lean = await run(true);
 const full = await run(false);
 assert.equal(lean.exitCode, 0);
 assert.deepEqual(lean.messages, []);
 assert.equal(lean.finalOutput, '最终结果');
 assert.equal(lean.stderr.length, 16000);
 assert.equal(full.messages.length, 201);
 assert.equal(full.stderr.length, 100000);
 assert.equal(full.messages.at(-1).content[0].text, lean.finalOutput);
 assert.deepEqual(lean.usage, full.usage);
 assert.equal(lean.usage.input, 100);
 const retained = value => Buffer.byteLength(JSON.stringify(value));
 assert.ok(retained(lean) < retained(full) / 50);
 t.diagnostic(`Fixture retained result bytes: full=${retained(full)}, lightweight=${retained(lean)} (not peak RSS or model latency)`);

 // Exercise the actual runner's overflow path, not just the line-reader helper.
 writeFileSync(script, `process.stdout.write('x'.repeat(5 * 1024 * 1024)); setInterval(() => {}, 1000);`);
 await assert.rejects(run(true), /output limit/);
});
