---
name: brief
description: 每日简报，并行调用 arxiv / HF Papers / 知乎 / HN / GitHub / Product Hunt
user-invocable: true
allowed-tools: AskUserQuestion, Agent, mcp__siyuan__list_notebooks, mcp__siyuan__create_doc
---

# 每日简报

## 任务

并行调用所选信息源 skill，汇总为一份精简日报。默认全部 6 个，调用前先让用户选择。

## 执行步骤

### 第一步：确定信息源

**若调用时带了参数**（如 `/brief arxiv 知乎`，`$ARGUMENTS` 非空），直接按参数匹配下表选定信息源，跳过提问。

**未带参数时**，用 `AskUserQuestion` 工具询问用户本次简报要包含哪些信息源。

> ⚠️ `AskUserQuestion` **每个问题最多 4 个选项**，6 个源塞不进一题。所以**拆成两个分类问题**
> 一次性问（`AskUserQuestion` 的 `questions` 传两个元素，会在同一弹窗里并列展示），**两题都 `multiSelect: true`**：
>
> - **第 1 题「学术论文类」**（`header: 论文源`）：`arxiv`、`HF Papers`
> - **第 2 题「社区热榜类」**（`header: 热榜源`）：`知乎`、`Hacker News`、`GitHub`、`Product Hunt`
>
> 两题合并即为全部 6 个源，用户可跨题任意勾选。

| 选项 | 对应 skill | 分类 |
|------|-----------|------|
| arxiv | `arxiv` | 论文源 |
| HF Papers | `hfpapers` | 论文源 |
| 知乎 | `zhihu` | 热榜源 |
| Hacker News | `hackernews` | 热榜源 |
| GitHub | `github` | 热榜源 |
| Product Hunt | `producthunt` | 热榜源 |

两题的勾选合并后决定要启动哪些 agent。若用户两题都未选或跳过，默认使用全部 6 个。

### 第二步：并行启动

用 Agent 工具为**用户所选的每个信息源**同时启动一个 agent，每个 agent 调用对应的 Skill。

每个 agent 的 prompt 为：`使用 Skill 工具调用 {skill名}，将完整输出返回给我。`

### 第三步：汇总输出

等所有 agent 完成后，将结果汇总为以下格式：

```
# 每日简报 — {yyyy-mm-dd}

（依次输出所选每个 skill 的完整结果，保持各自原有格式）
```

### 第四步：写入思源笔记

尝试将简报写入思源笔记：

1. 调用 `mcp__siyuan__list_notebooks`，如果调用失败（MCP 未配置），跳过此步
2. 找到名为 **navi** 的笔记本，取其 ID
3. 调用 `mcp__siyuan__create_doc` 创建文档：
   - `notebook`: navi 的笔记本 ID
   - `path`: `/daily/{yyyy-mm-dd}` （当天日期）
   - `markdown`: 第二步汇总的完整简报内容

## 注意事项

- 本 skill 必须在主会话执行，**不能加 `context: fork`**——fork 出的子 agent 里 AskUserQuestion 等交互工具不可用，会导致无法让用户选择信息源
- 某个源获取失败时跳过该板块并注明，不阻塞其他板块
- **全量输出**：保持各 skill 返回的完整条目数和原始格式，禁止截断、合并或精简（如知乎 30 条就写 30 条，不能只写 Top 10）
- 写入思源时同样使用完整内容，不得缩写
- 思源 MCP 未配置时跳过写入，不报错
