import { constants } from "node:fs";
import { mkdir, open, opendir, realpath, stat, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";

export type ExternalSession = SessionInfo & {
  source: "codex-external"; sourceId: string; sourceDirectory: string; sourceName?: string; externalId: string;
};
export interface SourceDiagnostic {
  type: "codex"; directory: string; name?: string;
  entries: number; files: number; bytes: number; invalid: number; errors: number;
  skippedLinks: number; indexed: number; assigned: number; status: string[];
}
export interface ScanResult { sessions: ExternalSession[]; warnings: string[]; sources: SourceDiagnostic[] }

export const LIMITS = { sources: 64, entries: 20_000, files: 2000, depth: 16,
  fileBytes: 256 * 1024, totalBytes: 32 * 1024 * 1024, registryBytes: 8192 };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export const sourceId = (directory: string) => `codex-${hash(directory)}`;
export const cleanMetadata = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 512);

/** Literal argument, not a shell expression. The entire remainder is one path. */
export function directoryArgument(argument: string, cwd: string): string {
  let path = argument.trim();
  if (path.startsWith('"') || path.startsWith("'")) {
    if (path.at(-1) !== path[0] || path.length < 2) throw new Error("路径引号不匹配");
    path = path.slice(1, -1);
  }
  if (!path || /[\x00-\x1f\x7f-\x9f]/.test(path)) throw new Error("用法：/session add codex <path>");
  if (path === "~" || path.startsWith("~/")) path = homedir() + path.slice(1);
  return resolve(cwd, path);
}

export function validateSourceName(name: string): string {
  if (!name.trim() || name.length > 128 || /[\x00-\x1f\x7f-\x9f]/.test(name))
    throw new Error("来源名称必须为 1–128 个字符且不含控制字符");
  return name;
}

/** Literal quoted tokens: no shell expansion or escape processing. */
export function parseSourceArguments(text: string): { path: string; name?: string } {
  const tokens: string[] = [];
  let token = "", quote = "", started = false;
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = ""; else token += char;
      started = true;
    } else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (/\s/.test(char)) {
      if (started) tokens.push(token);
      token = ""; started = false;
    } else { token += char; started = true; }
  }
  if (quote) throw new Error("路径或名称引号不匹配");
  if (started) tokens.push(token);
  let path: string | undefined, name: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const value = tokens[i];
    if (value === "--name") {
      if (name !== undefined) throw new Error("重复参数 --name");
      const next = tokens[++i];
      if (next === undefined || next.startsWith("--")) throw new Error("--name 缺少名称");
      name = validateSourceName(next);
    } else if (value.startsWith("--")) throw new Error(`未知参数 ${value}`);
    else if (path !== undefined) throw new Error("只允许一个目录路径；含空格请加引号");
    else path = value;
  }
  if (!path) throw new Error("用法：/session add codex <path> [--name <name>]");
  return { path, name };
}

/** No symlink or special-file reads, and no unbounded readFile allocations. */
async function readPrefix(path: string, bytes: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("不是普通文件");
    const buffer = Buffer.alloc(Math.min(bytes, info.size));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return { text: buffer.subarray(0, offset).toString("utf8"), info, bytes: offset };
  } finally { await file.close(); }
}

export class ExternalSessionSources {
  constructor(private registry: string) {}

  async directories(): Promise<string[]> {
    return (await this.list()).map(source => source.directory);
  }

  async list(): Promise<{ directory: string; name?: string }[]> {
    let dir;
    try { dir = await opendir(this.registry); }
    catch (error: any) { if (error.code === "ENOENT") return []; throw error; }
    const paths = new Map<string, { directory: string; name?: string }>();
    let entries = 0;
    for await (const entry of dir) {
      if (++entries > LIMITS.sources * 2) throw new Error("外部会话来源配置过多");
      if (!entry.isFile() || !/^codex-[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      const { text, info } = await readPrefix(join(this.registry, entry.name), LIMITS.registryBytes);
      if (info.size > LIMITS.registryBytes) throw new Error("外部会话来源配置过大");
      const data = JSON.parse(text);
      if (data.version !== 1 || data.type !== "codex" || typeof data.directory !== "string"
        || !isAbsolute(data.directory) || /[\x00-\x1f\x7f-\x9f]/.test(data.directory)
        || `${sourceId(data.directory)}.json` !== entry.name) throw new Error("外部会话来源配置无效或 ID 冲突");
      if (data.name !== undefined && typeof data.name !== "string") throw new Error("来源名称无效");
      if (data.name !== undefined) validateSourceName(data.name);
      paths.set(data.directory, { directory: data.directory, ...(data.name !== undefined ? { name: data.name } : {}) });
      if (paths.size > LIMITS.sources) throw new Error("外部会话来源过多");
    }
    return [...paths.values()].sort((a, b) => a.directory < b.directory ? -1 : a.directory > b.directory ? 1 : 0);
  }

  async add(argument: string, cwd: string, name?: string) {
    if (name !== undefined) validateSourceName(name);
    const directory = await realpath(directoryArgument(argument, cwd));
    if (/[\x00-\x1f\x7f-\x9f]/.test(directory)) throw new Error("目录路径包含控制字符");
    if (!(await stat(directory)).isDirectory()) throw new Error("请提供目录，而不是文件");
    // Validate traversal permissions before persisting even an empty source.
    const handle = await opendir(directory); await handle.close();
    const paths = await this.directories();
    if (paths.includes(directory) && name === undefined) return { directory, added: false };
    if (!paths.includes(directory) && paths.length >= LIMITS.sources) throw new Error("最多注册 64 个外部会话目录");
    const data = JSON.stringify({ version: 1, type: "codex", directory, name });
    if (Buffer.byteLength(data) > LIMITS.registryBytes) throw new Error("目录路径过长");
    await mkdir(this.registry, { recursive: true, mode: 0o700 });
    // Each canonical source owns a separate exclusive file: concurrent additions
    // cannot overwrite another source or silently lose a read-modify-write update.
    const path = join(this.registry, `${sourceId(directory)}.json`);
    let file;
    try { file = await open(path, "wx", 0o600); }
    catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      if (!(await this.directories()).includes(directory)) throw new Error("外部来源 ID 冲突");
      if (name === undefined) return { directory, added: false };
      // Replace only this canonical source, atomically; readers never see partial JSON.
      const temporary = join(this.registry, `.source-${randomUUID()}.tmp`);
      try {
        const update = await open(temporary, "wx", 0o600);
        try { await update.writeFile(data); } finally { await update.close(); }
        await rename(temporary, path);
      } finally { await unlink(temporary).catch(() => {}); }
      return { directory, name, added: false, updated: true };
    }
    try { await file.writeFile(data); } finally { await file.close(); }
    return { directory, name, added: true };
  }

  /** Resolve only registered IDs. Never accept a filesystem path for deletion. */
  async remove(id: string): Promise<boolean> {
    const source = (await this.list()).find(source => sourceId(source.directory) === id);
    if (!source) return false;
    try { await unlink(join(this.registry, `${sourceId(source.directory)}.json`)); }
    catch (error: any) { if (error.code === "ENOENT") return false; throw error; }
    return true;
  }

  async scan(): Promise<ScanResult> {
    const sessions: ExternalSession[] = [];
    const warnings = new Set<string>();
    const warn = (message: string) => warnings.add(message);
    let sources: { directory: string; name?: string }[];
    try { sources = await this.list(); }
    catch { return { sessions, sources: [], warnings: ["外部会话来源配置读取失败；请检查 magic-ui/session-sources 配置"] }; }
    const diagnostics: SourceDiagnostic[] = sources.map(source => ({ ...source, type: "codex",
      entries: 0, files: 0, bytes: 0, invalid: 0, errors: 0, skippedLinks: 0,
      indexed: 0, assigned: 0, status: [] }));
    let current: SourceDiagnostic;
    const mark = (status: string) => { if (!current.status.includes(status)) current.status.push(status); };
    const failure = (error: any) => {
      current.errors++;
      mark(["ENOENT", "EACCES", "EPERM", "ENOTDIR", "ELOOP"].includes(error?.code) ? error.code : "read-error");
    };
    const visited = new Set<string>();
    let entries = 0, files = 0, bytes = 0;
    const exhausted = () => entries >= LIMITS.entries || files >= LIMITS.files || bytes >= LIMITS.totalBytes;
    const visit = async (directory: string, root: string, depth: number) => {
      if (exhausted()) { mark("limit"); warn("外部会话扫描达到数量/字节上限；请注册更小的目录"); return; }
      if (depth > LIMITS.depth) { mark("depth-limit"); warn("外部会话扫描达到目录深度上限"); return; }
      // Don't follow symlink directories (including sources replaced since add).
      if (await realpath(directory) !== directory) { current.skippedLinks++; mark("symlink-skipped"); return; }
      if (visited.has(directory)) { mark("overlap"); return; }
      visited.add(directory);
      const dir = await opendir(directory);
      for await (const entry of dir) {
        if (exhausted()) { mark("limit"); warn("外部会话扫描达到数量/字节上限；请注册更小的目录"); break; }
        entries++; current.entries++;
        const path = join(directory, entry.name);
        try {
          if (entry.isDirectory()) await visit(path, root, depth + 1);
          else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
            files++; current.files++;
            const data = await readPrefix(path, Math.min(LIMITS.fileBytes, LIMITS.totalBytes - bytes));
            bytes += data.bytes; current.bytes += data.bytes;
            // Only complete lines from the bounded prefix. A final record without
            // newline is usable only when the entire file fits in that prefix.
            const lines = data.text.split("\n");
            if (data.bytes < data.info.size) lines.pop();
            let meta: any;
            for (const line of lines) {
              try { const row = JSON.parse(line); if (row.type === "session_meta") { meta = row.payload; break; } } catch { /* partial/malformed record */ }
            }
            if (data.bytes < data.info.size && !meta) { mark("prefix-limit"); warn("部分外部会话元数据超出读取上限"); }
            if (typeof meta?.id !== "string" || !meta.id || meta.id.length > 512) { current.invalid++; continue; }
            current.assigned++;
            const created = new Date(typeof meta.timestamp === "string" ? meta.timestamp : NaN);
            sessions.push({ id: `codex-${hash(path)}`, path, source: "codex-external",
              sourceId: sourceId(root), sourceDirectory: root, sourceName: sources.find(source => source.directory === root)?.name, externalId: cleanMetadata(meta.id),
              name: cleanMetadata(meta.id),
              cwd: cleanMetadata(typeof meta.cwd === "string" ? meta.cwd : ""),
              created: Number.isFinite(created.getTime()) ? created : data.info.mtime,
              modified: data.info.mtime, messageCount: 0, firstMessage: "", allMessagesText: "" });
          } else if (entry.isSymbolicLink()) current.skippedLinks++;
        } catch (error) { failure(error); warn("部分外部会话文件/子目录不可读取，已跳过"); }
      }
    };
    for (const diagnostic of diagnostics) {
      current = diagnostic;
      try { await visit(current.directory, current.directory, 0); }
      catch (error) { failure(error); warn("部分外部会话来源目录不可访问，已跳过"); }
    }
    for (const diagnostic of diagnostics) {
      diagnostic.indexed = sessions.filter(session => session.path.startsWith(diagnostic.directory.endsWith("/")
        ? diagnostic.directory : diagnostic.directory + "/")).length;
      if (!diagnostic.status.length) diagnostic.status.push(diagnostic.invalid || diagnostic.errors ? "partial" : "ok");
    }
    return { sessions, warnings: [...warnings], sources: diagnostics };
  }
}

/** Source metadata/counts only: never include session IDs, titles, cwd or messages. */
export function formatSourceList(result: ScanResult): string {
  const lines = [`外部会话来源：${result.sources.length} · 已索引 ${result.sessions.length} 个会话（按文件去重）`];
  for (const source of result.sources) {
    lines.push(`${source.type} · ${source.name ? cleanMetadata(source.name) : "（无别名）"} · ${source.status.join(", ")}`,
      `  来源 ID：${sourceId(source.directory)}`,
      `  目录：${source.directory.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")}`,
      `  目录内已索引=${source.indexed} · 归属本来源=${source.assigned} · 本次扫描 JSONL=${source.files} · 目录项=${source.entries}`,
      `  读取字节=${source.bytes} · 无有效元数据=${source.invalid} · 读取错误=${source.errors} · 跳过链接=${source.skippedLinks}`);
  }
  if (!result.sources.length && !result.warnings.length) lines.push("尚未注册；使用 /session add codex <path> [--name <name>]");
  lines.push(...result.warnings.map(warning => `警告：${warning}`),
    "只读有界扫描；计数不是目录总量。overlap=已由其他来源扫描，目录内计数含去重后的会话；limit/prefix-limit/depth-limit=结果可能不完整。",
    "仅列外部来源；Pi 原生会话仍自动检索。用 $别名 或 /mention 别名 筛选；空 $ 最多显示 30 项。");
  return lines.join("\n");
}

export function externalLabel(session: SessionInfo): string {
  const external = session as ExternalSession;
  return external.source === "codex-external"
    ? (external.sourceName ? `Codex · ${cleanMetadata(external.sourceName)}` : "Codex/external") : "";
}

export function externalIdentity(session: SessionInfo): string {
  const external = session as ExternalSession;
  return external.source === "codex-external"
    ? `[${externalLabel(session)} · Codex/external · ${cleanMetadata(external.sourceDirectory)} · ${external.sourceId}]` : "";
}
