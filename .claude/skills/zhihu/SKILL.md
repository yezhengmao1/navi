---
name: zhihu
description: 获取知乎当前热榜话题
user-invocable: true
allowed-tools: WebFetch
---

# 知乎热榜

## 任务

获取知乎当前热榜话题并以表格形式呈现给用户。

## 数据获取

使用 WebFetch 抓取：

```
https://api.zhihu.com/topstory/hot-list?limit=50
```

对每个条目提取：
- `title` — 问题标题
- `url` — 问题链接（知乎问题页 URL，格式如 `https://www.zhihu.com/question/{id}`）
- `detail_text` — 热度描述（如 "xxx 万热度"）

## 输出格式

```
## 知乎热榜

| # | 话题 | 热度 | 链接 |
|---|------|------|------|
| 1 | 问题标题 | xxx万 | zhihu.com/question/xxx |
```

## 格式要求

- **话题列**：显示问题标题原文
- **热度**：显示热度值，如 "792万"
- **链接列**：用短格式 `zhihu.com/question/xxx`，不加 `https://www.` 前缀
- 列出所有热榜条目（通常 30 条），不要截断
- 用中文输出
