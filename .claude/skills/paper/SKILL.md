---
name: paper
description: 阅读 arxiv 论文（支持多篇并行），Professor 视角评审 + PhD 视角精读
user-invocable: true
allowed-tools: WebFetch, Agent, Bash, Read, Grep
context: fork
---

# 论文深度阅读

## 任务

给定一篇或多篇 arxiv 论文，从两个互补视角深度阅读：**Professor**（高屋建瓴的评审视角）和 **PhD**（扣细节的精读视角）。

## 输入

用户可以通过以下任意方式指定论文：

- **URL**：`/paper http://arxiv.org/abs/2604.02178v1`
- **序号**：`/paper 3` 或 `/paper 1 3 5`（引用最近一次 `/arxiv` 结果中的序号）
- **关键词**：`/paper Expert Strikes Back`（按标题关键词模糊匹配）
- **混合**：`/paper 1 http://arxiv.org/abs/2604.02178v1 scaling law`

### 解析输入

1. 如果参数是纯数字，视为 `/arxiv` 结果中的序号
2. 如果参数包含 `arxiv.org`，视为 URL
3. 其余视为标题关键词

对于序号和关键词，读取 `~/.navi/arxiv_papers.md` 查找对应的 URL：
- **序号**：匹配最近一个日期段落中 `{序号}. {标题}` 行，取下一行的 URL
- **关键词**：在文件中搜索标题包含该关键词的论文（不区分大小写），取对应 URL

如果 `~/.navi/arxiv_papers.md` 不存在或找不到匹配，告知用户需要先运行 `/arxiv` 或直接提供 URL。

## 数据获取

将每个 URL 转换为 HTML 版本用于阅读：
- 如果 URL 是 `arxiv.org/abs/XXXX`，转换为 `https://arxiv.org/html/XXXX`
- 使用 WebFetch 抓取 HTML 版本的全文

如果 HTML 版本不可用（404 或其他错误），直接告知用户该论文的 HTML 版本不可用，无法进行深度阅读分析。

## 并行策略

- **单篇论文**：并行启动 2 个 Agent（Professor + PhD），共享同一篇论文全文
- **多篇论文**：每篇论文启动 1 个独立 Agent，该 Agent 内部依次完成 Professor 和 PhD 两部分分析。所有论文的 Agent 必须并行启动

## 分析流程

获取论文全文后，启动以下两个视角的分析：

### Professor Agent — 评审视角

以资深研究者 / 审稿人的视角审视论文全局，关注"这篇论文为什么值得读"和"哪里有问题"。

输出结构：

```
## 🎓 Professor 视角

### 研究定位（Positioning）
{这篇论文所处的研究领域、学术脉络和前置知识，2-3 句}

### 动机与问题（Motivation）
{为什么要做这项研究？现有方法的什么不足驱动了本工作？2-3 句}

### 核心创新（Novelty）
{论文的核心贡献是什么？与最相关的先前工作相比，创新点在哪？2-3 句}

### 优点（Strengths）
1. {具体优点}
2. ...

### 不足（Weaknesses）
1. {具体不足}
2. ...

### 问题与建议（Questions & Suggestions）
1. {具体问题或改进建议}
2. ...

### 总体评价（Verdict）
{1-2 段综合评价：创新性、实验充分性、写作质量、潜在影响力}
```

要求：
- 站在同领域审稿人的高度，关注 contribution 是否 solid
- 具体、有建设性，避免泛泛而谈
- 评估 claims 是否被实验充分支持

### PhD Agent — 精读视角

以博士生精读论文的视角，逐章拆解方法细节和实验设计，目标是"读完能复现"。

输出结构：

```
## 📖 PhD 视角

### 逐章精读

#### 1. Introduction
{2-3 句中文总结本章核心内容}

#### 2. Related Work
{2-3 句中文总结}

#### 3. Method
{3-5 句中文总结，保留关键公式、算法步骤和设计选择的理由}

#### 4. Experiments
{3-5 句总结实验设置和结果}

...按论文原始章节结构继续

### 方法细节（Method Deep-Dive）
{对核心方法的深入拆解：关键公式推导、算法伪代码逻辑、设计选择背后的 intuition。保留重要公式（LaTeX 格式）}

### 实验分析（Experiments Deep-Dive）
- **数据集**: {使用了哪些数据集，规模和特点}
- **基线方法**: {对比了哪些方法，为什么选这些}
- **评估指标**: {使用了哪些指标}
- **核心结果**: {最重要的实验发现，2-3 句}
- **Ablation 要点**: {消融实验揭示了什么，哪些组件最关键}
```

要求：
- 按论文原始章节结构组织逐章精读
- 保留关键技术术语英文原文
- Method 和 Experiments 部分要足够详细，读完能理解核心实现
- 关注可复现性：超参数、训练细节、数据处理流程

## 输出格式

先输出论文标题和基本信息，然后依次输出两个 Agent 的结果：

```
# {论文标题}

- **URL**: {链接}
- **Authors**: {作者}

---

{Professor Agent 的输出}

---

{PhD Agent 的输出}
```

## 注意事项

- 所有分析内容用中文输出
- 保留论文中的关键英文术语、方法名、数据集名
- 保留重要的数学公式（用 LaTeX 格式）
- 单篇时两个 Agent 必须并行执行以提高效率
- 如果论文过长，优先保证 Method 和 Experiments 部分的完整性
