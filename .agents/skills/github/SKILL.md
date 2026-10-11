---
name: github
description: 获取 GitHub 每日热门仓库摘要，支持按语言筛选
---

# GitHub 每日热榜

## 任务

获取 GitHub 今日 trending 仓库并以表格形式呈现给用户。

## 数据获取

### 第一步：读取 token

用 `bash` 运行 Python，在进程内读取 `~/.navi/config.toml` 的 `[github].token`（可选）。不要打印 token，不把凭证带到输出、报告或子 agent prompt。配置不存在时使用公开接口。

### 第二步：抓取 trending 仓库列表

trending 是公开页面，用 curl 抓取，再用正则提取仓库名。把 `<language>` 替换为用户指定语言的 URL 编码；未指定时留空：

```bash
curl -fL --max-time 60 "https://github.com/trending/<language>" | python3 -c "
import sys, re
content = sys.stdin.read()
pattern = r'<h2[^>]*>\s*<a[^>]*href=\"/([^\"]+)\"'
matches = re.findall(pattern, content)
repos = [m.strip() for m in matches if '/' in m and m.count('/') == 1]
for r in repos:
    print(r)
"
```

抓取失败时如实报告，不编造榜单。

### 第三步：批量获取仓库详情

对每个仓库调用 GitHub API 获取 stars、forks、description：

用 Python urllib 请求 `https://api.github.com/repos/<owner>/<repo>`；若配置了 token，在进程内加 `Authorization: Bearer <token>` 请求头，否则匿名请求。设置超时，遇限流时注明，禁止输出请求头。

从 JSON 中提取 `full_name`、`stargazers_count`、`forks_count`、`description`。

可以用循环一次处理所有仓库。数量大时用 k 表示（如 1.2k）。

## 输出格式

```
## GitHub 每日热榜

────────────────────────────────────────
  #: 1
  仓库: owner/repo (⭐ 1.2k 🔀 300)
  简介: 详细的项目简介描述
  链接: https://github.com/owner/repo
```

每条仓库之间用 `────────────────────────────────────────` 分隔。

## 格式要求

- **仓库**：只显示 `owner/repo` 短名称 + stars 和 forks，格式为 `owner/repo (⭐ Stars 🔀 Forks)`
- **Forks 图标**：使用 🔀 不要用 🍴
- **简介**：尽量详细，英文翻译为中文，保留关键技术术语
- **链接**：仓库完整 URL `https://github.com/owner/repo`
- 如果用户指定了语言（`用户请求`），在标题中注明（如 "GitHub 热榜 — Python"）
- 用中文输出所有非代码内容
- 列出所有 trending 仓库，不要截断
