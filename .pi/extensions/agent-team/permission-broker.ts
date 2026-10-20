import net from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export interface Approval {
  id: string; member: string; session: string; source: 'safety-guard' | 'extension-confirm'; risk: 'low' | 'medium' | 'high';
  toolCallId: string; toolName: string; input: unknown; title: string; body: string;
}
export type Decision = { allow: boolean; feedback?: string };
export interface ApprovalConfig { socket: string; token: string; member: string; activeTools?: string[] }
const LIMIT = 128 * 1024;
export const APPROVAL_TIMEOUT = 5 * 60 * 1000;

/** Local coordination channel, not a sandbox against other processes of the same OS user. */
export class PermissionBroker {
  readonly directory: string;
  readonly socket: string;
  private server?: net.Server;
  private members = new Map<string, string>();
  private sockets = new Map<net.Socket, { member?: string; abort: AbortController }>();
  private seen = new Set<string>();
  private closed = false;
  constructor(directory: string | undefined,
    private decide: (request: Approval, signal: AbortSignal) => Promise<Decision>,
    private validate: (request: Approval, signal: AbortSignal) => Promise<void>) {
    if (process.platform === 'win32') throw new Error('Managed team approvals currently require Unix-domain sockets');
    this.directory = directory ?? mkdtempSync(join(tmpdir(), 'pi-team-'));
    // Persisted session data cannot redirect cleanup/listening into an arbitrary directory.
    const stat = lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || dirname(realpathSync(this.directory)) !== realpathSync(tmpdir()) ||
        !/^pi-team-[A-Za-z0-9]+$/.test(basename(this.directory)) || (stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid())) throw new Error('Invalid/private team approval directory');
    this.socket = join(this.directory, 'approval.sock');
  }
  async start() {
    if (this.closed) throw new Error('Approval broker closed');
    if (this.server) return;
    const server = net.createServer(socket => this.accept(socket)); this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { server.removeListener('error', failed); server.removeListener('close', interrupted); };
        const failed = (error: Error) => { cleanup(); reject(error); };
        const interrupted = () => failed(new Error('Approval broker closed during startup'));
        server.once('error', failed); server.once('close', interrupted);
        server.listen(this.socket, () => { cleanup(); resolve(); });
      });
    } catch (error) { this.server = undefined; throw error; }
    server.on('error', () => { for (const socket of this.sockets.keys()) socket.destroy(); });
    if (this.closed) {
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (this.server === server) this.server = undefined;
      throw new Error('Approval broker closed');
    }
    chmodSync(this.socket, 0o600); server.unref();
  }
  register(member: string, profile?: { activeTools?: string[] }): string {
    if (!/^[a-z][a-z0-9_-]{0,19}$/.test(member)) throw new Error('Invalid approval member');
    const path = join(this.directory, `${member}.json`);
    let config: ApprovalConfig;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('Unsafe member approval config');
      config = JSON.parse(readFileSync(path, 'utf8'));
      if (config.member !== member || config.socket !== this.socket || !/^[a-f0-9]{64}$/.test(config.token)) throw new Error('Invalid member approval config');
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      config = { socket: this.socket, member, token: randomBytes(32).toString('hex') };
      writeFileSync(path, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
    }
    if (profile?.activeTools) {
      config.activeTools = [...profile.activeTools];
      writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
    }
    this.members.set(member, config.token);
    return path;
  }
  cancelMember(member: string) {
    for (const [socket, request] of this.sockets) if (request.member === member) { request.abort.abort(); socket.destroy(); }
  }
  async close() {
    this.closed = true;
    for (const [socket, request] of this.sockets) { request.abort.abort(); socket.destroy(); }
    const server = this.server; this.server = undefined;
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  }
  private accept(socket: net.Socket) {
    if (this.closed || this.sockets.size >= 32) { socket.destroy(); return; }
    socket.unref(); socket.setEncoding('utf8');
    const pending = { abort: new AbortController(), member: undefined as string | undefined };
    this.sockets.set(socket, pending);
    const timer = setTimeout(() => { pending.abort.abort(); socket.destroy(); }, APPROVAL_TIMEOUT); timer.unref();
    socket.on('error', () => {});
    socket.on('close', () => { clearTimeout(timer); pending.abort.abort(); this.sockets.delete(socket); });
    let raw = '', bytes = 0, received = false;
    socket.on('data', chunk => {
      if (received) { socket.destroy(); return; }
      bytes += Buffer.byteLength(chunk);
      if (bytes > LIMIT) { socket.destroy(); return; }
      raw += chunk.toString('utf8');
      if (!raw.includes('\n')) return;
      received = true;
      void (async () => {
        let id = '';
        try {
          const input = JSON.parse(raw.trim()); id = input.id;
          if (!input || typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(id) ||
              !this.members.has(input.member) || input.token !== this.members.get(input.member) || !['safety-guard', 'extension-confirm'].includes(input.source) ||
              !['low', 'medium', 'high'].includes(input.risk) ||
              !['session', 'toolCallId', 'toolName', 'title', 'body'].every(k => typeof input[k] === 'string' && input[k].length <= 64000))
            throw new Error('Invalid approval request');
          const key = `${input.member}:${id}`;
          if (this.seen.has(key) || this.seen.size >= 10000) throw new Error('Replayed request or approval limit reached');
          this.seen.add(key); pending.member = input.member;
          const { token: _token, ...request } = input;
          await this.validate(request, pending.abort.signal);
          const decision = await this.decide(request, pending.abort.signal);
          // An approval is valid only for the same live member/session at delivery time.
          await this.validate(request, pending.abort.signal);
          if (pending.abort.signal.aborted) throw new Error('Approval cancelled');
          socket.end(JSON.stringify({ id, allow: decision.allow === true, feedback: decision.feedback }) + '\n');
        } catch (error) {
          if (!socket.destroyed) socket.end(JSON.stringify({ id, allow: false, feedback: String(error).slice(0, 1000) }) + '\n');
        }
      })();
    });
  }
}

export async function requestApproval(config: ApprovalConfig, request: Omit<Approval, 'id' | 'member'>,
  signal?: AbortSignal, timeout = APPROVAL_TIMEOUT): Promise<Decision> {
  if (signal?.aborted) return { allow: false, feedback: 'Approval cancelled' };
  return new Promise(resolve => {
    const id = randomUUID();
    const socket = net.createConnection(config.socket); socket.setEncoding('utf8');
    let done = false, raw = '', bytes = 0;
    const finish = (decision: Decision) => {
      if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel); socket.destroy(); resolve(decision);
    };
    const cancel = () => finish({ allow: false, feedback: 'Approval cancelled' });
    const timer = setTimeout(() => finish({ allow: false, feedback: 'Lead approval timed out; not approved' }), timeout);
    timer.unref();
    signal?.addEventListener('abort', cancel, { once: true });
    socket.on('connect', () => {
      if (signal?.aborted) { cancel(); return; }
      const data = JSON.stringify({ ...request, id, member: config.member, token: config.token }) + '\n';
      if (Buffer.byteLength(data) > LIMIT) { finish({ allow: false, feedback: 'Approval request too large; not approved' }); return; }
      socket.write(data);
    });
    socket.on('error', () => finish({ allow: false, feedback: 'Lead approval channel unavailable; not approved' }));
    socket.on('close', () => finish({ allow: false, feedback: 'Lead disconnected; not approved' }));
    socket.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > LIMIT) { finish({ allow: false, feedback: 'Invalid lead response' }); return; }
      raw += chunk.toString('utf8');
      if (!raw.includes('\n')) return;
      try {
        const response = JSON.parse(raw.trim());
        finish(response.id === id && !signal?.aborted ? { allow: response.allow === true, feedback: response.feedback } : { allow: false, feedback: 'Mismatched/cancelled approval' });
      } catch { finish({ allow: false, feedback: 'Invalid lead response' }); }
    });
  });
}
