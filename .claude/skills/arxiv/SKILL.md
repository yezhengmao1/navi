---
name: arxiv
description: 获取今日 arxiv 论文，筛选大语言模型基模、训练系统和大模型安全相关论文
user-invocable: true
allowed-tools: Bash, Read
context: fork
---

# arxiv 今日论文筛选

## 任务

从 arxiv 获取今日新论文，筛选出与 **大语言模型基模**、**训练系统** 和 **大模型安全** 相关的论文，并以结构化格式呈现。

## 数据获取

用 `fetch.py` 取数，**不要用 WebFetch**——WebFetch 抓 RSS 只返回前 ~50 条就截断，
而当日 feed 常有 500+ 条，会漏掉绝大多数论文。

```bash
python3 .claude/skills/arxiv/fetch.py > /tmp/arxiv-today.json
```

脚本自取 RSS 全量（`rss.arxiv.org`，cs.AI+cs.CL+cs.LG+cs.CE+cs.DB+cs.DC+cs.MA+cs.OS+cs.SY），
周末/假期 RSS 为空时自动回退 arxiv API。输出 JSON：

| 字段 | 说明 |
|------|------|
| `source` | `rss` 或 `api`（回退时） |
| `feed_date` | feed 的 pubDate，**输出时如实报告**（arxiv 通常凌晨才滚动，早上跑可能仍是昨天的） |
| `total_fetched` | 抓到的原始条目数 |
| `announced_today` | 剔除 `replace` 后的当日新公告数 |
| `papers[]` | `title` / `link` / `authors` / `abstract` / `announce_type`（`new` 或 `cross`） |

脚本默认剔除 `replace` / `replace-cross`（旧论文的更新，非今日新公告）；需要保留时加 `--keep-replace`。

**筛选在 JSON 上做**：用 Read 读取该文件，按下面的筛选规则逐条判断。条目数多（数百条），
逐条读标题与摘要，不要因为量大而只看前若干条。

## arXiv 分类代码

| 代码 | 全称 | 说明 |
|------|------|------|
| cs.AI | Artificial Intelligence | 人工智能 |
| cs.CL | Computation and Language | 计算与语言（NLP） |
| cs.LG | Machine Learning | 机器学习 |
| cs.DC | Distributed, Parallel, and Cluster Computing | 分布式与并行计算 |
| cs.DB | Databases | 数据库 |
| cs.CE | Computational Engineering | 计算工程 |
| cs.MA | Multiagent Systems | 多智能体系统 |
| cs.OS | Operating Systems | 操作系统 |
| cs.SY | Systems and Control | 系统与控制 |

## 筛选规则

从所有获取到的论文中，筛选与以下主题相关的论文：

**大语言模型基模（LLM Foundation Models）**：
- 关键词：LLM, large language model, foundation model, language modeling, pretraining, pre-training, scaling law, tokenization, architecture (transformer variants), mixture of experts, MoE, long context, multimodal foundation

**训练系统（Training Systems）**：
- 关键词：training system, distributed training, parallel training, data parallel, model parallel, pipeline parallel, tensor parallel, training infrastructure, training efficiency, GPU cluster, training framework, DeepSpeed, Megatron, FSDP, checkpointing, mixed precision, gradient compression, communication optimization, training at scale

**大模型安全（LLM Safety & Security）**：
- 关键词：jailbreak, prompt injection, adversarial attack, red teaming, alignment, RLHF, safety alignment, refusal, guardrail, safety filter, model extraction, membership inference, distillation detection, data poisoning, backdoor, watermarking, hallucination, privacy leakage, memorization, unlearning, interpretability for safety, CoT faithfulness, monitorability, deception, agent safety, tool-use safety, sandbox escape
- 判断依据是**攻击/防御/评测的对象是不是大模型（含 agent）**：针对 LLM/agent 的 → 收；传统软件漏洞、通用密码学、与模型无关的网络安全 → 不收。

筛选时综合考虑标题和摘要内容，不要仅做简单关键词匹配——理解论文的实际主题。注意 alignment / RLHF 类论文只在其**动机是安全性**（无害、拒答、防操纵）时算安全方向；纯粹为提升任务能力的后训练归基模类。

### 主列表 vs 相关系统方向

上面三类命中的论文进**主列表**。此外还有一类**通用训练/系统方向**的论文：

- 涉及 checkpointing / 分布式与并行计算 / 容错（fault tolerance）/ 通信优化 / HPC 系统等系统关键词，
- 但**并非面向大语言模型训练**（如通用 HPC 数据流容错、给 MPI 程序自动加检查点、抗静默数据损坏的任务复制等）。

这类论文**不要丢弃**，也**不要混入主列表**——单独归到输出的「相关系统方向」小节（见输出格式）。判断依据是「是否服务于大模型训练」：服务于 → 主列表；只是通用系统 → 相关系统方向。

## 输出格式

```
## arxiv 今日筛选

────────────────────────────────────────
  #: 1
  标题: Paper Title
  作者: Author1, Author2, ...
  摘要: 2-3 句中文摘要
  链接: http://arxiv.org/abs/xxxx.xxxxxv1
```

每篇论文之间用 `────────────────────────────────────────` 分隔。

主列表之后，若有通用训练/系统方向的论文，追加一节（同样逐条列出，格式一致）：

```
## 相关系统方向（非面向 LLM 训练）

────────────────────────────────────────
  #: 1
  标题: Paper Title
  作者: Author1, Author2, ...
  摘要: 2-3 句中文摘要
  链接: http://arxiv.org/abs/xxxx.xxxxxv1
```

若该节无论文则整节省略。

## 注意事项

- 所有非论文原文的内容用中文输出
- 在开头注明数据来源（`source`）、`feed_date`、以及「抓取 N 条 → 剔除 replace 后当日新公告 M 篇」
- `feed_date` 若不是今天（arxiv 尚未滚动），如实说明这批是哪天的，不要写成今天的
- 如果筛选后没有相关论文，明确告知用户
- 如果今天完全没有新论文（周末），告知用户 arxiv 周末不更新，并展示最近提交的相关论文
