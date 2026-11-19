import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { showQuestionnaire } from "./questionnaire.js";
import { promptConfabKey } from "./confab-secret.js";
import { cleanTitle, generateConfabTitle } from "./confab-title.js";
import { exportDiagnostic } from "./confab-errors.js";
import { ConfabApi, normalizeBackend, type Credential } from "./confab-api.js";
import { CredentialStore, accountScope, snapshot } from "./confab-data.js";
import { SyncStateStore } from "./confab-sync-state.js";
import { planSync } from "./confab-incremental.js";

const warning = "将上传当前分支的对话、思考文本、工具调用参数、工具结果及附加信息、压缩/分支摘要和扩展消息（claude-code 兼容格式）。图片/附件等二进制内容仅保留占位说明，不上传原始载荷。脱敏不能保证移除所有秘密。没有会话名称时会使用当前模型生成中文标题（发送脱敏摘录，可能产生少量模型费用）。同一会话按历史前缀增量追加；分叉、回退或历史记录变化时会创建新的远程会话。此部署可能向所有已登录用户开放全部会话。";
const usage = "Confab 用法：/confab login [后端地址]（设备登录）| login-key [后端地址]（输入 API key 登录）| status（状态）| enable（开启同步）| disable（关闭同步）| sync（立即同步）| vis（查看分享管理入口）";

/** Dependency seams are for offline tests; factory performs no I/O or upload. */
export default function registerConfab(pi: ExtensionAPI, dependencies: {
  api?: ConfabApi; store?: CredentialStore; ask?: typeof showQuestionnaire;
  promptKey?: typeof promptConfabKey;
  syncState?: Pick<SyncStateStore, "load" | "save" | "lock">;
} = {}) {
  const api = dependencies.api ?? new ConfabApi();
  const store = dependencies.store ?? new CredentialStore();
  const ask = dependencies.ask ?? showQuestionnaire;
  const promptKey = dependencies.promptKey ?? promptConfabKey;
  const syncState = dependencies.syncState ?? new SyncStateStore();
  let credential: Credential | undefined;
  let consent: string | undefined;
  let generation = 0;
  let controller = new AbortController();
  let pending: ExtensionContext | undefined;
  let running = false;
  const stop = () => {
    generation++; consent = undefined; pending = undefined;
    controller.abort(); controller = new AbortController();
  };
  const scope = (ctx: ExtensionContext) => credential ? JSON.stringify([ctx.sessionManager.getSessionId(), accountScope(credential)]) : undefined;
  const authorized = (ctx: ExtensionContext) => consent !== undefined && consent === scope(ctx);
  const notify = (ctx: ExtensionContext, text: string) => ctx.ui.notify(text, "info");
  const confirm = async (ctx: ExtensionContext, prompt: string, signal: AbortSignal) => {
    if (ctx.mode !== "tui" || !ctx.hasUI) return false;
    const r = await ask(pi, ctx, { title: "Confab — Pi 会话兼容导出", questions: [
      { id: "allow", type: "confirm", prompt, default: false },
    ] }, signal);
    return !signal.aborted && !r.cancelled && r.answers.allow === true;
  };
  const drain = async () => {
    if (running) return;
    running = true;
    try {
      while (pending) {
        const ctx = pending; pending = undefined;
        if (!authorized(ctx) || !credential) continue;
        const gen = generation, signal = controller.signal, c = credential;
        let stage = "本地导出与脱敏";
        let release: (() => void) | undefined;
        try {
          const titleScope = scope(ctx)!;
          const data = snapshot(ctx.sessionManager.getBranch(), c, titleScope);
          if (!data.lines.length) { notify(ctx, "Confab：当前分支没有可导出的会话记录。"); continue; }
          stage = "读取并锁定本地同步进度";
          release = syncState.lock(titleScope);
          const plan = planSync(titleScope, data.lines, syncState.load(titleScope));
          stage = "生成会话标题";
          const named = cleanTitle(ctx.sessionManager.getSessionName?.() ?? "");
          const title = named || plan.record.title || await generateConfabTitle(ctx, data.lines, signal);
          if (gen !== generation || signal.aborted || !authorized(ctx)) continue;
          stage = "保存待上传记录指纹";
          // Persist intent first: even uncertain server acceptance can only resume this exact prefix.
          syncState.save(titleScope, plan.records);
          stage = "服务端增量上传";
          await api.sync(c, { ...data, externalId: plan.record.externalId, title, updateTitle: title !== plan.record.title }, signal);
          if (gen !== generation || signal.aborted || !authorized(ctx)) continue;
          stage = "保存同步进度";
          plan.record.title = title;
          syncState.save(titleScope, plan.records);
          notify(ctx, plan.created ? "Confab · 已同步到新的远程会话\n\n后续新增记录将增量追加到此会话。" : "Confab · 增量同步完成\n\n已沿用原远程会话；没有新增记录时不会重复上传。");
        } catch (error) {
          if (gen === generation && !signal.aborted) {
            const reason = exportDiagnostic(error) ?? (stage.includes("同步进度") || stage.includes("记录指纹")
              ? "本地同步状态不可用、分支记录已满或被另一个进程锁定。请检查 ~/.pi-confab/sync-state；勿删除正在使用的锁文件。"
              : "未能完成此阶段。请检查账号、网络连接及后端接口；原始错误详情不显示。");
            stop(); notify(ctx, `Confab · 同步失败\n\n阶段：${stage}\n原因：${reason}\n同步已自动关闭。\n\n重试：/confab enable → /confab sync`);
          }
        } finally {
          try { release?.(); } catch {
            stop(); notify(ctx, "Confab · 同步锁释放失败\n\n已关闭同步。请检查 ~/.pi-confab/sync-state 的权限及锁文件，勿在其他进程同步时删除锁。");
          }
        }
      }
    } finally { running = false; }
  };
  const enqueue = (ctx: ExtensionContext) => { if (authorized(ctx)) { pending = ctx; void drain(); } };
  for (const event of ["session_start", "session_before_switch", "session_before_fork", "session_before_tree", "session_shutdown"] as const) pi.on(event, stop);
  pi.on("agent_end", (_event, ctx) => enqueue(ctx));
  pi.registerCommand("confab", {
    description: "Confab 会话同步：登录、查看状态、开启/关闭同步、立即同步、查看分享入口",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/), command = parts[0];
      if (!command || !["login", "login-key", "status", "enable", "disable", "sync", "vis"].includes(command) ||
          parts.length > (["login", "login-key"].includes(command) ? 2 : 1)) { notify(ctx, usage); return; }
      if (command === "disable") { stop(); notify(ctx, "Confab · 同步已关闭\n\n待处理任务已取消，登录凭证仍保留。\n已上传的内容不会被删除。"); return; }
      let failureHint = "请检查本地凭证文件及其权限。";
      try {
        if (command === "login" || command === "login-key") {
          stop();
          const gen = generation, signal = controller.signal;
          if (ctx.mode !== "tui" || !ctx.hasUI) { notify(ctx, "Confab 登录需要在交互界面中明确确认。"); return; }
          credential ??= store.load();
          if (!parts[1] && !credential) { notify(ctx, "首次登录请使用 /confab login https://你的后端域名"); return; }
          failureHint = "后端地址不符合要求：仅支持 HTTP/HTTPS，不能包含路径、查询参数或账号密码。此时尚未发起登录请求。";
          // Parse first; permission to send over HTTP is granted only by the following confirmation.
          const backend = normalizeBackend(parts[1] ?? credential!.backend, true);
          const allowHttp = backend.startsWith("http:");
          if (allowHttp && (!await confirm(ctx, `安全警告：${backend} 使用 HTTP，API key、授权凭证及会话内容将明文传输，可能被窃听或篡改。是否仅为此后端允许 HTTP？`, signal) || gen !== generation)) return;
          if (!await confirm(ctx, `是否在 ${backend} 使用${command === "login-key" ? "API key" : "设备授权"}登录？登录不会自动开启上传。`, signal) || gen !== generation) return;
          failureHint = "设备授权未完成。请检查后端连接、HTTPS 证书，以及服务是否支持 /auth/device/code 和 /auth/device/token；也可能是授权超时或被拒绝。当前插件不读取官方 CLI 的 API key 配置。";
          let next: Credential;
          if (command === "login-key") {
            failureHint = "无法打开密钥输入框，请在 Pi 交互界面中重试。";
            const token = await promptKey(ctx, signal);
            if (gen !== generation || signal.aborted) return;
            if (!token) { notify(ctx, "已取消 API key 登录，未发送或保存密钥。"); return; }
            next = { backend, token, ...(allowHttp ? { allowHttp: true } : {}) };
          } else {
            next = await api.deviceLogin(backend, signal, (url, code) => {
              if (gen === generation && !signal.aborted) notify(ctx, `Confab：请打开 ${url}，输入验证码 ${code} 完成授权。输入 /confab disable 可取消登录。`);
            }, allowHttp);
          }
          failureHint = "登录凭证校验失败。请检查 API key、后端 /api/v1/auth/validate 接口、账号权限及网络连接。";
          await api.validate(next, signal);
          if (gen !== generation || signal.aborted) return;
          failureHint = "授权成功，但无法安全保存本地凭证。请检查 ~/.pi-confab 目录及 credential.json 的所有者和权限（目录 0700、文件 0600，不允许符号链接）。";
          store.save(next); credential = next;
          notify(ctx, "Confab · 登录成功\n\n凭证已安全保存，下次无需重复输入。\n同步状态：已关闭（尚未上传会话）\n\n下一步：/confab enable\n确认后开启当前会话的自动同步。");
        } else if (command === "enable") {
          stop();
          const gen = generation, signal = controller.signal;
          if (ctx.mode !== "tui" || !ctx.hasUI) { notify(ctx, "开启 Confab 同步需要在交互界面中明确同意。"); return; }
          credential ??= store.load();
          if (!credential) { notify(ctx, "Confab：请先登录。"); return; }
          const target = scope(ctx), c = credential;
          if (!await confirm(ctx, `是否允许将当前会话上传至 ${c.backend}？授权仅对当前会话和账号有效，关闭同步、切换会话或重载后失效。${c.backend.startsWith("http:") ? "警告：此后端使用 HTTP，凭证和会话内容将明文传输。" : ""}${warning}`, signal) || gen !== generation || target !== scope(ctx)) return;
          failureHint = "开启同步前的凭证校验失败。请检查后端连接及账号权限，必要时重新登录。";
          await api.validate(c, signal);
          if (gen !== generation || signal.aborted || target !== scope(ctx)) return;
          consent = target;
          notify(ctx, "Confab · 同步已开启\n\n每轮助手运行结束后自动同步。\n\n立即同步：/confab sync\n停止同步：/confab disable");
        } else if (command === "sync") {
          if (!authorized(ctx)) { notify(ctx, "Confab · 同步已关闭\n\n开启同步：/confab enable\n请在确认框中授权上传当前会话。"); return; }
          enqueue(ctx);
        } else {
          credential ??= store.load();
          if (command === "status") notify(ctx, `Confab · 状态\n\n登录：${credential ? "凭证已保存" : "未登录"}\n后端：${credential?.backend ?? "未设置"}\n同步：${authorized(ctx) ? "已开启" : "已关闭"}\n任务：${running ? "处理中" : "空闲"}\n\n以上为本地状态，未进行在线认证检查。`);
          else notify(ctx, credential ? `Confab 后端：${credential.backend}\n请在部署的网页前端 /sessions 页面管理分享。若前后端同源，可尝试 ${credential.backend}/sessions；前后端分离的部署需使用独立的前端地址。\n此处不能设置私密/团队/公开权限。此部署可能向所有已登录用户开放全部会话。` : "Confab：请先登录以选择后端。");
        }
      } catch {
        // Never surface remote bodies, tokens, URLs supplied in errors, or filesystem errors.
        notify(ctx, `Confab · 操作失败\n\n${failureHint}\n\n为保护隐私，不显示原始错误详情。`);
      }
    },
  });
}
