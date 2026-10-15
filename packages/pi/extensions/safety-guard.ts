/**
 * Safety Guard
 *
 * Reviews heavy and destructive commands and sensitive file writes, and
 * confirms /clear session resets, using a shared confirmation dialog that
 * can return rejection feedback to the agent.
 *
 *   1. Deletion commands require confirmation, with absolute target paths
 *      where they can be determined without executing shell expressions.
 *
 *   2. `mv` must be safe, judged by an AI auto-reviewer. Each mv command is
 *      sent to a lightweight model call that rates the risk of the move:
 *        - low    -> allowed, no prompt
 *        - medium -> user is asked to confirm
 *        - high   -> user is asked to confirm (stronger warning)
 *      A few obviously-unsafe moves (force overwrite, moving a directory into
 *      its own descendant, moving onto itself) are blocked statically before
 *      the reviewer runs, so they never depend on a model. In non-interactive
 *      modes (no UI) anything above low risk is blocked.
 *
 * The reviewer uses the session's active model via ctx.modelRegistry.complete()
 * so it inherits the configured provider and auth. If the reviewer call fails
 * for any reason, the move is treated as medium risk and prompted (or blocked
 * without a UI) rather than silently allowed.
 */

import { uuidv7 } from "@earendil-works/pi-ai";
import { homedir } from "node:os";
import { AsyncLocalStorage } from "node:async_hooks";
import { isAbsolute } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext, Theme, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, type Focusable, matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { renderSelectionCard } from "./magic-ui/editor-footer.js";

// --- per-tool safety timing (UI metadata, never model context) -------------
type GuardPhase = "review" | "confirm";
export interface GuardTiming {
	toolCallId: string;
	reviewMs?: number;
	waitMs?: number;
	phase?: GuardPhase;
	phaseStarted?: number;
	status?: "passed" | "blocked" | "interrupted";
}
const guardScope = new AsyncLocalStorage<{
	measure<T>(phase: GuardPhase, work: () => Promise<T>): Promise<T>;
}>();

/** Async-local scope keeps parallel tool calls and confirmation dialogs isolated. */
export async function trackGuard<T extends { block?: boolean } | undefined>(
	toolCallId: string, work: () => Promise<T>, publish: (data: GuardTiming) => void,
	persist: (data: GuardTiming) => void, now = () => performance.now(), aborted = () => false,
): Promise<T> {
	const timing: GuardTiming = { toolCallId };
	let active = false;
	const emit = () => { if (active) publish({ ...timing }); };
	return guardScope.run({
		async measure(phase, run) {
			active = true;
			const field = phase === "review" ? "reviewMs" : "waitMs";
			timing[field] ??= 0;
			timing.phase = phase; timing.phaseStarted = now(); emit();
			try { return await run(); }
			finally {
				timing[field]! += Math.max(0, now() - timing.phaseStarted!);
				delete timing.phase; delete timing.phaseStarted; emit();
			}
		},
	}, async () => {
		try {
			const result = await work();
			timing.status = aborted() ? "interrupted" : result?.block ? "blocked" : "passed";
			return result;
		} catch (error) { timing.status = "interrupted"; throw error; }
		finally { if (active) { emit(); persist({ ...timing }); } }
	});
}

export function guardPhase<T>(phase: GuardPhase, work: () => Promise<T>): Promise<T> {
	return guardScope.getStore()?.measure(phase, work) ?? work();
}

// --- confirmation with optional feedback ---------------------------------

export type ConfirmResult = { allow: true } | { allow: false; feedback?: string };

type Stop = "yes" | "no" | "feedback";

export class ConfirmFeedbackDialog implements Focusable {
	focused = false;
	private stop: Stop = "no";
	private feedback = "";
	private cursor = 0;

	constructor(
		private theme: Theme,
		private ui: ExtensionUIContext,
		private done: (result: ConfirmResult) => void,
		private title: string,
		private body: string,
		private yesLabel = "✅ 允许",
		private noLabel = "❌ 拒绝",
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.done({ allow: false, feedback: undefined });
			return;
		}

		if (matchesKey(data, "up") || matchesKey(data, "shift+tab")) {
			this.stop = this.stop === "yes" ? "feedback" : this.stop === "no" ? "yes" : "no";
			return;
		}
		if (matchesKey(data, "down") || matchesKey(data, "tab")) {
			this.stop = this.stop === "yes" ? "no" : this.stop === "no" ? "feedback" : "yes";
			return;
		}

		// Left/right also move between the two buttons for convenience.
		if (this.stop !== "feedback" && matchesKey(data, "left")) {
			this.stop = this.stop === "yes" ? "no" : "yes";
			return;
		}
		if (this.stop !== "feedback" && matchesKey(data, "right")) {
			this.stop = this.stop === "yes" ? "no" : "yes";
			return;
		}

		if (matchesKey(data, "return") || matchesKey(data, "enter")) {
			if (this.stop === "yes") {
				this.done({ allow: true });
			} else {
				this.done({ allow: false, feedback: this.feedback.trim() || undefined });
			}
			return;
		}

		// Editing the feedback field.
		if (this.stop === "feedback") {
			if (matchesKey(data, "backspace")) {
				if (this.cursor > 0) {
					this.feedback = this.feedback.slice(0, this.cursor - 1) + this.feedback.slice(this.cursor);
					this.cursor--;
				}
				return;
			}
			if (matchesKey(data, "delete")) {
				if (this.cursor < this.feedback.length) {
					this.feedback = this.feedback.slice(0, this.cursor) + this.feedback.slice(this.cursor + 1);
				}
				return;
			}
			if (matchesKey(data, "left")) {
				this.cursor = Math.max(0, this.cursor - 1);
				return;
			}
			if (matchesKey(data, "right")) {
				this.cursor = Math.min(this.feedback.length, this.cursor + 1);
				return;
			}
			// Ignore other control sequences; accept single printable chars.
			if (data.length === 1 && data.charCodeAt(0) >= 32) {
				this.feedback = this.feedback.slice(0, this.cursor) + data + this.feedback.slice(this.cursor);
				this.cursor++;
			}
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const bodyWidth = Math.max(1, width >= 6 ? width - 4 : width);
		const bodyLines = this.body.split("\n").flatMap(line =>
			wrapTextWithAnsi(th.fg("text", line), bodyWidth));
		const fbSelected = this.stop === "feedback";
		let inputDisplay = this.feedback;
		if (fbSelected) {
			const before = inputDisplay.slice(0, this.cursor);
			const cursorChar = this.cursor < inputDisplay.length ? inputDisplay[this.cursor] : " ";
			const after = inputDisplay.slice(this.cursor + 1);
			const marker = this.focused ? CURSOR_MARKER : "";
			inputDisplay = `${before}${marker}\x1b[7m${cursorChar}\x1b[27m${after}`;
		}
		const placeholder = this.feedback.length === 0 ? th.fg("dim", "(可选，回车拒绝时提交)") : "";
		const inputPart = this.feedback.length > 0 || fbSelected ? inputDisplay : placeholder;
		const plainLabel = (label: string) => label.replace(/^[✅❌🧹]\s*/u, "");
		return renderSelectionCard({
			width, theme: th, title: plainLabel(this.title), bodyLines,
			items: [
				{ label: plainLabel(this.yesLabel), group: "操作" },
				{ label: plainLabel(this.noLabel) },
				{ label: `反馈：${inputPart}`, group: "可选反馈（拒绝时提交）" },
			],
			cursor: this.stop === "yes" ? 0 : this.stop === "no" ? 1 : 2,
			hints: ["↑↓/Tab 移动 · 反馈行输入文字", "Enter 确认当前操作 · Esc 拒绝"],
		});
	}

	invalidate(): void {}
	dispose(): void {}
}

/**
 * Show the combined confirm-with-feedback dialog. Falls back to a plain
 * confirm (no feedback) when there is no UI.
 *
 * Takes the ExtensionContext (not just ctx.ui) so callers can pass `ctx`
 * directly from an event handler, matching how the built-in confirm helpers
 * are used elsewhere.
 */
export async function confirmOrFeedback(
	ctx: ExtensionContext,
	title: string,
	body: string,
	labels?: { yes?: string; no?: string },
): Promise<ConfirmResult> {
	const ui: ExtensionUIContext = ctx.ui;
	if (!ctx.hasUI) return { allow: false, feedback: undefined };

	return guardPhase("confirm", () => ui.custom<ConfirmResult>(
		(_tui, theme, _kb, done) =>
			new ConfirmFeedbackDialog(theme, ui, done, title, body, labels?.yes, labels?.no),
	));
}

// --- static heaviness detection -------------------------------------------

const ROOT_PATHS = new Set(["/", "/home", "$HOME", "~"]);
const RECURSIVE_WALKERS = new Set(["du", "grep", "egrep", "fgrep", "rg", "ag"]);
const ARCHIVE_CMDS = new Set(["tar", "zip", "rsync"]);
const SEARCH_CMDS = new Set(["locate", "mlocate", "plocate"]);

function isWrapper(word: string): boolean {
	return /^(sudo|env|time|nohup|nice|ionice|stdbuf|command)$/.test(word);
}

function commandWord(tokens: string[]): { cmd: string; args: string[] } | null {
	let i = 0;
	while (i < tokens.length && isWrapper(tokens[i])) {
		if (tokens[i] === "sudo") {
			i++;
			while (i < tokens.length && tokens[i].startsWith("-")) {
				const flag = tokens[i];
				i++;
				if (/^-[u g p]$/.test(flag) && i < tokens.length) i++;
			}
			continue;
		}
		if (tokens[i] === "env") {
			i++;
			while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
			continue;
		}
		i++;
		while (i < tokens.length && tokens[i].startsWith("-")) i++;
	}
	if (i >= tokens.length) return null;
	const base = tokens[i].split("/").pop() ?? tokens[i];
	return { cmd: base, args: tokens.slice(i + 1) };
}

function hasDepthLimit(args: string[]): boolean {
	return args.some((a) => /^-{1,2}max[/-]depth(=.+)?$/.test(a));
}

function hasScopeLimit(args: string[]): boolean {
	return args.some((a) =>
		/^-{1,2}(name|path|regex|iname|ipath|size|mtime|atime|ctime|type|xdev|prune|exclude|exclude-from|include|iglob|glob|max-count|head|l|t|iregex)$/.test(a),
	);
}

function positionalArgs(args: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--") { out.push(...args.slice(i + 1)); break; }
		if (a.startsWith("-")) {
			if (/^-[A-Za-z]$/.test(a) && i + 1 < args.length && !args[i + 1].startsWith("-")) {
				if (/^[ugp]$/.test(a.slice(1))) i++;
			}
			continue;
		}
		out.push(a);
	}
	return out;
}

function isRootPath(p: string): boolean {
	if (!p) return false;
	if (ROOT_PATHS.has(p)) return true;
	return false;
}

function reviewCommandWeight(segment: string): { verdict: "heavy" | "suspicious"; why: string } | null {
	const tokens = tokenize(segment);
	if (!tokens) return null;
	const parsed = commandWord(tokens);
	if (!parsed) return null;
	const { cmd, args } = parsed;
	const lower = cmd.toLowerCase();
	const positional = positionalArgs(args);

	if (lower === "find") {
		const paths = positional.filter((p) => !p.startsWith("-"));
		const scanRoots = paths.length === 0 ? ["."] : paths;
		const touchesRoot = scanRoots.some(isRootPath);
		if (touchesRoot && !hasDepthLimit(args) && !hasScopeLimit(args)) {
			return { verdict: "heavy", why: "find 从根目录 / 全盘递归扫描且无深度或范围限制" };
		}
		if (touchesRoot && !hasDepthLimit(args)) {
			return { verdict: "suspicious", why: "find 从根目录递归扫描，未限制深度" };
		}
		return null;
	}

	if (SEARCH_CMDS.has(lower)) {
		if (positional.some(isRootPath) || positional.length === 0) {
			return { verdict: "heavy", why: `${cmd} 全盘搜索，可能遍历整个文件系统` };
		}
		return null;
	}

	if (RECURSIVE_WALKERS.has(lower)) {
		const recursive = args.some((a) => /^-[a-zA-Z]*r/.test(a)) || lower === "du";
		const targetsRoot = positional.some(isRootPath);
		if (recursive && targetsRoot && !hasDepthLimit(args)) {
			return { verdict: "heavy", why: `${cmd} 递归扫描根目录且无深度限制` };
		}
		if (targetsRoot && !hasDepthLimit(args)) {
			return { verdict: "suspicious", why: `${cmd} 在根目录下操作，未限制范围` };
		}
		return null;
	}

	if (ARCHIVE_CMDS.has(lower)) {
		const creating = args.some((a) => /^[cjxa]/.test(a)) || lower === "rsync";
		const touchesRoot = positional.some(isRootPath);
		const hasExclude = args.some((a) => /exclude/.test(a));
		if (creating && touchesRoot && !hasExclude) {
			return { verdict: "heavy", why: `${cmd} 打包/同步整个根目录且没有排除项` };
		}
		return null;
	}

	return null;
}

// --- AI auto-reviewer ------------------------------------------------------

type LoadLevel = "low" | "medium" | "high";

const LOAD_REVIEW_SYSTEM_PROMPT = [
	"你是一个 shell 命令「重量」审查器。",
	"你会收到一条 bash 命令，需要评估它执行时对机器的负担（是否会扫描巨大目录树、遍历整个文件系统、占用大量 CPU/IO）。",
	"",
	"【重要】只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块、不要多余文字。",
	'格式必须是：{"load": "low", "reason": "简短中文理由"}',
	"其中 load 只能是 low / medium / high 三个英文小写词之一，reason 用中文一句话说明理由。",
	"",
	"评估标准：",
	'- low：范围受限的常规命令（指定了具体子目录、有深度限制、只处理少量文件）。',
	'- medium：可能扫描较大目录树但通常会收敛（递归搜索当前项目、中等规模打包、遍历 home 下某目录）。',
	'- high：很可能遍历整个文件系统或从根目录开始的巨大树（find / 、从 / 递归 grep/du、全盘 locate、打包整个 / 且无排除）。',
	"只根据命令字面判断，不要假设文件是否存在，也不要执行它。",
].join("\n");

function buildLoadReviewPrompt(command: string, cwd: string): string {
	return [
		`当前工作目录：${cwd || "(未知)"}`,
		"",
		"待审查的命令：",
		"",
		"  " + command,
		"",
		'请只输出 JSON，例如：{"load":"medium","reason":"中文理由"}',
	].join("\n");
}

function parseLoad(text: string): { load: LoadLevel; reason: string } {
	const fallback = { load: "medium" as LoadLevel, reason: "审查器没有给出明确结论" };
	const match = text.match(/\{[\s\S]*\}/);
	if (!match) return fallback;
	try {
		const obj = JSON.parse(match[0]) as { load?: unknown; reason?: unknown };
		const load = typeof obj.load === "string" ? obj.load.toLowerCase() : "";
		if (load !== "low" && load !== "medium" && load !== "high") return fallback;
		return {
			load,
			reason: typeof obj.reason === "string" && obj.reason.trim() ? obj.reason.trim() : "no reason given",
		};
	} catch {
		return fallback;
	}
}

const LOAD_REVIEW_CACHE_TTL_MS = 5 * 60 * 1000;
const loadReviewCache = new Map<string, { load: LoadLevel; reason: string; at: number }>();

function loadCacheGet(key: string): { load: LoadLevel; reason: string } | null {
	const hit = loadReviewCache.get(key);
	if (!hit) return null;
	if (Date.now() - hit.at > LOAD_REVIEW_CACHE_TTL_MS) { loadReviewCache.delete(key); return null; }
	return { load: hit.load, reason: hit.reason };
}

function loadCacheSet(key: string, load: LoadLevel, reason: string): void {
	if (loadReviewCache.size > 200) {
		const oldest = loadReviewCache.keys().next().value;
		if (oldest !== undefined) loadReviewCache.delete(oldest);
	}
	loadReviewCache.set(key, { load, reason, at: Date.now() });
}

async function reviewLoad(
	command: string,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
): Promise<{ load: LoadLevel; reason: string }> {
	const cached = loadCacheGet(command);
	if (cached) return cached;

	const model = ctx.model;
	if (!model) return { load: "medium", reason: "没有可用的审查模型，按中重量处理" };
	if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
		return { load: "medium", reason: "审查模型没有配置鉴权，按中重量处理" };
	}

	try {
		const response = await ctx.modelRegistry.complete(
			model,
			{
				systemPrompt: LOAD_REVIEW_SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: buildLoadReviewPrompt(command, ctx.cwd) }],
						timestamp: Date.now(),
					},
				],
			},
			{ cacheRetention: "none", sessionId: uuidv7(), signal },
		);

		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c: { text: string }) => c.text)
			.join("\n");

		const result = parseLoad(text);
		loadCacheSet(command, result.load, result.reason);
		return result;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { load: "medium", reason: `审查失败（${msg}），按中重量处理` };
	}
}

/** Build a block result, folding in any user feedback for the agent. */
function blockWithFeedback(
	baseReason: string,
	feedback: string | undefined,
): { block: true; reason: string; terminate: boolean } {
	if (!feedback) {
		return { block: true, reason: baseReason, terminate: true };
	}
	return {
		block: true,
		// terminate stays false so the agent receives the reason and can retry.
		terminate: false,
		reason: `${baseReason}\n\n💬 用户拒绝并补充意见：${feedback}\n请根据这条意见调整命令后重试。`,
	};
}

// --- rm detection ----------------------------------------------------------

// Matches a standalone `rm` invocation, optionally behind sudo/env/etc.
// We match the command word itself rather than every rm flag so that
// things like `rmdir`, `format`, or `graham` are not false positives.
const RM_RE = /(^|[;&|`\n]|\$\()\s*(?:sudo\s+(?:-\S+\s+)*)?(?:env\s+(?:\S+=\S*\s+)*)?(?:\/[^\s;&|]+\/)?rm\b/i;

/** Parse literal shell words for display only. Never execute expansion to preview deletion. */
function deletionWords(command: string): { value: string; dynamic: boolean }[] | null {
	const words: { value: string; dynamic: boolean }[] = [];
	let value = "", quote = "", dynamic = false, started = false;
	let redirectTarget = false;
	const flush = () => {
		if (started) {
			if (!redirectTarget) words.push({ value, dynamic });
			redirectTarget = false;
		}
		value = ""; dynamic = false; started = false;
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (!quote && /\s/.test(ch)) { flush(); continue; }
		if (!quote && ch === "#" && !started) break;
		if (!quote && (ch === ">" || ch === "<")) {
			// Redirections are shell syntax, not deletion operands. Quoted or
			// escaped angle brackets still pass through as literal filename text.
			if (/^\d+$/.test(value)) { value = ""; started = false; }
			flush();
			const operator = command.slice(i).match(/^(?:<<<|<<-|<<|>>|<>|>\||>&|<&|>|<)/)![0];
			i += operator.length - 1;
			redirectTarget = true;
			continue;
		}
		if (!quote && !started && ch === "~" && (command[i + 1] === "/" || i + 1 === command.length || /\s/.test(command[i + 1]))) {
			value = homedir(); started = true; continue;
		}
		if (ch === "\\" && quote !== "'") {
			const next = command[++i];
			if (next === undefined) return null;
			if (next !== "\n") {
				if (quote === '"' && !['$', '`', '"', '\\'].includes(next)) value += "\\";
				value += next; started = true;
			}
			continue;
		}
		if (ch === quote) { quote = ""; continue; }
		if (!quote && (ch === "'" || ch === '"')) { quote = ch; started = true; continue; }
		if (quote !== "'" && (ch === "$" || ch === "`")) dynamic = true;
		if (!quote && /[*?\[\]{}~;&|()<>]/.test(ch)) dynamic = true;
		value += ch; started = true;
	}
	if (quote) return null;
	flush();
	return words;
}

function absoluteDeletionPath(value: string, cwd: string): string {
	// Preserve '..': normalizing it could change the target through a symlink.
	return isAbsolute(value) ? value : `${cwd.replace(/\/$/, "")}/${value}`;
}

export function deletionConfirmationBody(segment: string, cwd: string, prefix = ""): string {
	let effectiveCwd: string | undefined = cwd;
	if (prefix.trim()) {
		const cd = prefix.match(/^\s*cd\s+([\s\S]+?)\s*&&\s*$/);
		const words = cd ? deletionWords(cd[1]) : null;
		if (words?.length === 1 && !words[0].dynamic) {
			effectiveCwd = absoluteDeletionPath(words[0].value, cwd);
		} else if (/(^|[\s;&|])(cd|pushd|popd|source|eval|\.)\b|[()]/.test(prefix)) {
			effectiveCwd = undefined;
		}
	}
	const words = deletionWords(segment);
	const index = words?.findIndex(({ value }) => /^(?:.*\/)?(?:rm|unlink|rmdir|shred|trash)$/.test(value)) ?? -1;
	const paths: string[] = [];
	if (words && index >= 0) {
		if (words.slice(0, index).some(({ value }) => /^(-D|--chdir|-C)/.test(value))) effectiveCwd = undefined;
		let options = true;
		for (const word of words.slice(index + 1)) {
			if (options && word.value === "--") { options = false; continue; }
			if (options && word.value.startsWith("-")) continue;
			if (!word.value) continue;
			if ((word.dynamic && /[$`~]/.test(word.value)) || (!effectiveCwd && !isAbsolute(word.value))) {
				paths.push(word.value);
			} else {
				paths.push(absoluteDeletionPath(word.value, effectiveCwd ?? cwd));
			}
		}
	}
	return (paths.length ? paths : [segment.trim()]).join("\n");
}

// Other tools whose sole job is deletion. Blocked for the same reason.
const DELETE_TOOLS_RE =
	/(^|[;&|`\n]|\$\()\s*(?:sudo\s+(?:-\S+\s+)*)?(?:env\s+(?:\S+=\S*\s+)*)?(unlink|rmdir|shred|trash)\b/i;

// --- mv detection ----------------------------------------------------------

// Matches a standalone `mv` invocation, optionally behind sudo/env/etc.
const MV_RE = /(^|[;&|`\n]|\$\()\s*(?:sudo\s+(?:-\S+\s+)*)?(?:env\s+(?:\S+=\S*\s+)*)?mv\b/i;

// `-f` / `--force` anywhere in the mv argument list forces overwrite.
const MV_FORCE_RE = /\s(?:-{1,2}(?:f|force))(?:\s|$)/i;

// --- other destructive bash commands -------------------------------------

// Disk / filesystem wiping.
const DISK_WIPE_RE =
  /(^|[;&|`\n]|\$\()\s*(?:sudo\s+(?:-\S+\s+)*)?(?:env\s+(?:\S+=\S*\s+)*)?(dd\b[^\n]*\bof=\/dev\/|mkfs|fdisk|wipefs|sgdisk|parted)\b/i;

// Overwriting a file via redirection (`> file` or `>> file`). We only block
// when the target looks like a sensitive path; plain `> out.txt` is fine.
const REDIRECT_RE = /(^|[;&|`\n]|\s)(?:sudo\s+)?>>?\s*(~|\/[^\s;|&]*)/i;

// git commands that throw away work.
const GIT_DESTRUCTIVE_RE =
  /(^|[;&|`\n]|\$\()\s*git\s+(reset\s+--hard|clean\s+-[a-z]*f[a-z]*|checkout\s+--\s*\S|restore\s+--\s*\S|stash\s+drop|branch\s+-D)(?=\s|;|&|\||\n|$)/i;

// find with -delete or -exec rm.
const FIND_DELETE_RE =
  /(^|[;&|`\n]|\$\()\s*find\b[^\n]*(\s-delete\b|\s-exec\s+(?:sudo\s+)?rm\b|\s-execdir\s+(?:sudo\s+)?rm\b)/i;

// chmod/chown that could make files unusable (e.g. chmod 000, chown to nobody).
const CHMOD_CHOWN_RE =
  /(^|[;&|`\n]|\$\()\s*(?:sudo\s+(?:-\S+\s+)*)?(chmod\s+(-[a-zA-Z]*\s+)*0+\s|chown\s+[^\n]*\s(nobody|noguest|root)\s)/i;

// --- write/edit path blacklist --------------------------------------------

// Sensitive path fragments. A write/edit whose path matches any of these is
// blocked outright. Matching is case-insensitive substring on the path.
const SENSITIVE_PATH_FRAGMENTS = [
  "/.env",
  "/.git/hooks",
  "/.ssh/",
  "/id_rsa",
  "/id_ed25519",
  "/authorized_keys",
  "/known_hosts",
  "/.npmrc",
  "/.pypirc",
  "/.netrc",
  "/.aws/credentials",
  "/.config/gcloud",
  "/.kube/config",
  "/.docker/config.json",
  "/.bashrc",
  "/.zshrc",
  "/.profile",
  "/.bash_profile",
  "/etc/passwd",
  "/etc/shadow",
  "/etc/sudoers",
];

// Directories that should never be written into.
const SENSITIVE_PATH_DIRS = ["/node_modules/", "/.git/", "/.pi/agent/"];

/**
 * Decide whether a write/edit path is sensitive enough to block.
 * Returns a human-readable reason when blocked, or null when allowed.
 */
function sensitivePathReason(path: string): string | null {
  if (!path || typeof path !== "string") return null;
  const normalized = path.replace(/\\/g, "/");
  for (const frag of SENSITIVE_PATH_FRAGMENTS) {
    if (normalized.toLowerCase().includes(frag.toLowerCase())) {
      return `路径包含敏感片段 "${frag}"`;
    }
  }
  for (const dir of SENSITIVE_PATH_DIRS) {
    if (normalized.includes(dir)) {
      return `路径位于受保护目录 "${dir}"`;
    }
  }
  return null;
}

/**
 * Split a shell command into top-level segments on ; & | and newlines so we
 * can analyze each command independently. Quoted separators are ignored.
 */
function splitSegments(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote: string | null = null;

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];

		if (quote) {
			current += ch;
			if (ch === quote) quote = null;
			continue;
		}

		if (ch === "'" || ch === '"' || ch === "`") {
			quote = ch;
			current += ch;
			continue;
		}

		if (ch === ";" || ch === "&" || ch === "|" || ch === "\n") {
			segments.push(current);
			current = "";
			// Collapse runs of separators (&, &&, ||, |) into one split.
			while (i + 1 < command.length && ";&|\n".includes(command[i + 1])) i++;
			continue;
		}

		current += ch;
	}

	segments.push(current);
	return segments;
}

/**
 * Tokenize a single command segment into words, honoring quotes so that a
 * path containing spaces stays one token. Returns null if the segment is
 * empty or only whitespace.
 */
function tokenize(segment: string): string[] | null {
	const tokens: string[] = [];
	let current = "";
	let quote: string | null = null;
	let hasContent = false;

	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i];

		if (quote) {
			if (ch === quote) {
				quote = null;
			} else {
				current += ch;
			}
			continue;
		}

		if (ch === "'" || ch === '"' || ch === "`") {
			quote = ch;
			hasContent = true;
			continue;
		}

		if (/\s/.test(ch)) {
			if (current.length > 0 || hasContent) {
				tokens.push(current);
				current = "";
				hasContent = false;
			}
			continue;
		}

		current += ch;
	}

	if (current.length > 0 || hasContent) tokens.push(current);
	return tokens.length > 0 ? tokens : null;
}

/**
 * Given an mv argument list (flags + paths), return the source and
 * destination paths, or null if the shape is not a simple `mv src dst`.
 */
function mvPaths(args: string[]): { src: string; dst: string } | null {
	const paths: string[] = [];
	for (const arg of args) {
		if (arg === "--") continue;
		if (arg.startsWith("-")) continue; // flag (covers -f, -t, -n, combined, etc.)
		paths.push(arg);
	}
	if (paths.length !== 2) return null;
	return { src: paths[0], dst: paths[1] };
}

/** Normalize a path for self/nesting comparison: strip a trailing slash. */
function normalizePath(p: string): string {
	return p.replace(/\/+$/, "") || "/";
}

/**
 * Statically-decided mv hazards. Returns a human-readable reason when the
 * move is unambiguously unsafe regardless of context, or null when the move
 * should go to the AI reviewer for a judgment call.
 */
function staticMvHazard(args: string[]): string | null {
	if (MV_FORCE_RE.test(" " + args.join(" ") + " ")) {
		return "mv 使用了 -f/--force，会在不警告的情况下覆盖目标";
	}

	const pair = mvPaths(args);
	if (!pair) return null; // not a simple src/dst move; let the reviewer decide

	const src = normalizePath(pair.src);
	const dst = normalizePath(pair.dst);

	if (src === dst) {
		return "mv 的源文件和目标相同";
	}

	// Moving a directory into one of its own descendants would nest it
	// inside itself (mv a/b a/b/c).
	if (dst.startsWith(src + "/")) {
		return "mv 的目标在源目录内部";
	}

	return null;
}

// --- AI auto-reviewer ------------------------------------------------------

type RiskLevel = "low" | "medium" | "high";

const REVIEW_SYSTEM_PROMPT = [
	"你是一个 shell 命令安全审查器。",
	"你会收到一条 `mv`（移动/重命名）命令。",
	"评估执行它的风险等级。",
	"",
	"【重要】只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块、不要多余文字。",
	'格式必须是：{"risk": "low", "reason": "简短中文理由"}',
	"其中 risk 只能是 low / medium / high 三个英文小写词之一，reason 用中文一句话说明理由。",
	"",
	"评估标准：",
	'- low：项目内常规的重命名/移动，不太可能丢失数据。',
	'- medium：可能覆盖数据或让用户意外（移动到已存在的路径、移动配置/数据文件、使用通配符、移出某个目录）。',
	'- high：很可能是破坏性的或难以撤销（强制覆盖、移动系统路径、移动大量文件、移动到非空目录、覆盖重要文件）。',
	"只根据命令字面判断，不要假设文件是否存在。",
].join("\n");

function buildReviewPrompt(command: string, cwd: string): string {
	return [
		"当前工作目录：" + (cwd || "(未知)"),
		"",
		"待审查的命令：",
		"",
		"  " + command,
		"",
		"请只输出 JSON，例如：{\"risk\":\"medium\",\"reason\":\"中文理由\"}",
	].join("\n");
}

/**
 * Ask the active model to rate the risk of an mv command. Returns the risk
 * level and a short reason. On any failure, returns "medium" so the caller
 * prompts (or blocks without a UI) rather than silently allowing the move.
 */
async function reviewMv(
	command: string,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
): Promise<{ risk: RiskLevel; reason: string }> {
	// Serve from cache when the same command was reviewed recently.
	const cached = cacheGet(command);
	if (cached) return cached;

	const model = ctx.model;
	if (!model) {
		return { risk: "medium", reason: "没有可用的审查模型，按中风险处理" };
	}
	if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
		return { risk: "medium", reason: "审查模型没有配置鉴权，按中风险处理" };
	}

	try {
		const response = await ctx.modelRegistry.complete(
			model,
			{
				systemPrompt: REVIEW_SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: buildReviewPrompt(command, ctx.cwd) }],
						timestamp: Date.now(),
					},
				],
			},
			{
				cacheRetention: "none",
				sessionId: uuidv7(),
				signal,
			},
		);

		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c: { text: string }) => c.text)
			.join("\n");

		const result = parseRisk(text);
		cacheSet(command, result.risk, result.reason);
		return result;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { risk: "medium", reason: `审查失败（${msg}），按中风险处理` };
	}
}

/** Extract a {"risk", "reason"} object from a model response. */
function parseRisk(text: string): { risk: RiskLevel; reason: string } {
	const fallback = { risk: "medium" as RiskLevel, reason: "审查器没有给出明确结论" };

	// Grab the first {...} block, tolerating code fences or surrounding prose.
	const match = text.match(/\{[\s\S]*\}/);
	if (!match) return fallback;

	try {
		const obj = JSON.parse(match[0]) as { risk?: unknown; reason?: unknown };
		const risk = typeof obj.risk === "string" ? obj.risk.toLowerCase() : "";
		if (risk !== "low" && risk !== "medium" && risk !== "high") return fallback;
		return {
			risk,
			reason: typeof obj.reason === "string" && obj.reason.trim() ? obj.reason.trim() : "no reason given",
		};
	} catch {
		return fallback;
	}
}

// --- mv review cache -------------------------------------------------------

// Cache review results keyed by command text so repeated mv calls within a
// short window do not each trigger a model call. Entries expire after TTL.
const REVIEW_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const reviewCache = new Map<string, { risk: RiskLevel; reason: string; at: number }>();

function cacheGet(key: string): { risk: RiskLevel; reason: string } | null {
	const hit = reviewCache.get(key);
	if (!hit) return null;
	if (Date.now() - hit.at > REVIEW_CACHE_TTL_MS) {
		reviewCache.delete(key);
		return null;
	}
	return { risk: hit.risk, reason: hit.reason };
}

function cacheSet(key: string, risk: RiskLevel, reason: string): void {
	// Bound the cache so a long session cannot grow it without limit.
	if (reviewCache.size > 200) {
		const oldest = reviewCache.keys().next().value;
		if (oldest !== undefined) reviewCache.delete(oldest);
	}
	reviewCache.set(key, { risk, reason, at: Date.now() });
}

let pendingFeedback: string | undefined;

async function confirmBlock(
	ctx: ExtensionContext,
	title: string,
	body: string,
): Promise<boolean> {
	const result = await confirmOrFeedback(ctx, title, body);
	pendingFeedback = result.allow ? undefined : result.feedback;
	return result.allow;
}

function blockFromLatestFeedback(reason: string) {
	const result = blockWithFeedback(reason, pendingFeedback);
	pendingFeedback = undefined;
	return result;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("clear", {
		description: "清空当前对话并开始新会话",
		handler: async (_args, ctx) => {
			// Confirm only when an interactive UI and a conversation are present.
			// Non-interactive modes retain the original direct-reset behavior.
			const entries = ctx.sessionManager.getEntries();
			const hasConversation = entries.length > 0;

			if (ctx.hasUI && hasConversation) {
				const result = await confirmOrFeedback(
					ctx,
					"🧹 清空当前对话？",
					"这将开始一个新会话，并从模型上下文中清除当前对话。\n当前会话文件仍会保留在磁盘上。",
					{ yes: "✅ 是", no: "❌ 否" },
				);
				if (!result.allow) return;
			}

			const result = await ctx.newSession({
				withSession: async (ctx) => {
					ctx.ui.notify("对话已清空，已开始新会话。", "info");
				},
			});

			if (result.cancelled) return;
		},
	});

	pi.registerFlag("shell-guard-review", {
		description: "Enable the AI auto-reviewer for mv commands (default on)",
		type: "boolean",
		default: true,
	});
	pi.registerFlag("heavy-review", {
		description: "Enable the AI auto-reviewer for heavy commands (default on)",
		type: "boolean",
		default: true,
	});

	let generation = 0;
	for (const event of ["session_switch", "session_tree", "session_shutdown"] as const) {
		pi.on(event, () => { generation++; });
	}
	const checkTool = async (event: ToolCallEvent, ctx: ExtensionContext) => {
		// Rule 3: write/edit must not touch sensitive paths.
		if (event.toolName === "write" || event.toolName === "edit") {
			const path = (event.input as { path?: unknown }).path;
			if (typeof path === "string") {
				const reason = sensitivePathReason(path);
				if (reason) {
					const ok = await confirmBlock(
						ctx,
						"🚫 写入敏感路径",
						`路径：${path}\n原因：${reason}\n\n确认写入？`,
					);
					if (!ok) {
						return blockFromLatestFeedback(`🚫 用户拒绝写入敏感路径：${path}`);
					}
				}
			}
			return undefined;
		}

		if (event.toolName !== "bash") return undefined;

		const command = event.input.command as string;
		if (!command || typeof command !== "string") return undefined;

		const segments = splitSegments(command);
		let segmentOffset = 0;

		for (const segment of segments) {
			const segmentStart = command.indexOf(segment, segmentOffset);
			segmentOffset = segmentStart + segment.length;
			// Rule 0: prevent commands that may exhaust CPU, IO, or scan huge trees.
			const weight = reviewCommandWeight(segment);
			if (weight?.verdict === "heavy") {
				const { allow, feedback } = await confirmOrFeedback(
					ctx,
					"🐌 命令过重",
					`命令：${segment.trim()}\n原因：${weight.why}\n\n这类命令会扫描巨大的目录树，可能长时间占用机器。`,
				);
				if (!allow) {
					return blockWithFeedback(
						`🐌 用户拒绝执行过重的命令：${segment.trim()}（${weight.why}）`,
						feedback,
					);
				}
			} else if (weight?.verdict === "suspicious" && pi.getFlag("heavy-review") !== false) {
				const { load, reason } = await guardPhase("review", () => reviewLoad(segment.trim(), ctx, ctx.signal));
				if (load !== "low") {
					const loadLabel = load === "high" ? "高" : "中";
					const { allow, feedback } = await confirmOrFeedback(
						ctx,
						"🐌 命令重量审查",
						`自动审查器将此次命令评为 ${loadLabel}重量：\n\n  ${segment.trim()}\n\n📝 理由：${reason}`,
					);
					if (!allow) {
						return blockWithFeedback(
							`🐌 命令未获确认（${loadLabel}重量：${reason}）`,
							feedback,
						);
					}
				}
			}

			// Rule 1: deletion requires confirmation.
			if (RM_RE.test(segment) || DELETE_TOOLS_RE.test(segment)) {
				const ok = await confirmBlock(
					ctx,
					"🚫 删除操作",
					deletionConfirmationBody(segment, ctx.cwd, command.slice(0, segmentStart)),
				);
				if (!ok) {
					return blockFromLatestFeedback(`🚫 用户拒绝删除操作：${segment.trim()}`);
				}
				continue; // user allowed
			}

			// Rule 1b: other destructive bash commands require confirmation.
			if (
				DISK_WIPE_RE.test(segment) ||
				GIT_DESTRUCTIVE_RE.test(segment) ||
				FIND_DELETE_RE.test(segment) ||
				CHMOD_CHOWN_RE.test(segment)
			) {
				const ok = await confirmBlock(
					ctx,
					"🚫 破坏性命令",
					`命令：${segment.trim()}\n\n此命令可能丢失数据或破坏系统。确认执行？`,
				);
				if (!ok) {
					return blockFromLatestFeedback(`🚫 用户拒绝破坏性命令：${segment.trim()}`);
				}
				continue;
			}

			// Rule 1c: redirection that overwrites a sensitive path.
			const redirectMatch = segment.match(REDIRECT_RE);
			if (redirectMatch) {
				const target = redirectMatch[1];
				const reason = sensitivePathReason(target);
				if (reason) {
					const ok = await confirmBlock(
						ctx,
						"🚫 覆盖敏感路径",
						`命令：${segment.trim()}\n\n目标：${target}\n原因：${reason}\n\n确认覆盖？`,
					);
					if (!ok) {
						return blockFromLatestFeedback(`🚫 用户拒绝覆盖敏感路径：${target}`);
					}
				}
			}

			// Rule 2: mv goes through static hazards, then the AI reviewer.
			if (MV_RE.test(segment)) {
				const tokens = tokenize(segment);
				if (!tokens) continue;
				// Drop the leading command word (mv, possibly sudo/env).
				let start = 0;
				while (start < tokens.length && /^(sudo|env)$/.test(tokens[start])) start++;
				const args = tokens.slice(start + 1);

				const hazard = staticMvHazard(args);
				if (hazard) {
					const ok = await confirmBlock(
						ctx,
						"🚫 不安全的 mv",
						`命令：${segment.trim()}\n原因：${hazard}\n\n确认执行？`,
					);
					if (!ok) {
						return blockFromLatestFeedback(`🚫 用户拒绝不安全的 mv：${segment.trim()}`);
					}
				}

				const reviewEnabled = pi.getFlag("shell-guard-review") !== false;
				if (!reviewEnabled) continue; // reviewer opted out; allow the move

				const { risk, reason } = await guardPhase("review", () => reviewMv(segment.trim(), ctx, ctx.signal));

				if (risk === "low") continue; // allowed

				const riskLabel = risk === "high" ? "高" : risk === "medium" ? "中" : "低";

				// medium or high: require confirmation when a UI is available.
				if (!ctx.hasUI) {
					return {
						block: true,
						reason:
							`🚫 Blocked by safety-guard: mv 被评为 ${riskLabel}风险（${reason}），但没有可用的界面进行确认。`,
						terminate: true,
					};
				}

				const ok = await confirmBlock(
					ctx,
					"🤖 移动风险审查",
					`自动审查器将此次移动评为 ${riskLabel}风险：\n\n  ${segment.trim()}\n\n📝 理由：${reason}`,
				);

				if (!ok) {
					return blockFromLatestFeedback(`🚫 Blocked by safety-guard: mv 未获确认（${riskLabel}风险：${reason}）。`);
				}
			}
		}

		return undefined;
	};
	pi.on("tool_call", async (event, ctx) => {
		const owner = generation;
		return trackGuard(event.toolCallId, () => checkTool(event, ctx), data => {
			if (owner === generation) pi.events.emit("safety-guard:timing", data);
		}, data => {
			if (owner === generation) pi.appendEntry("safety-guard:timing", data);
		}, () => performance.now(), () => ctx.signal?.aborted ?? false);
	});
}
