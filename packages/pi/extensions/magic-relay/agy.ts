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

type AgyOptions = { model?: string; thoughtLevel?: string };

function currentValue(config: unknown, id: string): string | undefined {
  const matches = Array.isArray(config) ? config.filter(option => option?.id === id) : [];
  if (matches.length === 1 && typeof matches[0].currentValue === 'string') return matches[0].currentValue;
}

// Only render bounded identifiers, never arbitrary RPC error text or tool payloads.
function label(value: unknown) {
  return typeof value === 'string' && /^[\w.:/+ -]{1,96}$/.test(value) ? value : 'unknown';
}

type Update = { sessionUpdate: string; messageId?: string; content?: { type?: string; text?: string } };
function textChunk(update: Update) {
  if (update.content?.type !== 'text' || typeof update.content.text !== 'string') throw new Error('Invalid ACP text chunk');
  return update.content.text;
}

// Keep only the last assistant message after the last tool invocation. During
// load, first identify the turn by its full (possibly chunked) user text.
function collectAnswer(replayOf?: string) {
  let answer = '', bytes = 0, messageId: string | undefined;
  let user: string | undefined, userId: string | undefined, matched = false;
  function reset() { answer = ''; bytes = 0; messageId = undefined; }
  function finishUser() {
    if (user !== undefined) matched = user === replayOf;
    user = undefined; userId = undefined;
  }
  return {
    update(update: Update) {
      if (update.messageId !== undefined && typeof update.messageId !== 'string') throw new Error('Invalid ACP message ID');
      if (replayOf !== undefined) {
        // Out-of-band metadata is not a user/assistant turn boundary.
        switch (update.sessionUpdate) {
          case 'plan': case 'usage_update': case 'available_commands_update': case 'config_option_update':
          case 'current_mode_update': case 'session_info_update': case 'tool_call_update': return;
          case 'agent_thought_chunk': case 'agent_message_chunk': case 'user_message_chunk': case 'tool_call': break;
          default: throw new Error('Unknown ACP load update');
        }
        if (update.sessionUpdate === 'user_message_chunk') {
          if (update.messageId !== undefined && userId !== undefined && userId !== update.messageId) finishUser();
          if (matched) throw new Error('Unexpected user turn in ACP load');
          reset();
          userId = update.messageId ?? userId;
          user = (user ?? '') + textChunk(update);
          if (user.length > TASK_BYTES) throw new Error('Oversized user turn in ACP load');
          return;
        }
        finishUser();
        if (!matched) return;
      }
      switch (update.sessionUpdate) {
        case 'tool_call': reset(); break;
        case 'agent_message_chunk': {
          if (replayOf === undefined && update.content?.type !== 'text') break;
          const text = textChunk(update);
          if (update.messageId !== undefined && update.messageId !== messageId) { reset(); messageId = update.messageId; }
          bytes += Buffer.byteLength(text);
          if (bytes > ANSWER_BYTES) throw new Error(`agy answer exceeds ${ANSWER_BYTES} bytes; refusing truncated output`);
          answer += text;
          break;
        }
      }
    },
    text: () => answer,
  };
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

/** One fresh ACP v1 turn. The caller supplies the deadline. Never reprompt. */
export async function runAgy(task: string, cwd: string, signal: AbortSignal, options: AgyOptions = {}): Promise<string> {
  signal.throwIfAborted();
  if (Buffer.byteLength(task) > TASK_BYTES) throw new Error(`agy task exceeds ${TASK_BYTES} bytes`);
  const requested = [['model', options.model], ['thought_level', options.thoughtLevel]] as const;
  for (const [id, value] of requested) {
    if (value !== undefined && (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 256)) {
      throw new Error(`Invalid ACP ${id} selection`);
    }
  }
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
    const incoming = frames(child.stdout);
    let pending = 0, deniedPermissions = 0, toolCalls = 0;
    let sessionId: string | undefined;
    async function request(method: string, params: object, onUpdate?: (update: Update) => void) {
      signal.throwIfAborted();
      send({ id: ++pending, method, params });
      while (true) {
        const { value: msg, done } = await incoming.next();
        signal.throwIfAborted();
        if (done) throw new Error('agy closed stdout before completing the turn');
        if (!('method' in msg)) {
          if (msg.id !== pending) throw new Error('agy sent an unexpected response ID');
          if ('error' in msg) throw new Error(`agy ACP ${method} failed (${Number.isInteger(msg.error?.code) ? msg.error.code : 'RPC error'})`);
          if (!msg.result || typeof msg.result !== 'object' || Array.isArray(msg.result)) throw new Error('Invalid ACP result');
          if (sessionId && 'sessionId' in msg.result && msg.result.sessionId !== sessionId) throw new Error('Unexpected ACP session ID');
          return msg.result;
        }
        if ('id' in msg) {
          if (typeof msg.id !== 'number' && typeof msg.id !== 'string') throw new Error('Invalid ACP request ID');
          if (msg.method === 'session/request_permission') {
            deniedPermissions++;
            send({ id: msg.id, result: { outcome: { outcome: 'cancelled' } } });
          } else {
            send({ id: msg.id, error: { code: -32601, message: 'No such client method' } });
          }
        } else if (onUpdate && msg.method === 'session/update') {
          if (typeof msg.params?.sessionId !== 'string') throw new Error('Missing ACP update session ID');
          if (msg.params.sessionId !== sessionId) continue;
          if (typeof msg.params.update?.sessionUpdate !== 'string') throw new Error('Invalid ACP update');
          onUpdate(msg.params.update);
        }
      }
    }

    const init = await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    if (init.protocolVersion !== 1) throw new Error('agy did not negotiate ACP v1');
    const fresh = await request('session/new', { cwd, mcpServers: [] });
    if (typeof fresh.sessionId !== 'string' || !fresh.sessionId) throw new Error('agy returned no session ID');
    sessionId = fresh.sessionId;
    let config = fresh.configOptions;
    for (const [configId, value] of requested) {
      if (value === undefined) continue;
      const current = currentValue(config, configId);
      if (current === undefined) throw new Error(`Cannot verify ACP ${configId}`);
      if (current !== value) config = (await request('session/set_config_option', { sessionId, configId, value })).configOptions;
    }
    // Changing effort may reset model (or vice versa). Inspect the last full
    // snapshot, not accumulated successful acknowledgements from earlier calls.
    for (const [id, value] of requested) {
      if (value !== undefined && currentValue(config, id) !== value) throw new Error(`ACP ${id} selection not confirmed`);
    }
    const live = collectAnswer();
    const result = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: task }] }, update => {
      if (update.sessionUpdate === 'tool_call') toolCalls++;
      live.update(update);
    });
    if (result.stopReason !== 'end_turn') throw new Error(`agy did not end_turn: ${label(result.stopReason)}`);
    if (live.text().trim()) return live.text();

    let recovery = 'load unavailable';
    if (init.agentCapabilities?.loadSession === true) {
      const replay = collectAnswer(task);
      try {
        const loaded = await request('session/load', { sessionId, cwd, mcpServers: [] }, replay.update);
        if (loaded.sessionId === sessionId && replay.text().trim()) return replay.text();
        recovery = 'load did not confirm an answer';
      } catch {
        signal.throwIfAborted();
        recovery = 'load failed';
      }
    }
    const blocked = deniedPermissions ? `；观察到 ${deniedPermissions} 次权限请求被拒` : '';
    throw new Error(`agy 已结束，但没有可验收的正文${blocked}。未重新派发。` +
      `\n${recovery}; stopReason=end_turn, toolCalls=${toolCalls}, deniedPermissions=${deniedPermissions}, model=${label(currentValue(config, 'model'))}, thought_level=${label(currentValue(config, 'thought_level'))}`);
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
