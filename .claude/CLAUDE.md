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

## 配置

配置文件位于 `~/.navi/config.toml`：

```toml
[github]
token = "ghp_xxx"
```

## 输出规范

- 默认用中文输出
- 论文标题、作者等保留英文原文
- 摘要翻译为中文
