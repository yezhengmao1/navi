---
name: brief
description: 每日简报，并行调用 arxiv / 知乎 / HN / GitHub / Product Hunt
user-invocable: true
allowed-tools: Agent
context: fork
---

# 每日简报

## 任务

并行调用以下 5 个 skill，汇总为一份精简日报。

## 执行步骤

### 第一步：并行启动

用 Agent 工具同时启动 5 个 agent，每个 agent 调用一个 Skill：

1. `Skill: arxiv`
2. `Skill: zhihu`
3. `Skill: hackernews`
4. `Skill: github`
5. `Skill: producthunt`

每个 agent 的 prompt 为：`使用 Skill 工具调用 {skill名}，将完整输出返回给我。`

### 第二步：汇总输出

等所有 agent 完成后，将结果汇总为以下格式：

```
# 每日简报 — {yyyy-mm-dd}

（依次输出每个 skill 的完整结果，保持各自原有格式）
```

## 注意事项

- 某个源获取失败时跳过该板块并注明，不阻塞其他板块
- 保持各 skill 的原始输出格式，不做二次精简
