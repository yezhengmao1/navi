# Navi Pi 扩展包

原独立 Pi 扩展项目的通用扩展已纳入此目录。这里是**可选 Pi package 源码**，不是项目自动加载目录；项目所用的通用 `subagent` 执行扩展仍位于仓库根 `.pi/extensions/`；业务角色在 `.pi/agents/`，业务流程在 `.agents/skills/`。

## 目录

```text
packages/pi/
├── package.json             # Pi package manifest
├── extensions/
│   ├── magic-ui/index.ts    # 唯一 UI 入口，内部按职责分模块
│   ├── safety-guard.ts     # 执行安全规则与清空会话确认
│   └── …                  # 其他独立扩展，见 extensions/README.md
├── themes/magic.json        # magic 主题
├── tests/                   # 离线 Node 测试
└── install-extensions.sh    # 兼容旧的全局复制/软链接安装
```

`magic-ui` 统一包含字标、编辑器/状态栏、折叠显示、通用 `questionnaire` 工具和 `/quota`。问卷只提供单选、多选、确认、取消能力，不包含简报等业务选项；由 skill 传入问题和处理答案。`safety-guard.ts` 统一负责命令确认、敏感路径写入确认和清空会话；另有独立的 siflow 特定模型采样扩展。新版 OpenAI 登录暂无已验证额度接口；旧 Codex OAuth 支持手动查询路径，不自动轮询。扩展会影响界面或执行行为，请先审核源码。

## 安装（从仓库根执行）

推荐使用 Pi 原生 package 管理，无需在此目录运行 `npm install`：

```bash
# 仅当前项目
pi install --local ./packages/pi

# 或所有项目（两者择一）
pi install ./packages/pi
```

安装后在 Pi 中 `/reload`，通过 `/settings` 选择 `magic` 主题，通过 `pi config` 管理资源。

**安全扩展合并：** `clear.ts` 和 `command-guard.ts` 已合并为 `safety-guard.ts`；`/clear`、`shell-guard-review` 和 `heavy-review` 名称及行为不变。若使用显式扩展路径，请改为新文件；旧的全局副本需移除，避免重复注册。

**入口合并：** `magic-header.ts`、`compact-display.ts`、`codex-quota.ts`、`magic-ui.ts` 已合并为 `magic-ui/`，不再单独加载。`/split` 已移除，不影响内置 `/fork`。若曾单独安装 `herdr-fork/`，请移除其显式加载路径和全局副本（兼容安装脚本会清理旧入口）。项目的 `brief-select` 已由通用问卷替代，无需保留旧入口。

**迁移注意：** 若旧脚本已在 `~/.pi/agent/extensions/`、`~/.pi/agent/themes/` 中留下同名文件或软链接，先审核并移除旧副本，再启用 package；Pi 不会自动把旧复制文件识别为同一个包。迁移源码本身不会修改用户配置或切换当前会话的加载来源。

兼容脚本仍可从任意目录运行（与 package 安装方式二选一）：

```bash
./packages/pi/install-extensions.sh --link
```

脚本会覆盖同名全局文件，并清理列出的旧扩展；`--uninstall` 按文件名删除，**不验证归属**。使用前检查目标目录，避免删除自行修改或另行安装的同名文件。

## magic-relay：让 agy 的结果唤醒 Pi

在已信任的项目中启动 Pi 交互会话，确保本机 `agy` 已登录（从绝对 PATH 目录或 `~/.local/bin` 查找），执行 `/reload`。例如：

```text
/relay agy 检查当前分支的测试覆盖，只读，列出遗漏的测试用例
/relay status
/relay cancel
```

也可以直接对 Pi 说「用 agy 检查测试覆盖」。模型调用 `magic_relay` 时需你确认实际发送的任务；手动输入 `/relay agy …` 则直接派发。每次在当前工作目录启动一个新的 `agy acp --stdio --sandbox` 会话，只发送任务文本，不复制 Pi 的聊天历史。agy 使用自己的账号、模型和工具，可能收费，也可能更改工作目录；不会替它批准权限请求。

确认框默认选中「拒绝」，任务每页最多三行；↑↓ 翻页，←→ 选拒绝或允许，Enter 提交，Esc 取消。回报默认只显示状态和结果预览，展开后可查看完整任务和回报。

需要固定模型时，让 Pi 把要求填入 `magic_relay` 的 `model` 和 `thoughtLevel` 参数（例如 `gemini-4-neon`、`xhigh`），而不只是写进任务正文。插件在发送任务前从 ACP 确认所要求的配置，不能确认就不派发。若收到 `end_turn` 却没有最终正文，且 agy 支持 `session/load`，插件只回读一次同一会话，不重发任务。仍没有正文时回报失败，而不把思考、工具日志或旧轮次当成结果。

同一 Pi 会话同时只运行一个任务，最长 15 分钟。成功或失败都会把结果发回原会话：Pi 空闲时自动开始下一轮，忙时排到当前工作之后，不需要轮询。取消、切换会话/分支、重载或退出会终止尚在运行的直接子进程，丢弃迟到的结果，不恢复、不重试；不会撤回已送达的消息、已执行的文件操作或已发生的费用。目前仅支持交互式 TUI 和 agy，不是持久任务队列。

## magic-go：让当前会话持续推进一个目标

在 Pi 里输入 `/go --tokens 50k 修复失败的测试；以完整测试套件通过为验收条件`。省略 `--tokens` 时默认 1,000,000 **输出 tokens**；显式 `--tokens` 也只限制输出。命令只启动当前会话，不创建子进程或委派给 agy。普通聊天不会自行启动目标。

- `/go` 或 `/go status` 查看目标、状态、用量和最近的结果或阻塞原因。
- `/go pause` 暂停，`/go resume` 显式恢复，`/go clear` 清除目标。暂停或清除运行中的目标会请求中止本轮，但不会撤销已执行的操作。
- 插件在 Pi 的 `agent_before_settle` 边界请求下一轮，不抢先于已有的排队消息。模型用 `magic_go_report` 报告完成证据或阻塞；报告不是独立验收，也不授予额外工具权限。
- 用量按模型返回的 `usage.output` 在轮末累计；输入和缓存读写均不扣预算，也不使用 `totalTokens` 估算。这不是硬消费上限。旧版总量与输出量不可换算，旧目标显式恢复后从零累计输出，预算数值不变。预算耗尽、无法计量、出错或中止时不再自动续跑；预算耗尽后需新建目标。状态保存在当前会话分支，重载、恢复会话或切换分支时不会自动重启目标。

## UI 刷新与性能

- 输入框与已发送消息使用静态亮色背景；没有装饰动画定时器。
- 组件发现由消息/工具开始结束、会话切换或压缩等结构事件触发。流式 delta 不扫描全部历史，已挂载的 assistant 通过实例 `updateContent` 适配新内容块。
- 扩展的刷新请求在 50ms 窗口内合并；正常渲染只检查待处理标记。保留 Pi 原生流式刷新，不限流模型输出。
- 静态页眉按宽度、展开状态和主题缓存；历史耗时标题及消息装饰也有缓存。
- 今日用量每 15 秒检查一次，仅在数值或可用状态变化时请求重绘。任务运行时仍保留秒级计时。
- 重载、切换和卸载时清理待执行刷新；从全局复制目录加载的会话需要 `/reload` 才能使用修改后的代码。

## 验证

从仓库根执行：

```bash
node --test packages/pi/tests/*.test.mjs
bash -n packages/pi/install-extensions.sh
```

也可在本目录执行 `npm test`。测试按自身文件位置解析扩展，不依赖当前工作目录；默认查找 `~/.pi/agent/install/current-version` 对应的 Pi，可用 `PI_PACKAGE_ROOT=/path/to/@earendil-works/pi-coding-agent` 覆盖。

测试不请求模型、不轮询额度、不更改真实用户配置。它们覆盖部分 UI 和生命周期行为，不代表命令安全规则或所有终端表现已完整验证。
