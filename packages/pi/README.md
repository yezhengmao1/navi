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

`magic-ui` 统一包含字标、编辑器/状态栏、折叠显示、通用 `questionnaire` 工具、`/quota` 和 `/split`（复制会话到新分屏，仅 herdr 交互终端）。问卷只提供单选、多选、确认、取消能力，不包含简报等业务选项；由 skill 传入问题和处理答案。`safety-guard.ts` 统一负责命令确认、敏感路径写入确认和清空会话；另有独立的 siflow 特定模型采样扩展。新版 OpenAI 登录暂无已验证额度接口；旧 Codex OAuth 支持手动查询路径，不自动轮询。扩展会影响界面或执行行为，请先审核源码。

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

**入口合并：** `magic-header.ts`、`compact-display.ts`、`codex-quota.ts`、`magic-ui.ts` 已合并为 `magic-ui/`，不再单独加载。`herdr-fork/` 也已移入 `magic-ui/herdr-fork/`，命令改名为 `/split`，行为不变，不覆盖内置 `/fork`；移除旧的独立加载路径及全局 `herdr-fork` 副本，避免重复注册（兼容安装脚本会清理旧入口）。项目的 `brief-select` 已由通用问卷替代，无需保留旧入口。

**迁移注意：** 若旧脚本已在 `~/.pi/agent/extensions/`、`~/.pi/agent/themes/` 中留下同名文件或软链接，先审核并移除旧副本，再启用 package；Pi 不会自动把旧复制文件识别为同一个包。迁移源码本身不会修改用户配置或切换当前会话的加载来源。

兼容脚本仍可从任意目录运行（与 package 安装方式二选一）：

```bash
./packages/pi/install-extensions.sh --link
```

脚本会覆盖同名全局文件，并清理列出的旧扩展；`--uninstall` 按文件名删除，**不验证归属**。使用前检查目标目录，避免删除自行修改或另行安装的同名文件。

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
