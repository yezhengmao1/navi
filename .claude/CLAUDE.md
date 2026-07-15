# Navi — 每日助手

这个仓库包含 Claude Code skills，用于论文追踪、GitHub 热榜和知乎热榜：

## Skills

| 命令 | 说明 |
|------|------|
| `/arxiv` | 筛选今日 arxiv 上 LLM 基模、训练系统和大模型安全相关论文 |
| `/paper sync\|ask\|status` | Zotero 论文库同步 + PaperQA2 语义问答（带引用）|
| `/github [language]` | GitHub 每日热门仓库，支持按语言筛选 |
| `/zhihu` | 知乎当前热榜话题 |
| `/hfpapers` | Hugging Face Daily Papers 今日热门论文 |
| `/hackernews` | Hacker News 当前热门帖子 |
| `/producthunt` | Product Hunt 今日热门产品 |
| `/brief` | 每日简报，聚合以上所有信息源；可选一并推送飞书群（无参数时弹窗询问）|
| `/swanlab-analyze [实验]` | 分析 SwanLab 训练实验，自动挖掘指标关系并诊断 |
| `/swanlab-monitor [实验]` | 实时监控运行中的训练实验，研判异常并告警（配 `/loop`） |
| `/server add\|list\|remove` | 管理远程服务器清单（名字/IP/登录方式）|
| `/navi sync\|pull\|status` | 把 `~/.navi`（config + cache）镜像备份到 WebDAV，换机可恢复 |
| `/hiboard` | 把任务结果推送到华为/荣耀手机「负一屏」（HiBoard 服务动态）|
| `/feishu 「内容」` | 把内容推送到飞书群自定义机器人（webhook，KEY 可传参或配置）|
| `/dlc list\|logs\|workspaces` | 查阿里云 PAI-DLC 训练任务（跨工作空间列 Running + 卡数/时长/属主，取节点日志）|

## Paper — Zotero 论文库语义问答

把 Zotero 的 PDF 同步到本地，用 [PaperQA2](https://github.com/Future-House/paper-qa) 建索引/向量，命令行对自己的论文库做**带引用的语义问答**。LLM 与 embedding 走 SiliconFlow（OpenAI 兼容）。

设计原则：**取数自包**（`zotero_sync.py` 纯 stdlib 走 Zotero API + WebDAV，md5 去重）+ **核心交给 PaperQA2**（解析/切块/向量/检索/引用），skill 只编排 CLI。

```bash
pip install -r .claude/skills/paper/requirements.txt   # 依赖 paper-qa
python3 .claude/skills/paper/paper.py sync             # 同步 + 建索引（增量；--full 重建）
python3 .claude/skills/paper/paper.py ask "问题"       # 带引用问答（省略问题进交互式）
python3 .claude/skills/paper/paper.py status           # 查看 cache / 索引
```

文件结构：
- `.claude/skills/paper/paper.py` — CLI 入口（sync / ask / status）
- `.claude/skills/paper/config.py` — 读配置 + 构造 PaperQA `Settings`（处理 SiliconFlow 的 `encoding_format` 与 gpt-4o 默认值覆盖）
- `.claude/skills/paper/zotero_sync.py` — 自包同步（Zotero API + WebDAV + md5 去重）

配置：`~/.navi/config.toml` 的 `[paper]`（cache + SiliconFlow key + 模型）与 `[zotero]`（API key + WebDAV）。可挂 cron 每日 `paper sync` 增量同步。

## MCP — 思源笔记

通过 MCP Server 连接思源笔记，支持文档创建、编辑、搜索等操作。配置在仓库根 `.mcp.json` 中（Claude Code 只从 `.mcp.json` / `~/.claude.json` 读取 MCP server，不读 `settings.json`）。

文件结构：
- `mcp/siyuan/index.js` — MCP Server 实现
- `mcp/siyuan/package.json` — 依赖声明

## SwanLab 训练实验分析 / 监控

从 SwanLab（支持自建/云）读取大模型训练实验的原始指标，**自动挖掘指标间关系**（相关 / 领先滞后 / 同步变点 / 指标族离群）并诊断；运行中实验可**实时监控**。分析与监控**拆成两个独立 skill**，各司其职。

设计原则：**最小职责**——取数全部走 `tools/` 下的单一功能脚本（一个脚本只干一件事），脚本只回**裸数据**（不算统计、不判异常）；分析由 `swanlab-analyst` agent 完成；skill 只负责编排。

文件结构：
- `.claude/skills/swanlab-analyze/SKILL.md` — 分析编排器（深度挖掘关系 + 诊断）
- `.claude/skills/swanlab-monitor/SKILL.md` — 监控编排器（单周期研判，配 `/loop` 持续盯）
- `.claude/skills/swanlab/` — **两个 skill 共享的资产包**（无 SKILL.md）
  - `tools/` — 单一功能取数脚本（凭证读 `~/.navi/config.toml`）
    - `_common.py` — 共享管线（读配置→构造 `swanlab.Api`），非工具
    - `list_projects.py` / `list_experiments.py` — 列项目 / 列实验
    - `get_summary.py` — 实验指标 summary（兼做指标发现）
    - `get_metrics.py` — 原始折线点（支持 `--all` / `--tail` / `--since-step` / `--out csv`）
  - `metrics.example.md` — **指标说明默认模板**
- `.claude/agents/swanlab-analyst.md` — 指标分析 agent（pandas 挖掘关系 + 诊断）

**指标说明（用户唯一需维护的文件）**：`~/.navi/swanlab-metrics.md`（不存在则回退到 `metrics.example.md`）。
只描述「单个指标是什么」（含义/期望趋势/健康范围/异常信号）；**指标之间的关系由 workflow 自动从数据挖掘**，无需手写，文末可选填强耦合先验。

依赖：`pip install -U swanlab`（需 >=0.8.0，提供 `swanlab.Api`）。

## Navi 配置/缓存 WebDAV 备份

把整个 `~/.navi/`（`config.toml` + `paper-cache/` + `swanlab-metrics.md` 等）镜像到 WebDAV，多机同步 / 换机恢复。URL 与 WebDAV 账号全部写在 `[navi]` 段（`webdav_url` / `webdav_user` / `webdav_password`），独立配置，不复用其它段。

设计原则：**取数自包**（`webdav.py` 纯 stdlib，PROPFIND/PUT/GET/DELETE，跟随 alist 的 302 直链；OSS 后端目录隐式，靠 PUT 隐式建路径）+ **增量**（`~/.navi/.navi-sync.json` 记每文件 md5，未变跳过；日志/锁/`__pycache__` 不传）。

```bash
python3 .claude/skills/navi/navi.py sync             # 本地 → WebDAV（增量；--delete 真镜像）
python3 .claude/skills/navi/navi.py pull             # WebDAV → 本地（换机恢复）
python3 .claude/skills/navi/navi.py status           # 看本地与远端差异
```

文件结构：
- `.claude/skills/navi/navi.py` — CLI 入口（sync / pull / status）
- `.claude/skills/navi/webdav.py` — 极简 WebDAV 客户端

可挂 cron 每日 `navi sync` 增量备份。`[navi]` 段三项必填：`webdav_url` / `webdav_user` / `webdav_password`。

## Hiboard — 负一屏推送

任务完成后把 markdown 结果推送到华为/荣耀手机「负一屏」（HiBoard 服务动态）。原理是一次
HTTPS POST 到负一屏云端点，body 带 `authCode` + 一条 `msgContent`（markdown 正文）。

设计原则：**极简自包**——`push.py` 纯 stdlib（`urllib` + `tomllib`），只做「读配置 → 拼
标准 payload → POST → 解析响应码」，无外部依赖。

```bash
python3 .claude/skills/hiboard/push.py --data task.json          # 推送（JSON 文件，格式最稳）
python3 .claude/skills/hiboard/push.py --data task.json --dry-run # 只看 payload 不发
```

文件结构：
- `.claude/skills/hiboard/SKILL.md` — 编排说明
- `.claude/skills/hiboard/push.py` — CLI 入口（读配置 + 构造 payload + 推送）

配置：`~/.navi/config.toml` 的 `[hiboard]` 段，`auth_code` 必填（手机负一屏 → 我的 →
动态管理 → 关联账号 → Claw 智能体 获取），`push_url` 可选（默认华为云端点）。

## Feishu — 飞书群机器人推送

把 markdown 内容推送到飞书群「自定义机器人」。webhook 形如
`https://open.feishu.cn/open-apis/bot/v2/hook/<KEY>`，**KEY 可传参（`--key`，优先）
或写进配置**。无标题走 `text` 消息，带 `--title` 自动升级为 `interactive` 卡片
（正文按 `lark_md` 渲染 markdown）。

设计原则：**极简自包**——`push.py` 纯 stdlib（`urllib` + `tomllib`），读入参/配置的
KEY → 拼 payload → POST → 解析 `code`，无外部依赖。

```bash
python3 .claude/skills/feishu/push.py --key <KEY> --content report.md        # 纯文本
python3 .claude/skills/feishu/push.py --key <KEY> --title 简报 --data task.json # markdown 卡片
python3 .claude/skills/feishu/push.py --data task.json --dry-run             # 只看 payload
```

文件结构：
- `.claude/skills/feishu/SKILL.md` — 编排说明
- `.claude/skills/feishu/push.py` — CLI 入口（KEY 参数优先，回退 `[feishu].key`）

配置：`~/.navi/config.toml` 的 `[feishu]` 段可选填 `key`（`--key` 未传时用）与 `base_url`
（默认飞书官方端点）。机器人若开了「签名校验」本 skill 不支持，请改用「自定义关键词」。

## DLC — 阿里云 PAI-DLC 任务查询

用阿里云官方 SDK 读训练任务列表与日志。先 `ListWorkspaces` 拿到你能访问的**全部**工作空间，
再逐个 `ListJobs`（`show_own=False`），这样看得到同事在同一工作空间的任务；GPU 卡数 / 已运行时长 /
属主（真人名 `username`）都取自 `ListJobs` 返回项，列表无需逐个 `GetJob`，只有 `logs` 才按 pod 取。

设计原则：**取数交给官方 SDK**，skill 只编排 + 中文小结；`list` 默认只列 `Running` 且滤掉 GPU=0
的辅助任务（convert-ckpt 等），并给出合计卡数与「我 vs 他人」拆分。

```bash
pip install alibabacloud_pai_dlc20201203 alibabacloud_aiworkspace20210204 alibabacloud_tea_openapi
python3 .claude/skills/dlc/dlc.py list                    # 全部 Running（跨工作空间 + 合计卡数）
python3 .claude/skills/dlc/dlc.py logs <jobid> --lines 50 # 最后一个节点的日志尾部
python3 .claude/skills/dlc/dlc.py workspaces              # 列可访问工作空间
```

文件结构：
- `.claude/skills/dlc/SKILL.md` — 编排说明
- `.claude/skills/dlc/dlc.py` — CLI 入口（list / logs / workspaces）

配置：`~/.navi/config.toml` 的 `[dlc]` 段（`access_key_id` / `access_key_secret` / `region`，
`workspace_id` 可选）。**务必用 RAM 子账号只读密钥**，别用主账号 AK。

### 巡检 agent（dlc-inspector）

`.claude/agents/dlc-inspector.md` —— 训练集群值守 agent。用 `dlc` skill 列全部 Running 任务、
并行取每个任务最后节点日志，逐个研判（🔴 HANG 挂起 / nan / loss 崩坏，⚠️ 数据加载抖动 / 吞吐骤降，
✅ 正常，含进度与预估完成时间），整理成分级报告并用 `hiboard` skill 推送负一屏、`feishu` skill
推送飞书群。取数/告警全走 skill 的脚本，自己不碰 API；只告警不改任务。**飞书 KEY 在触发时以参数
给出、不落盘**，不给则只推负一屏。可配 `/loop` 定时值守：

```
用 dlc-inspector agent 巡检一次 DLC 任务并推送负一屏
用 dlc-inspector agent 巡检 DLC 任务，飞书 KEY 用 1b64311b-...，推送负一屏和飞书
```

## tmux-claude-status

tmux 插件，通过 Claude Code hooks 实时追踪所有 Claude 实例状态，`prefix + a` 弹窗查看。

```bash
# 安装（写入 hooks 到 ~/.claude/settings.json + tmux 快捷键）
bash integrations/tmux-claude-status/install.sh

# 卸载
bash integrations/tmux-claude-status/install.sh --uninstall
```

文件结构：
- `integrations/tmux-claude-status/status-hook.sh` — hook 脚本，事件触发时写状态到 `/tmp/claude-status/`
- `integrations/tmux-claude-status/claude-status.sh` — 弹窗显示脚本
- `integrations/tmux-claude-status/statusline.sh` — 状态栏组件，有 approval 时显示 ✨
- `integrations/tmux-claude-status/install.sh` — 安装/卸载

## token-statusline — Token 用量状态栏

在 Claude Code 状态栏**常驻一行**显示模型 / 上下文 / 订阅额度 / 燃烧速率 / 今日总 token，
把 claude-hud（上下文%）+ ccusage（燃烧速率、今日 token）+ hook 原生 `rate_limits`（5h 额度）
合成一行：

```
🤖 Opus 4.8 | 🧠 61% (92k) | ⏳ 5h 42% (1h5m) | 🔥 $23.7/hr | 📅 67.6M today
```

设计原则：**前台零重活**——模型 / 上下文% / 5h 额度全部从 hook JSON 与 claude-hud 本地取
（渲染 ~0.1s）；ccusage 的慢活（`daily` 今日 token、`statusline` 燃烧速率，都要扫全量日志）
**后台异步刷新**写缓存（`flock` 防并发），状态栏只读缓存永不阻塞。无 Node 环境用 **bun** 跑
ccusage / claude-hud。

- `~/.claude/statusline.sh` — 合成脚本（`settings.json` 的 `statusLine` 指向它）
- `~/.claude/claude-hud/dist/` — claude-hud（手动接线，只取其上下文%）
- ccusage — bun 全局装，仅用 `daily` / `statusline`
- 完整安装步骤与脚本：`integrations/token-statusline/README.md`

额度段（`⏳`）与内置 `/usage` 同源（hook 的 `rate_limits`），仅订阅账号 + 较新 Claude Code 下发；
缺字段时自动省略。看准确额度进度用 `/usage`。

## 安装引导

当用户首次使用或询问如何安装时，按以下步骤引导：

### 1. MCP 依赖

检查 `mcp/siyuan/node_modules` 是否存在，不存在则执行：

```bash
cd mcp/siyuan && npm install
```

### 2. 配置文件

检查 `~/.navi/config.toml` 是否存在。不存在则创建，并询问用户填入以下配置：

```toml
[github]
token = "ghp_xxx"           # GitHub token，无需勾选任何 scope

[siyuan]
url = "http://127.0.0.1:6806"
token = "your-siyuan-api-token"

[swanlab]
api_host = "http://host:port/api"   # SWANLAB_API_HOST，自建后端地址（云可留空）
web_host = "http://host:port"       # SWANLAB_WEB_HOST，前端地址（可留空）
api_key  = "your-swanlab-api-key"   # SWANLAB_API_KEY
username = ""                        # 默认 workspace（可选）
project  = ""                        # 默认项目（可选）

[zotero]                              # /paper 同步论文用
api_key         = "your-zotero-key"  # Zotero Web API key（read 即可）
user_id         = "1234567"          # 数字 userID
webdav_url      = "https://host/dav/.../zotero/"  # 附件 WebDAV（以 zotero/ 结尾）
webdav_user     = "name"
webdav_password = "secret"

[paper]                               # /paper 问答用
cache     = "~/.navi/paper-cache"    # PDF + 索引 + manifest 根目录
api_key   = "sk-..."                  # SiliconFlow key
base_url  = "https://api.siliconflow.cn/v1"
llm       = "deepseek-ai/DeepSeek-V3"
embedding = "Qwen/Qwen3-Embedding-8B"
```

如果用户不需要某项功能，对应配置可以跳过。`/paper` 还需 `pip install -r .claude/skills/paper/requirements.txt`。

### 3. Token 用量状态栏

按 `integrations/token-statusline/README.md` 装 bun + ccusage + claude-hud，把用量常驻状态栏
（模型 / 上下文 / 5h 额度 / 燃烧速率 / 今日 token）。只想要 claude-hud 官方版可直接
`/plugin marketplace add jarrodwatts/claude-hud` → `/plugin install claude-hud` → `/claude-hud:setup`。

### 4. tmux-claude-status（可选）

如果用户使用 tmux，执行：

```bash
bash integrations/tmux-claude-status/install.sh
```

## 配置

配置文件位于 `~/.navi/config.toml`：

```toml
[github]
token = "ghp_xxx"

[siyuan]
url = "http://127.0.0.1:6806"
token = "your-siyuan-api-token"

[swanlab]
api_host = "http://host:port/api"   # SWANLAB_API_HOST（云可留空）
web_host = "http://host:port"       # SWANLAB_WEB_HOST（可留空）
api_key  = "your-swanlab-api-key"   # SWANLAB_API_KEY
username = ""                        # 默认 workspace（可选）
project  = ""                        # 默认项目（可选）

[zotero]
api_key         = "your-zotero-key"
user_id         = "1234567"
webdav_url      = "https://host/dav/.../zotero/"
webdav_user     = "name"
webdav_password = "secret"

[paper]
cache     = "~/.navi/paper-cache"
api_key   = "sk-..."                  # SiliconFlow key
base_url  = "https://api.siliconflow.cn/v1"
llm       = "deepseek-ai/DeepSeek-V3"
embedding = "Qwen/Qwen3-Embedding-8B"
```

## 输出规范

- 默认用中文输出
- 论文标题、作者等保留英文原文
- 摘要翻译为中文
