<p align="center">
  <img src="assets/logo.svg" width="120" alt="Navi">
</p>

<h1 align="center">Navi - Hey Listen</h1>

基于 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) Skills 构建的个人每日信息获取工具。几个斜杠命令，快速掌握今天该知道的事。

## 功能

| 命令 | 说明 |
|------|------|
| `/arxiv` | 筛选今日 arxiv 上 LLM 基模和训练系统相关论文 |
| `/paper <序号/URL/关键词>` | 深度阅读 arxiv 论文，输出逐段总结、Review、核心要素提取 |
| `/github [language]` | GitHub 每日热门仓库，支持按语言筛选 |
| `/zhihu` | 知乎当前热榜话题 |

## 快速开始

```bash
git clone https://github.com/yezhengmao1/navi.git
cd navi
claude
```

进入 Claude Code 后直接使用：

```
> /arxiv             # 今日 LLM/训练系统论文
> /paper 1           # 深度阅读第 1 篇论文
> /github             # 今日 GitHub 热榜
> /github rust        # Rust 语言热榜
> /zhihu             # 知乎热榜
```

## 配置

`/github` 需要 GitHub token 来访问 API。创建配置文件 `~/.navi/config.toml`：

```toml
[github]
token = "ghp_xxx"
```

Token 获取：[GitHub Settings > Personal access tokens](https://github.com/settings/tokens)，无需勾选任何 scope。

## 项目结构

```
.claude/
├── CLAUDE.md                    # 项目指令
└── skills/
    ├── arxiv/SKILL.md           # arxiv 论文筛选
    ├── paper/SKILL.md           # 论文深度阅读
    ├── trending/SKILL.md        # GitHub 热榜
    └── zhihu/SKILL.md           # 知乎热榜
```

纯 Skills 项目，无额外依赖，克隆即用。

## License

[Hey-Listen License (HLL)](LICENSE)
