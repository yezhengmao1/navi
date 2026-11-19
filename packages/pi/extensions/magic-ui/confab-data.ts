import { createHash, randomUUID } from "node:crypto";
import { exportContent } from "./confab-content.js";
import { redact } from "./confab-redaction.js";
import { ConfabExportError } from "./confab-errors.js";
import { CONFAB_CHUNK_BYTES, encodedLineBytes } from "./confab-limits.js";
import * as fs from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { homedir } from "node:os";
import { normalizeBackend, type Credential } from "./confab-api.js";

export const SUMMARY = "Pi compatibility export — sanitized conversation and tool records";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export const accountScope = (c: Credential) => hash(JSON.stringify([c.backend, hash(c.token)]));

export { redact } from "./confab-redaction.js";

/** Preserve real message time, falling back to the persisted entry time. Never invent epoch/now. */
function messageTimestamp(entry: any): string {
  const candidates = [entry.message?.timestamp, entry.timestamp];
  for (const value of candidates) {
    const ms = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
    if (Number.isFinite(ms) && ms > 0 && ms <= 8.64e15) return new Date(ms).toISOString();
  }
  throw new ConfabExportError("timestamp");
}

export function snapshot(branch: readonly any[], credential: Credential, identity?: string) {
  const messages = exportContent(branch, redact, credential.token).map(m => ({
    sourceId: typeof m.entry.id === "string" ? m.entry.id : undefined,
    role: m.role, content: m.content, timestamp: messageTimestamp(m.entry),
    ...(m.toolUseResult !== undefined ? { toolUseResult: m.toolUseResult } : {}),
    model: typeof m.entry.message?.model === "string" ? redact(m.entry.message.model.split(credential.token).join("[REDACTED]")).slice(0, 200) : "Pi compatibility export (unknown)",
    usage: (() => {
      const u = m.entry.message?.usage;
      const count = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0;
      return { input_tokens: count(u?.input), output_tokens: count(u?.output),
        ...(u ? { cache_read_input_tokens: count(u.cacheRead), cache_creation_input_tokens: count(u.cacheWrite) } : {}) };
    })(),
  }));
  const seed = hash(accountScope(credential) + (identity === undefined ? JSON.stringify(messages) : "pi-live-v1:" + identity));
  const ids = messages.map((m, i) => hash(seed + ":" + (m.sourceId ?? JSON.stringify([i, m]))));
  const lines = messages.map((m, i) => JSON.stringify({ type: m.role,
    uuid: ids[i], parentUuid: i ? ids[i - 1] : null, timestamp: m.timestamp,
    isSidechain: false, userType: "external", cwd: "", sessionId: "pi-compat-" + seed, version: "pi-compat-v1",
    ...(m.toolUseResult !== undefined ? { toolUseResult: m.toolUseResult } : {}),
    message: { role: m.role, content: m.content,
      ...(m.role === "assistant" ? { model: m.model, id: ids[i], type: "message",
        stop_reason: null, stop_sequence: null, usage: m.usage } : {}) } }));
  if (lines.some(line => encodedLineBytes(line) > CONFAB_CHUNK_BYTES)) throw new ConfabExportError("line_limit");
  return { externalId: "pi-compat-" + hash(accountScope(credential) + "\n" + lines.join("\n")), lines };
}

/** Own storage only; no CLI config/hook discovery. Synchronous commit prevents stale async writes. */
export class CredentialStore {
  constructor(private readonly directory = join(homedir(), ".pi-confab")) {}
  private check(create: boolean) {
    const dir = resolve(this.directory);
    const parts: string[] = [];
    for (let p = dir; p !== parse(p).root; p = dirname(p)) parts.unshift(p);
    for (const p of parts) {
      if (p === dir && create && !fs.existsSync(p)) fs.mkdirSync(p, { mode: 0o700 });
      const st = fs.lstatSync(p);
      if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("Unsafe credential directory.");
      if (p === dir && (st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o700)) throw new Error("Unsafe credential permissions.");
    }
    return join(dir, "credential.json");
  }
  load(): Credential | undefined {
    let file: string;
    try { file = this.check(false); } catch (e: any) { if (e.code === "ENOENT") return; throw e; }
    let fd: number;
    try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
    catch (e: any) { if (e.code === "ENOENT") return; throw e; }
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o600 || st.size > 16384) throw new Error("Unsafe credential file.");
      const c = JSON.parse(fs.readFileSync(fd, "utf8"));
      if (typeof c.token !== "string" || !c.token || c.token.length > 4096 || /\s|[\x00-\x1f\x7f]/.test(c.token)) throw new Error("Invalid credential.");
      return { backend: normalizeBackend(c.backend, c.allowHttp === true), token: c.token, ...(c.allowHttp === true ? { allowHttp: true } : {}) };
    } finally { fs.closeSync(fd); }
  }
  save(c: Credential) {
    const file = this.check(true);
    // Reject existing symlinks/hardlinks instead of following or replacing them.
    if (fs.existsSync(file) || (() => { try { fs.lstatSync(file); return true; } catch { return false; } })()) this.load();
    const tmp = file + "." + randomUUID();
    let fd: number | undefined;
    try {
      fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(fd, JSON.stringify({ backend: normalizeBackend(c.backend, c.allowHttp === true), token: c.token, ...(c.allowHttp === true ? { allowHttp: true } : {}) }));
      fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(tmp, file);
    } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(tmp); } catch {} }
  }
}
