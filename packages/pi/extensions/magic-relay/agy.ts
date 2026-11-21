import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';

const TASK_BYTES = 64 * 1024;
const ANSWER_BYTES = 48 * 1024;
const FRAME_BYTES = 256 * 1024;
const STDOUT_BYTES = 4 * 1024 * 1024;

// Search only absolute PATH entries, then ~/.local/bin (agy's usual install
// location). Never let an empty or relative entry resolve against the task cwd.
function localAgy() {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(isAbsolute);
  const home = homedir();
  if (isAbsolute(home)) dirs.push(join(home, '.local', 'bin'));
  for (const dir of dirs) {
    const executable = join(dir, 'agy');
    try {
      if (!statSync(executable).isFile()) continue;
      accessSync(executable, constants.X_OK);
    } catch { continue; }
    return { executable, path: dirs.join(delimiter) };
  }
  throw new Error('agy not found on absolute PATH or in ~/.local/bin');
}

function diagnostic(value: unknown, fallback: string) {
  if (typeof value !== 'string') return fallback;
  return value.length > 256 ? `${value.slice(0, 256)}… [truncated]` : value;
}

async function* frames(stdout: Readable) {
  // Bound even an unterminated line; decode only complete frames, since a
  // pipe read can split either a UTF-8 character or a JSON-RPC message.
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let total = 0, size = 0;
  let parts: Buffer[] = [];
  for await (const chunk of stdout) {
    total += chunk.length;
    if (total > STDOUT_BYTES) throw new Error(`agy ACP stdout exceeds ${STDOUT_BYTES} bytes`);
    for (let start = 0; start < chunk.length;) {
      const lf = chunk.indexOf(10, start);
      const part = chunk.subarray(start, lf < 0 ? chunk.length : lf);
      size += part.length;
      if (size > FRAME_BYTES) throw new Error(`agy ACP frame exceeds ${FRAME_BYTES} bytes`);
      parts.push(part);
      if (lf < 0) break;
      let msg;
      try { msg = JSON.parse(decoder.decode(parts.length === 1 ? part : Buffer.concat(parts, size))); }
      catch { throw new Error('agy sent invalid ACP JSON'); }
      if (msg?.jsonrpc !== '2.0') throw new Error('agy sent an invalid JSON-RPC envelope');
      yield msg;
      parts = []; size = 0; start = lf + 1;
    }
  }
}

/** One ACP v1 turn. The caller supplies the deadline. Never resume or retry. */
export async function runAgy(task: string, cwd: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  if (Buffer.byteLength(task) > TASK_BYTES) throw new Error(`agy task exceeds ${TASK_BYTES} bytes`);
  const { executable, path } = localAgy();
  cwd = resolve(cwd);
  const child = spawn(executable, ['acp', '--stdio', '--sandbox'], {
    cwd, env: { ...process.env, PATH: path }, shell: false, stdio: ['pipe', 'pipe', 'ignore'],
  });
  // Wake the reader on startup/write failure or abort, even if no ACP reply comes.
  const fail = (err: Error) => child.stdout.destroy(err);
  const abort = () => fail(new Error('agy aborted'));
  child.on('error', fail);
  child.stdin.on('error', fail);
  signal.addEventListener('abort', abort, { once: true });
  function send(body: object) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...body }) + '\n'); }

  try {
    let pending = 1; // exactly one outstanding request: initialize, new, prompt
    let sessionId: string | undefined, messageId: string | undefined;
    let answer = '', answerBytes = 0;
    send({ id: pending, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } });
    for await (const msg of frames(child.stdout)) {
      signal.throwIfAborted();
      if ('method' in msg) {
        if ('id' in msg) {
          if (typeof msg.id !== 'number' && typeof msg.id !== 'string') throw new Error('Invalid ACP request ID');
          if (msg.method === 'session/request_permission') {
            send({ id: msg.id, result: { outcome: { outcome: 'cancelled' } } });
          } else {
            send({ id: msg.id, error: { code: -32601, message: 'No such client method' } });
          }
        } else if (msg.method === 'session/update' && pending === 3 && msg.params?.sessionId === sessionId) {
          const update = msg.params.update;
          if (update?.sessionUpdate === 'tool_call') {
            answer = ''; answerBytes = 0; messageId = undefined;
          } else if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
            if (typeof update.content.text !== 'string') throw new Error('Invalid ACP text chunk');
            if (typeof update.messageId === 'string' && update.messageId !== messageId) {
              answer = ''; answerBytes = 0; messageId = update.messageId;
            }
            answerBytes += Buffer.byteLength(update.content.text);
            if (answerBytes > ANSWER_BYTES) throw new Error(`agy answer exceeds ${ANSWER_BYTES} bytes; refusing truncated output`);
            answer += update.content.text;
          }
        }
        continue;
      }
      if (msg.id !== pending) throw new Error('agy sent an unexpected response ID');
      if ('error' in msg) {
        throw new Error(`agy ACP request ${pending} failed: ${diagnostic(msg.error?.message, 'RPC error')}`);
      }
      const result = msg.result;
      if (pending === 1) {
        if (result?.protocolVersion !== 1) throw new Error('agy did not negotiate ACP v1');
        send({ id: ++pending, method: 'session/new', params: { cwd, mcpServers: [] } });
      } else if (pending === 2) {
        if (typeof result?.sessionId !== 'string' || !result.sessionId) throw new Error('agy returned no session ID');
        sessionId = result.sessionId;
        send({ id: ++pending, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: task }] } });
      } else {
        if (result?.stopReason !== 'end_turn') {
          throw new Error(`agy did not end_turn: ${diagnostic(result?.stopReason, 'missing stop reason')}`);
        }
        if (!answer.trim()) throw new Error('agy ended without a text answer');
        return answer;
      }
    }
    throw new Error('agy closed stdout before completing the turn');
  } catch (err) {
    signal.throwIfAborted(); // preserve the caller's cancellation/timeout reason
    throw err;
  } finally {
    signal.removeEventListener('abort', abort);
    // A stuck peer must not outlive its caller's deadline, even if it ignores
    // stdin EOF or SIGTERM. Stderr is discarded, never folded into an answer.
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    child.stdin.destroy();
    child.stdout.destroy();
  }
}
