# Confab: opt-in Pi compatibility export

This direct API adapter needs no Confab CLI installation and does not inspect CLI
credentials, change hooks, or list cloud sessions. Uploads default to **OFF**.

## Commands

- `/confab login https://YOUR-BACKEND` — first login requires your backend origin.
  Confirm in the interactive TUI, then visit the displayed verification link and
  enter its device code. The API key is never an argument or transcript entry.
  A later `/confab login` can reuse the saved backend. Login never enables uploads.
- `/confab status` — local saved-login / consent / queue status, not a live auth check.
- `/confab enable` — explicitly confirm the export and sharing warning in the TUI.
  Validation must succeed before consent becomes active. Enables automatic sync
  on `agent_end`, not an immediate upload.
- `/confab sync` — queue the current active branch snapshot; requires the same
  enable consent. No implicit consent prompt or one-shot bypass.
- `/confab disable` — immediately revoke consent, abort login/network work and
  discard pending sync. Cannot retract bytes already accepted by the server.
- `/confab vis` — displays the backend `/sessions` management URL. **Cannot set
  private/team/public. A deployment may share ALL sessions with authenticated
  users.** Check your deployment's access policy before enabling.

- `/confab login-key [URL]` — 在插件内的掩码输入框中粘贴 API key，回车提交，Esc 取消。跳过设备授权，校验成功后私密保存凭证。密钥不写入聊天记录或日志；不读取环境变量或官方 CLI 配置。
- HTTP 后端在登录时需要额外确认明文传输风险；许可仅与保存的该后端凭证关联，不会全局放开 HTTP。开启同步时会再次提醒。

重载插件后，在 Pi 中执行 `/confab login-key http://confab.example.test`（替换为自己的后端地址），确认 HTTP 风险，在掩码输入框粘贴密钥。登录成功后执行 `/confab enable`。不需要设置环境变量或重启 Pi。掩码仅保护屏幕显示，HTTP 仍为明文传输。

Only these subcommands are supported. Login and enable fail closed outside TUI
(including RPC). Consent is memory-only, scoped to Pi session and saved backend /
account token digest. Disable, new login/enable, session switch/fork, shutdown and
reload invalidate it. Re-enable after reload. A sync failure disables uploading.

## 会话标题

上传的 `metadata.summary` 使用可读标题，不再使用固定英文兼容说明。优先采用 Pi 会话名称（可用 `/name` 设置），否则调用当前模型，根据已脱敏的前几条对话生成简短中文标题。模型不可用、失败或超过 15 秒时，回退到首条用户消息摘要。

生成会向当前模型服务发送最多 6000 字符的脱敏摘录，并可能产生少量费用；开启同步的确认框会提示。标题再次脱敏并限制为 60 字符。标题与同步进度私密保存，重载后复用已有标题。明确修改 Pi 会话名称会优先覆盖缓存，并通过独立的 summary PATCH 接口更新原远程会话，不因改名创建重复会话。

## What is exported

Official Confab rejects provider `pi`. This deliberately **LOSSY** adapter sends
`provider: claude-code` with a readable session title. Compatibility version/model
fields identify it as a Pi export; it includes sanitized conversation and tool records, not just user/assistant text. It reads only `getBranch()`, not other branches
or session files.

导出当前分支中的用户/助手文本、thinking 文本（不含签名）、工具名与参数（`tool_use`）、工具结果及失败标志（`tool_result`）、工具附加信息、压缩/分支摘要及扩展消息。工具调用 ID 哈希化，调用和结果保持关联、顺序及原始时间。工具输出留在 `tool_result.content`；工具附加信息独立存为该工具结果记录顶层的 `toolUseResult`，不再追加“工具附加信息”JSON 正文。前端仅对其认识的元数据字段提供专门展示，其他字段仍保留在原始记录中。工具活动可能仍归入前端 Assistant 时间线区域，不代表它被导出成助手正文。已有的其他消息角色以兼容用户消息标注，不额外读取或重建系统提示。

图片、附件、未知内容块使用占位说明；不上传无法可靠脱敏的原始二进制或签名。不导出任意 `custom` 插件内部状态、其他分支、原始会话 ID 或 cwd 元数据。工具文本本身可能含路径和源码。

消息时间保留 Pi 原始消息时间，缺失时使用会话条目的时间，统一转换为 UTC ISO 格式。不再使用固定的 1970 年时间；两者均缺失或无效时停止导出，不伪造上传时间。时间变动会生成新的快照标识，旧的远程快照不会被覆盖。

助手记录存在模型名称和 token 用量时保留这些字段；缺失时使用 unknown/零占位，不代表真实零消耗。费用未导出。ID、cwd、版本及父链接仍为兼容生成值，stop reason 为 null。

Common PEM blocks, token prefixes, authorization strings, password/key/secret
assignments (including multiline quoted values), cloud AK/SK assignments and Alibaba
`LTAI…` access key IDs are heuristically redacted before
export bounds are applied. Cross-message secret spans conservatively redact only
intersecting string leaves, not all selected text. 工具参数和附加信息递归脱敏，敏感字段（password/token/API key/cookie/authorization 等）整值替换；跨文本、思考、工具参数/结果的秘密片段只对命中范围涉及的字符串整块脱敏，无关消息保留。PEM 保留 BEGIN/END 标记，仅替换后续连续的载荷行；缺少 END 时遇到普通正文即停止。未闭合的凭证引号仍可能匹配至后续文本末尾。`DLC_AK` / `DLC_SK`、独立 `AK` / `SK` 及带分隔符前缀的同类字段也会脱敏；从当前导出文本赋值中识别出的 AK/SK 值，其在其他文本中的重复出现（例如命令行位置参数）也会替换。不读取额外凭证文件，也不修改原文件。当前 Confab 凭证的精确值也会移除。升级规则不会删除或覆盖已上传的旧远程内容，需在后端单独清理；已泄露凭证应轮换。**Redaction is not exhaustive. This is not a safe publication
or anonymization guarantee.** Review whether the conversation is suitable for
this backend; do not enable for sensitive conversations.

There is no plugin byte cap on aggregate source text or serialized JSONL. Snapshots
are built in memory, remain subject to available memory and the 20,000-message
limit, and are never silently truncated. A single
serialized chunk line must fit the plugin's 14 MiB JSON-encoded chunk budget,
aligned with the upstream CLI (upstream backend request-body limit: 16 MiB).
This is not a verified limit for a particular deployment or its reverse proxy.
HTTP 413 is reported explicitly without exposing response bodies. The old 512 KiB
budget was a plugin-local limit, not a server limit. No transcript is
written to disk. Only one upload runs at once, with one coalesced pending request.

## 增量同步与分支

同一 Pi 会话、后端和凭证使用持久化的 `pi-live-` 远程标识。消息 ID 与会话内原始条目关联，不再随着对话增长而整体变化。每次同步先比较脱敏后记录的逐行 SHA-256 指纹，只有完整匹配已有历史前缀时才沿用远程会话，再通过 init 查询服务端偏移，仅上传尚未接收的记录。重复同步不会重复追加。

分叉、回退、历史修改、脱敏结果变化或不兼容的导出格式变化会创建新的远程会话，不向旧历史混写。回到已保存且完全匹配的分支可以继续使用原标识。更换凭证或 Pi 会话 ID 会建立独立映射。旧版 `pi-compat-` 快照不迁移、不删除；升级后首次同步创建一个新的增量会话。

同步映射保存在 `~/.pi-confab/sync-state/`，目录 0700、文件 0600，只包含哈希、远程标识和脱敏标题，不保存会话正文。上传前先原子保存预期指纹；即使上传结果不确定，后续也只能续传完全一致的前缀。偏移和确认值必须精确匹配，不自动重放结果未知的分块请求。最多保留 100 个分支映射，不静默淘汰历史。

跨进程使用独占锁，避免两个 Pi 同时向同一映射写入分歧内容。正常完成、取消或失败会释放锁；强制杀进程可能留下 `.lock` 文件，需先确认该会话没有其他同步进程再手动清理。不要删除仍在使用的锁文件。删除映射后会创建新远程会话，无法仅凭本地正文恢复旧映射。

## Transport and storage

Origins default to HTTPS, except HTTP localhost / IPv4 loopback / IPv6 `::1`.
Other HTTP origins require explicit TUI consent at login, persisted as `allowHttp: true`
in that backend's private credential. API calls still reject HTTP without that flag.
Credentials, paths (other than `/`), query strings and fragments are rejected.
Redirects are rejected, including same-origin redirects. Device verification
links must stay on the selected origin. Requests have 15-second deadlines and
256 KiB response caps; device login is capped at 15 minutes, sync at 5 minutes.
Backend errors are not shown verbatim or logged by the adapter.

The only saved credential is Pi-owned `~/.pi-confab/credential.json` (directory
0700, file 0600). Unsafe ownership/permissions, symlink path components, file
symlinks, hardlinks and nonregular files are refused. Atomic private-file writes
occur only after validated login and a current cancellation-generation check.
No global Confab credentials or other extension configuration are read. This
protects against accidental exposure, not a compromised same-user process or
administrator. Deleting this private file removes the local login; revoke keys
and delete remote exports through your backend management UI as needed.

## Verification

Protocol checked against the local upstream clones: CLI `pkg/sync/client.go`,
backend `internal/auth/oauth_device.go`, `internal/api/sync.go`, `API.md`, and web
`src/schemas/claudeTranscript.ts` / `src/router.tsx`.
Offline tests: `node --test packages/pi/tests/confab*.test.mjs`.
No live deployment or browser integration is asserted by these tests.
