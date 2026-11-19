import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";

export type SyncRecord = { externalId: string; hashes: string[]; title?: string };
const MAX_BYTES = 64 * 1024 * 1024;
const invalid = () => new Error("Invalid sync state.");
const unsafe = () => new Error("Unsafe sync state storage.");
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";

/** Copy only registry metadata; never serialize arbitrary caller properties. */
function validate(value: unknown): SyncRecord[] {
  if (!Array.isArray(value) || value.length > 100) throw invalid();
  const ids = new Set<string>();
  return Array.from(value, record => {
    if (!record || typeof record !== "object" || Array.isArray(record)
      || Object.keys(record).some(k => !["externalId", "hashes", "title"].includes(k))
      || typeof record.externalId !== "string" || !/^pi-live-[a-f0-9]{64}$/.test(record.externalId)
      || !Array.isArray(record.hashes) || record.hashes.length > 20000) throw invalid();
    if (ids.has(record.externalId)) throw invalid();
    ids.add(record.externalId);
    const hashes = Array.from(record.hashes, h => {
      if (typeof h !== "string" || !/^[a-fA-F0-9]{64}$/.test(h)) throw invalid();
      return h;
    });
    const title = record.title;
    if (title !== undefined && (typeof title !== "string" || Buffer.byteLength(title) > 240
      || /[\p{Cc}\p{Cf}]/u.test(title))) throw invalid();
    return { externalId: record.externalId, hashes, ...(title !== undefined ? { title } : {}) };
  });
}

function fileStat(st: fs.Stats) {
  if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.()
    || (st.mode & 0o7777) !== 0o600 || st.size > MAX_BYTES) throw unsafe();
}
function same(a: fs.Stats, b: fs.Stats) { return a.dev === b.dev && a.ino === b.ino; }

/** Synchronous, private per-account/session registry. Construction is filesystem-free.
 * Like CredentialStore, assumes ancestors are not concurrently renamed by the owner.
 */
export class SyncStateStore {
  constructor(private readonly directory = join(homedir(), ".pi-confab", "sync-state")) {}

  private check(create: boolean): string {
    const dir = resolve(this.directory);
    const parts: string[] = [];
    for (let p = dir; ; p = dirname(p)) {
      parts.unshift(p);
      if (p === parse(p).root) break;
    }
    for (const p of parts) {
      let st: fs.Stats;
      try { st = fs.lstatSync(p); } catch (e) {
        if (!create || !missing(e)) throw e;
        fs.mkdirSync(p, { mode: 0o700 });
        st = fs.lstatSync(p);
      }
      if (!st.isDirectory() || st.isSymbolicLink()) throw unsafe();
      if (p === dir && (st.uid !== process.getuid?.() || (st.mode & 0o7777) !== 0o700)) throw unsafe();
    }
    return dir;
  }

  private filename(scope: string): string {
    if (typeof scope !== "string") throw invalid();
    return createHash("sha256").update(scope).digest("hex") + ".json";
  }

  private read(file: string): { records: SyncRecord[]; stat: fs.Stats } | undefined {
    let before: fs.Stats;
    try { before = fs.lstatSync(file); } catch (e) { if (missing(e)) return; throw e; }
    fileStat(before); // Includes dangling symlinks and hardlinks.
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const st = fs.fstatSync(fd);
      fileStat(st);
      if (!same(before, st)) throw unsafe();
      // Never let a concurrently growing file cause an unbounded readFile allocation.
      const buffer = Buffer.alloc(st.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const n = fs.readSync(fd, buffer, length, buffer.length - length, null);
        if (!n) break;
        length += n;
      }
      const after = fs.fstatSync(fd);
      fileStat(after);
      if (length !== st.size || after.size !== st.size || after.mtimeMs !== st.mtimeMs) throw unsafe();
      let value: unknown;
      try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length))); }
      catch { throw invalid(); } // Do not expose persisted text in parse errors.
      return { records: validate(value), stat: after };
    } finally { fs.closeSync(fd); }
  }

  /** Cross-process exclusive lease. A crash leaves a fail-closed lock for manual recovery. */
  lock(scope: string): () => void {
    const file = join(this.check(true), this.filename(scope) + ".lock");
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    const stat = fs.fstatSync(fd);
    fs.closeSync(fd);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = fs.lstatSync(file);
      if (!same(stat, current) || !current.isFile() || current.nlink !== 1) throw unsafe();
      fs.unlinkSync(file);
    };
  }

  load(scope: string): SyncRecord[] {
    const name = this.filename(scope);
    let dir: string;
    try { dir = this.check(false); } catch (e) { if (missing(e)) return []; throw e; }
    return this.read(join(dir, name))?.records ?? [];
  }

  save(scope: string, records: SyncRecord[]): void {
    const name = this.filename(scope);
    const clean = validate(records);
    const chunks: string[] = [];
    let bytes = 2;
    for (const record of clean) {
      const chunk = JSON.stringify(record);
      bytes += Buffer.byteLength(chunk) + (chunks.length ? 1 : 0);
      if (bytes > MAX_BYTES) throw invalid();
      chunks.push(chunk);
    }
    const data = "[" + chunks.join(",") + "]";
    const dir = this.check(true);
    const directoryStat = fs.lstatSync(dir);
    const file = join(dir, name);
    const previous = this.read(file); // Never silently overwrite corrupt or unsafe state.
    const tmp = file + "." + randomUUID() + ".tmp";
    let fd: number | undefined;
    let created = false;
    try {
      fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      created = true;
      fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      if (this.check(false) !== dir || !same(directoryStat, fs.lstatSync(dir))) throw unsafe();
      if (previous) {
        const current = this.read(file);
        if (!current || !same(previous.stat, current.stat)
          || current.stat.mtimeMs !== previous.stat.mtimeMs || current.stat.size !== previous.stat.size) throw unsafe();
        fs.renameSync(tmp, file);
      } else {
        // Atomic publication without clobbering a file created since the initial check.
        fs.linkSync(tmp, file);
        fs.unlinkSync(tmp);
      }
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (created) { try { fs.unlinkSync(tmp); } catch (e) { if (!missing(e)) throw e; } }
    }
  }
}
