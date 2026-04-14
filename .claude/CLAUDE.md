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

## MCP — 思源笔记

通过 MCP Server 连接思源笔记，支持文档创建、编辑、搜索等操作。配置在 `.claude/settings.json` 中。

文件结构：
- `mcp/siyuan/index.js` — MCP Server 实现
- `mcp/siyuan/package.json` — 依赖声明

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
```

## 输出规范

- 默认用中文输出
- 论文标题、作者等保留英文原文
- 摘要翻译为中文
