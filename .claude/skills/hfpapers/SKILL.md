---
name: hfpapers
description: 获取 Hugging Face Daily Papers 今日热门论文
user-invocable: true
allowed-tools: WebFetch
---

# Hugging Face Daily Papers

## 任务

获取 Hugging Face Daily Papers 今日热门论文并呈现给用户。

## 数据获取

使用 WebFetch 抓取 API：

```
https://huggingface.co/api/daily_papers?date={YYYY-MM-DD}&sort=trending
```

`date` 参数使用当天日期。返回 JSON 数组，列出全部结果。

从每个元素中提取：
- `paper.id` — arxiv ID，用于构造链接 `https://arxiv.org/abs/{id}`
- `paper.title` — 标题
- `paper.authors` — 作者列表，取每个元素的 `name` 字段
- `paper.summary` — 摘要
- `paper.upvotes` — 点赞数
- `paper.githubRepo` — GitHub 仓库链接（可能为空）
- `numComments` — 评论数

## 输出格式

```
## Hugging Face Daily Papers

────────────────────────────────────────
  #: 1
  标题: Paper Title (👍 42 💬 5)
  作者: Author1, Author2, ...
  摘要: 2-3 句中文摘要
  链接: https://arxiv.org/abs/xxxx.xxxxx
  代码: https://github.com/xxx/xxx
```

每篇论文之间用 `────────────────────────────────────────` 分隔。

## 格式要求

- **标题**：英文原标题 + 点赞数和评论数，格式为 `Title (👍 点赞 💬 评论)`
- **作者**：英文原名，最多列 5 位，超出用 `et al.`
- **摘要**：将英文摘要翻译/概括为 2-3 句中文
- **链接**：使用 `https://arxiv.org/abs/{paper.id}` 格式
- **代码**：仅在 `githubRepo` 非空时显示此行
- 列出全部论文，不要截断
- 除标题和作者外用中文输出
