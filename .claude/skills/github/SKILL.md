---
name: github
description: 获取 GitHub 每日热门仓库摘要，支持按语言筛选
argument-hint: "[language]"
user-invocable: true
allowed-tools: WebFetch Bash Read
---

# GitHub 每日热榜

## 任务

获取 GitHub 今日 trending 仓库并以表格形式呈现给用户。

## 数据获取

### 第一步：读取 token

用 Bash 读取 `~/.navi/config.toml` 中 `[github]` 段的 `token`：

```bash
python3 -c "import tomllib; print(tomllib.load(open('$HOME/.navi/config.toml','rb'))['github']['token'])"
```

### 第二步：抓取 trending 仓库列表

如果 token 不为空，用 curl 抓取 GitHub trending 页面，用正则提取所有 `Box-row` 中的仓库名：

```bash
curl -s -H "Authorization: token $TOKEN" "https://github.com/trending/$ARGUMENTS" | python3 -c "
import sys, re
content = sys.stdin.read()
pattern = r'<h2[^>]*>\s*<a[^>]*href=\"/([^\"]+)\"'
matches = re.findall(pattern, content)
repos = [m.strip() for m in matches if '/' in m and m.count('/') == 1]
for r in repos:
    print(r)
"
```

如果 token 为空，回退到 WebFetch 抓取 `https://github.com/trending/$ARGUMENTS`。

### 第三步：批量获取仓库详情

对每个仓库调用 GitHub API 获取 stars、forks、description：

```bash
curl -s -H "Authorization: token $TOKEN" "https://api.github.com/repos/<owner>/<repo>"
```

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
- 如果用户指定了语言（`$ARGUMENTS`），在标题中注明（如 "GitHub 热榜 — Python"）
- 用中文输出所有非代码内容
- 列出所有 trending 仓库，不要截断
