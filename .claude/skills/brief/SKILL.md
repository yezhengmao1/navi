---
name: brief
description: 每日简报，并行调用 arxiv / HF Papers / 知乎 / HN / GitHub / Product Hunt
user-invocable: true
allowed-tools: Agent, mcp__siyuan__list_notebooks, mcp__siyuan__create_doc
context: fork
---

# 每日简报

## 任务

并行调用以下 6 个 skill，汇总为一份精简日报。

## 执行步骤

### 第一步：并行启动

用 Agent 工具同时启动 6 个 agent，每个 agent 调用一个 Skill：

1. `Skill: arxiv`
2. `Skill: hfpapers`
3. `Skill: zhihu`
4. `Skill: hackernews`
5. `Skill: github`
6. `Skill: producthunt`

每个 agent 的 prompt 为：`使用 Skill 工具调用 {skill名}，将完整输出返回给我。`

### 第二步：汇总输出

等所有 agent 完成后，将结果汇总为以下格式：

```
# 每日简报 — {yyyy-mm-dd}

（依次输出每个 skill 的完整结果，保持各自原有格式）
```

### 第三步：写入思源笔记

尝试将简报写入思源笔记：

1. 调用 `mcp__siyuan__list_notebooks`，如果调用失败（MCP 未配置），跳过此步
2. 找到名为 **navi** 的笔记本，取其 ID
3. 调用 `mcp__siyuan__create_doc` 创建文档：
   - `notebook`: navi 的笔记本 ID
   - `path`: `/daily/{yyyy-mm-dd}` （当天日期）
   - `markdown`: 第二步汇总的完整简报内容

## 注意事项

- 某个源获取失败时跳过该板块并注明，不阻塞其他板块
- **全量输出**：保持各 skill 返回的完整条目数和原始格式，禁止截断、合并或精简（如知乎 30 条就写 30 条，不能只写 Top 10）
- 写入思源时同样使用完整内容，不得缩写
- 思源 MCP 未配置时跳过写入，不报错
