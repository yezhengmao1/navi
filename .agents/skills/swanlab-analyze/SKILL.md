---
name: swanlab-analyze
description: 分析 SwanLab 上的大模型训练实验——主打挖掘「变量之间的关系」（相关/领先滞后/同步变点/结构耦合/族内关系），产出关系图谱而非健康结论
---

# SwanLab 训练实验分析

从 SwanLab 读取训练实验的原始指标，**主打挖掘「变量之间的关系」**——哪些指标互相牵动、强度多大、谁领先谁、什么机制、真耦合还是伪相关。一次性深度关系分析；健康判断/告警/调参建议属于 `/swanlab-monitor`，本 skill 不做结论评级。

设计原则（务必遵守）：
- **最小职责**：取数全部走 `swanlab/tools/` 下的单一功能脚本（一个脚本只干一件事）；本 skill 只编排，分析交给 `swanlab-analyst` agent。
- **裸数据进、分析在上层**：`tools/` 只回原始数据，不算统计、不判异常。

## 约定路径

- 工具目录：`.agents/skills/swanlab/tools/`（`list_projects.py` / `list_experiments.py` / `get_summary.py` / `get_metrics.py`，均输出 JSON，凭证读 `~/.navi/config.toml` 的 `[swanlab]`）
- 指标说明：优先 `~/.navi/swanlab-metrics.md`，否则 `.agents/skills/swanlab/metrics.example.md`。**用户唯一需维护的文件**，描述每个指标的含义/期望趋势/健康范围/异常信号。

## 第一步：定位实验

把目标解析成 `username/project/run_id`：
- 参数是 SwanLab URL（形如 `http://host/@user/project/runs/<run_id>/chart`）→ 直接抽三段。
- 参数是 `run_id` 或完整 `user/project/run_id` → 用之（缺 user/project 用配置默认）。
- 参数是实验名 → 在默认/指定项目内 `list_experiments.py` 找同名 run。
- **参数为空**：
  - 配置有默认 `project` → `list_experiments.py --project <默认>` 列出来；多个用 `Codex 用户输入工具` 选，单个直接用。
  - 无默认 project → 先 `list_projects.py` 列项目（可看 `count.runningExps` 找在跑的），`Codex 用户输入工具` 选项目再列实验。

## 第二步：读指标说明

读指标说明文件，解析其中的指标名（`### 名称`）、「指标族」前缀，以及文末可选「关系提示」先验。

## 第三步：发现可用指标

```
python3 .agents/skills/swanlab/tools/get_summary.py --path <path>
```
返回 `summary` 的 key 即全部标量指标（可能上千条）。

**待分析指标集**：指标说明点名且实验里存在的核心标量（通常十几个）；指标族（`grad-norm/*`等）不全量铺开，留给 agent 按需深挖。

## 第四步：取原始数据落盘

```
python3 .agents/skills/swanlab/tools/get_metrics.py --path <path> --keys <核心指标逗号分隔> --all --out /tmp/navi-swanlab-<run_id>.csv
```
（`--all` 取全分辨率；步数过大也可省略走采样。）

## 第五步：交给 analyst 挖掘关系 + 诊断

用 Codex 子 agent `swanlab-analyst`启动，prompt 给出：实验 `path` 与元信息、CSV 路径、指标说明文件路径，任务=「**主打挖掘变量之间的关系**：level 与去趋势相关、领先滞后、同步变点、结构/族内耦合；区分真耦合与伪相关，每条给证据；产出关系图谱，不要健康评级与建议」。需要时用 tools/ 深挖指标族。

> 多实验对比：每个实验各起一个 analyst（并行），再由本 skill 汇总对比。

## 第六步：输出

呈现 agent 的关系分析报告。完成后**询问**是否写入思源笔记；用户同意才 `mcp__siyuan__list_notebooks` 找 navi 笔记本 → `mcp__siyuan__create_doc` 写到 `/swanlab/{run_id}-{yyyy-mm-dd}`。

## 注意事项

- 取数脚本报错会回 `{"error": ...}`；据此提示用户（多半是 `[swanlab]` 未配 `api_host`/`api_key`）。
- 默认中文输出；指标名、step、数值保留原文。
- 一个实验可达上千指标，**聚焦核心 + 指标族按需深挖**，不无差别全量拉。
- 关系是**从数据挖**出来的，指标说明只提供单指标语义与可选先验。
