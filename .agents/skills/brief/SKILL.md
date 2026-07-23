---
name: brief
description: 每日简报，并行调用 arxiv / HF Papers / 知乎 / HN / GitHub / Product Hunt
---

# 每日简报

## 任务

并行调用所选信息源 skill，汇总为一份精简日报。默认全部 6 个，调用前先让用户选择。

## 执行步骤

### 第一步：确定信息源 + 是否推送飞书

**若调用时带了参数**（如 `/brief arxiv 知乎`，`用户请求` 非空），直接按参数匹配下表选定信息源，跳过提问；
此时**不推送飞书**（除非用户在参数里明确说要推）。

**未带参数时**，用 `Codex 用户输入工具` 工具**一次性问三题**（`questions` 传三个元素，会在同一弹窗里并列展示）询问信息源与飞书开关。

> ⚠️ `Codex 用户输入工具` **每个问题最多 4 个选项**，6 个源塞不进一题。所以信息源**拆成两个分类问题**，
> 再加一题飞书开关，共三题：
>
> - **第 1 题「学术论文类」**（`header: 论文源`，`multiSelect: true`）：`arxiv`、`HF Papers`
> - **第 2 题「社区热榜类」**（`header: 热榜源`，`multiSelect: true`）：`知乎`、`Hacker News`、`GitHub`、`Product Hunt`
> - **第 3 题「推送飞书」**（`header: 飞书`，`multiSelect: false`）：`否`（默认，不推）、`是`（推到飞书群，需现场输入 KEY）
>
> 前两题合并即为全部 6 个源，用户可跨题任意勾选。第 3 题选「是」则第五步推送飞书，选「否」或跳过则不推。

**第 3 题选「是」时，紧接着让用户输入飞书 webhook 的 KEY**：用一句话请用户把 KEY（`hook/` 之后那串，
如 `1b64311b-...`）发过来。**KEY 每次现输，不读配置、不落盘、不写进思源**；用户不给 KEY 就当作不推。

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

用 Agent 工具为**用户所选的每个信息源**同时启动一个 agent，每个 agent 调用对应 skill。

每个 agent 的 prompt 为：`使用 激活并使用 {skill名}，将完整输出返回给我。`

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

### 第五步：推送飞书（仅当第 3 题选「是」且拿到 KEY 时）

**只有第一步第 3 题选了「是」并拿到用户现输的 KEY 才做这步**，选「否」/跳过/没给 KEY/带参数直调都不推，不报错。

**KEY 必须用第一步现输的那个，通过 `--key` 传入；绝不读配置 `[feishu].key`。**
把第三步汇总的完整简报写进 JSON 文件（用 `Write` 工具，避免换行/标题在命令行里被截断），
再用 `Bash` 调 `feishu` skill 的 `push.py` 以 markdown 卡片推送：

```bash
python3 .agents/skills/feishu/push.py --key <用户现输的KEY> --data /tmp/brief-feishu.json
```

JSON 内容：`{ "title": "每日简报 — {yyyy-mm-dd}", "content": "<第三步的完整简报正文>" }`。
飞书卡片正文按 lark_md 渲染，**保持完整内容不截断**。

读脚本输出判断结果：成功回「✅ 已推送飞书」；失败把错误码原样转达
（常见：签名校验 19021 / 自定义关键词未命中 19024 / KEY 错误），不阻塞其他输出。

## 注意事项

- 本 skill 必须在主会话执行，**不能加 子 agent 上下文**——fork 出的子 agent 里 Codex 用户输入工具 等交互工具不可用，会导致无法让用户选择信息源
- 某个源获取失败时跳过该板块并注明，不阻塞其他板块
- **全量输出**：保持各 skill 返回的完整条目数和原始格式，禁止截断、合并或精简（如知乎 30 条就写 30 条，不能只写 Top 10）
- 写入思源时同样使用完整内容，不得缩写
- 思源 MCP 未配置时跳过写入，不报错
