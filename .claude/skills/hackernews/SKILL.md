---
name: hackernews
description: 获取 Hacker News 当前热门帖子
user-invocable: true
allowed-tools: WebFetch
---

# Hacker News 热榜

## 任务

获取 Hacker News 当前热门帖子并以表格形式呈现给用户。

## 数据获取

### 第一步：获取热门帖子 ID 列表

使用 WebFetch 抓取 top stories：

```
https://hacker-news.firebaseio.com/v0/topstories.json
```

返回一个 ID 数组，取前 30 个。

### 第二步：批量获取帖子详情

对每个 ID，用 WebFetch 抓取详情：

```
https://hacker-news.firebaseio.com/v0/item/{id}.json
```

从 JSON 中提取：
- `title` — 标题
- `url` — 链接（可能为空，表示 Ask HN / Show HN 等自帖）
- `score` — 得分
- `descendants` — 评论数
- `by` — 作者

对于无外链的帖子，链接指向 HN 讨论页：`news.ycombinator.com/item?id={id}`

为提高效率，可以并行抓取多个帖子详情。

## 输出格式

```
## Hacker News 热榜

────────────────────────────────────────
  #: 1
  标题: English Title (💬 45 🔥 120)
        中文翻译
  链接: https://example.com/article
  讨论: https://news.ycombinator.com/item?id=xxx
```

每条帖子之间用 `────────────────────────────────────────` 分隔。

## 格式要求

- **标题**：第一行为英文原标题 + 评论数和得分，格式为 `English Title (💬 评论数 🔥 得分)`；第二行缩进对齐，为中文翻译
- **链接**：文章原始链接，使用完整 `https://` 协议前缀；自帖则与讨论链接相同
- **讨论**：HN 讨论页链接 `https://news.ycombinator.com/item?id=xxx`
- 列出前 30 条，不要截断
- 除标题英文部分外用中文输出
