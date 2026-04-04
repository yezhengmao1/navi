# Navi — 每日助手

这个仓库包含 Claude Code skills，用于论文追踪、GitHub 热榜和知乎热榜：

## Skills

| 命令 | 说明 |
|------|------|
| `/arxiv` | 筛选今日 arxiv 上 LLM 基模和训练系统相关论文 |
| `/paper <序号/URL/关键词>` | 深度阅读 arxiv 论文 |
| `/github [language]` | GitHub 每日热门仓库，支持按语言筛选 |
| `/zhihu` | 知乎当前热榜话题 |

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
