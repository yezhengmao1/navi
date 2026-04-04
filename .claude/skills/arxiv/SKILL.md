---
name: arxiv
description: 获取今日 arxiv 论文，筛选大语言模型基模和训练系统相关论文
user-invocable: true
allowed-tools: WebFetch
context: fork
---

# arxiv 今日论文筛选

## 任务

从 arxiv 获取今日新论文，筛选出与 **大语言模型基模** 和 **训练系统** 相关的论文，并以结构化格式呈现。

## 数据获取

### 第一步：尝试 RSS

使用 WebFetch 抓取：
```
https://rss.arxiv.org/rss/cs.AI+cs.CE+cs.DB+cs.DC+cs.MA+cs.OS+cs.SY
```

提取所有 `<item>` 中的 title、link、dc:creator（作者）、description（摘要）。

### 第二步：如果 RSS 为空则回退到 API

RSS 在周末/假期可能为空。此时使用 WebFetch 抓取 arxiv API：
```
https://export.arxiv.org/api/query?search_query=cat:cs.AI+OR+cat:cs.CL+OR+cat:cs.DC+OR+cat:cs.DB&sortBy=submittedDate&sortOrder=descending&max_results=50
```

从 Atom XML 中提取 title、id（URL）、author、summary。

## 筛选规则

从所有获取到的论文中，筛选与以下主题相关的论文：

**大语言模型基模（LLM Foundation Models）**：
- 关键词：LLM, large language model, foundation model, language modeling, pretraining, pre-training, scaling law, tokenization, architecture (transformer variants), mixture of experts, MoE, long context, multimodal foundation

**训练系统（Training Systems）**：
- 关键词：training system, distributed training, parallel training, data parallel, model parallel, pipeline parallel, tensor parallel, training infrastructure, training efficiency, GPU cluster, training framework, DeepSpeed, Megatron, FSDP, checkpointing, mixed precision, gradient compression, communication optimization, training at scale

筛选时综合考虑标题和摘要内容，不要仅做简单关键词匹配——理解论文的实际主题。

## 输出格式

对每篇筛选出的论文，输出：

```
### {序号}. {Title}

- **URL**: {arxiv link}
- **Authors**: {作者列表}
- **中文摘要**: {将英文摘要翻译/概括为 2-3 句中文}

---
```

## 保存结果索引

输出完成后，将筛选出的论文追加到 `~/.navi/arxiv_papers.md`，供 `/paper` 通过序号或关键词引用。

格式如下（每次运行追加一个日期段落，不覆盖旧内容）：

```
## 2026-04-04

1. Batched Contextual Reinforcement: A Task-Scaling Law for Efficient Reasoning
   http://arxiv.org/abs/2604.02322v1
2. go-mHC: Direct Parameterization of Manifold-Constrained Hyper-Connections
   http://arxiv.org/abs/2604.02309v1
```

每篇论文两行：第一行为 `{序号}. {英文标题}`，第二行缩进三个空格后为 URL。

使用 Bash 追加写入，不要覆盖已有内容。如果文件中已有当天日期的段落，先删除旧的当天段落再写入新的。

## 注意事项

- 所有非论文原文的内容用中文输出
- 在开头注明数据来源（RSS 还是 API）和获取到的论文总数
- 如果筛选后没有相关论文，明确告知用户
- 如果今天完全没有新论文（周末），告知用户 arxiv 周末不更新，并展示最近提交的相关论文
