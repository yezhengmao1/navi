# Navi — 每日助手

这个仓库包含 Claude Code skills，用于论文追踪、GitHub 热榜和知乎热榜：

## Skills

| 命令 | 说明 |
|------|------|
| `/arxiv` | 筛选今日 arxiv 上 LLM 基模和训练系统相关论文 |
| `/paper <URL/标题>` | 深度阅读 arxiv 论文 |
| `/github [language]` | GitHub 每日热门仓库，支持按语言筛选 |
| `/zhihu` | 知乎当前热榜话题 |
| `/hfpapers` | Hugging Face Daily Papers 今日热门论文 |
| `/hackernews` | Hacker News 当前热门帖子 |
| `/producthunt` | Product Hunt 今日热门产品 |
| `/brief` | 每日简报，聚合以上所有信息源 |
| `/swanlab-analyze [实验]` | 分析 SwanLab 训练实验，自动挖掘指标关系并诊断 |
| `/swanlab-monitor [实验]` | 实时监控运行中的训练实验，研判异常并告警（配 `/loop`） |

## MCP — 思源笔记

通过 MCP Server 连接思源笔记，支持文档创建、编辑、搜索等操作。配置在 `.claude/settings.json` 中。

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

## tmux-claude-status

tmux 插件，通过 Claude Code hooks 实时追踪所有 Claude 实例状态，`prefix + a` 弹窗查看。

```bash
# 安装（写入 hooks 到 ~/.claude/settings.json + tmux 快捷键）
bash scripts/tmux-claude-status/install.sh

# 卸载
bash scripts/tmux-claude-status/install.sh --uninstall
```

文件结构：
- `scripts/tmux-claude-status/status-hook.sh` — hook 脚本，事件触发时写状态到 `/tmp/claude-status/`
- `scripts/tmux-claude-status/claude-status.sh` — 弹窗显示脚本
- `scripts/tmux-claude-status/statusline.sh` — 状态栏组件，有 approval 时显示 ✨
- `scripts/tmux-claude-status/install.sh` — 安装/卸载

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
```

如果用户不需要某项功能，对应配置可以跳过。

### 3. claude-hud 状态栏

执行 `/claude-hud:setup` 安装 Claude Code 状态栏插件，在终端实时显示工作状态。

### 4. tmux-claude-status（可选）

如果用户使用 tmux，执行：

```bash
bash scripts/tmux-claude-status/install.sh
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
```

## 输出规范

- 默认用中文输出
- 论文标题、作者等保留英文原文
- 摘要翻译为中文
