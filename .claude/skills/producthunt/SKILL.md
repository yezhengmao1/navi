---
name: producthunt
description: 获取 Product Hunt 今日热门产品
user-invocable: true
allowed-tools: WebFetch
---

# Product Hunt 今日热门

## 任务

获取 Product Hunt 今日热门产品并以表格形式呈现给用户。

## 数据获取

使用 WebFetch 抓取 Product Hunt 每日排行榜：

```
https://www.producthunt.com/leaderboard/daily/{yyyy}/{mm}/{dd}
```

其中 `{yyyy}/{mm}/{dd}` 为今天的日期。

从 HTML 中提取今日产品列表。每个产品需要：
- 产品名称
- 一句话介绍（tagline）
- 投票数（upvotes）
- 产品页链接

## 输出格式

```
## Product Hunt 今日热门

────────────────────────────────────────
  #: 1
  产品: ProductName / 产品中文名 (🔺 120)
  简介: 一句话中文介绍
  链接: https://producthunt.com/posts/xxx
```

每个产品之间用 `────────────────────────────────────────` 分隔。

## 格式要求

- **产品名**：保留英文原名，同时附上中文翻译，格式为 `ProductName / 中文名`，票数紧跟产品名后方，格式为 `(🔺 数字)`
- **简介**：翻译为中文，保留关键术语
- **链接**：使用完整 `https://` 协议前缀
- 列出所有今日产品，不要截断
- 除产品名英文部分外用中文输出
