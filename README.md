<p align="center">
  <img src="assets/logo.svg" width="120" alt="Navi">
</p>

<h1 align="center">Navi - Hey Listen</h1>

基于 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) Skills 构建的个人助手。通过斜杠命令快速获取每日资讯、深度阅读论文、连接笔记系统，让 Claude 成为你的日常工作伙伴。

## 功能

| 命令 | 说明 |
|------|------|
| `/arxiv` | 筛选今日 arxiv 上 LLM 基模和训练系统相关论文 |
| `/paper <URL/标题>` | 深度阅读 arxiv 论文，输出逐段总结、Review、核心要素提取 |
| `/github [language]` | GitHub 每日热门仓库，支持按语言筛选 |
| `/zhihu` | 知乎当前热榜话题 |
| `/hfpapers` | Hugging Face Daily Papers 今日热门论文 |
| `/hackernews` | Hacker News 当前热门帖子 |
| `/producthunt` | Product Hunt 今日热门产品 |
| `/brief` | 每日简报，聚合以上所有信息源 |

## 快速开始

```bash
git clone https://github.com/yezhengmao1/navi.git
cd navi
claude
```

进入 Claude Code 后，它会自动引导你完成安装配置（MCP 依赖、config.toml、claude-hud 状态栏等）。

安装完成后直接使用：

```
> /arxiv              # 今日 LLM/训练系统论文
> /paper Scaling Law  # 按标题搜索并深度阅读
> /github             # 今日 GitHub 热榜
> /github rust        # Rust 语言热榜
> /zhihu              # 知乎热榜
> /hfpapers           # HF 今日热门论文
> /hackernews         # Hacker News 热帖
> /producthunt        # Product Hunt 热门产品
> /brief              # 每日简报（聚合全部）
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

- `/github` 需要 GitHub token：[GitHub Settings > Personal access tokens](https://github.com/settings/tokens)，无需勾选任何 scope
- 思源笔记 MCP 需要配置 `siyuan.url` 和 `siyuan.token`

## 项目结构

```
.claude/
├── CLAUDE.md                    # 项目指令
├── settings.json                # MCP Server 配置
└── skills/
    ├── arxiv/SKILL.md           # arxiv 论文筛选
    ├── paper/SKILL.md           # 论文深度阅读
    ├── github/SKILL.md          # GitHub 热榜
    ├── zhihu/SKILL.md           # 知乎热榜
    ├── hfpapers/SKILL.md        # HF Daily Papers
    ├── hackernews/SKILL.md      # Hacker News
    ├── producthunt/SKILL.md     # Product Hunt
    └── brief/SKILL.md           # 每日简报
mcp/
└── siyuan/
    ├── index.js                 # 思源笔记 MCP Server
    └── package.json             # 依赖声明
scripts/
└── tmux-claude-status/
    ├── install.sh               # 安装/卸载
    ├── status-hook.sh           # hook 脚本
    ├── claude-status.sh         # 弹窗显示脚本
    └── statusline.sh            # 状态栏组件
```

## tmux-claude-status

tmux 插件，通过 Claude Code hooks 实时追踪所有 Claude 实例状态。

`prefix + a` 弹窗查看详情，按编号跳转到对应 pane。

```bash
# 安装（写入 hooks 到 ~/.claude/settings.json + tmux 快捷键）
bash scripts/tmux-claude-status/install.sh

# 卸载
bash scripts/tmux-claude-status/install.sh --uninstall
```

## License

[Hey-Listen License (HLL)](LICENSE)
