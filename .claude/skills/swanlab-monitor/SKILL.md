---
name: swanlab-monitor
description: 实时监控 SwanLab 上运行中的大模型训练实验——按窗口研判异常（NaN/尖峰/发散/掉速）并告警
argument-hint: "[实验名/run_id/URL]"
user-invocable: true
allowed-tools: Bash, Read, Agent, AskUserQuestion
---

# SwanLab 训练实验实时监控

盯住正在跑的训练实验，每个周期拉最近窗口的指标，对照指标说明研判异常并告警。深度归因分析请用 `/swanlab-analyze`。

设计原则：
- **最小职责**：取数走 `swanlab/tools/` 单一功能脚本；本 skill 一次只跑**一个监控周期**，节奏交给 `/loop`。
- **裸数据进、研判在上层**：`tools/` 只回原始数据。

## 约定路径

- 工具目录：`.claude/skills/swanlab/tools/`（凭证读 `~/.navi/config.toml` 的 `[swanlab]`）
- 指标说明：优先 `~/.navi/swanlab-metrics.md`，否则 `.claude/skills/swanlab/metrics.example.md`（取其「期望趋势/异常信号」作研判依据）。

## 第一步：定位实验

把目标解析成 `username/project/run_id`：
- SwanLab URL（`http://host/@user/project/runs/<run_id>/chart`）→ 抽三段。
- `run_id` 或完整 `user/project/run_id` → 用之（缺段用配置默认）。
- 实验名 → 在默认/指定项目内 `list_experiments.py` 找同名 run。
- **参数为空**：用 `list_projects.py` 找 `count.runningExps>0` 的项目，再 `list_experiments.py` 取 `state==RUNNING` 的实验；多个用 `AskUserQuestion` 选。

## 第二步：跑一个监控周期

> 持续监控：建议 `/loop 5m /swanlab-monitor <实验>`。本 skill 每次只跑一个周期。

1. 取最近窗口的点（无状态，用 `--tail`）：
   ```
   python3 .claude/skills/swanlab/tools/get_metrics.py --path <path> --keys <核心指标> --tail 50
   ```
   同时关注实验 `state`（CRASHED/FINISHED 要提示）。
2. 读指标说明的「期望趋势/异常信号」，对这个小窗口快速研判：NaN/Inf、尖峰、发散（loss/grad-norm 上行）、平台、吞吐掉速。
3. 研判结果：
   - **健康** → 一行状态：`step / 关键指标最新值 / OK`。
   - **异常** → 醒目 ALERT：现象 + 证据(step/值) + 依指标说明的可能原因；必要时对该实验起一个 `swanlab-analyst`（Agent 子类型）做聚焦诊断。
4. 提示用户用 `/loop` 持续盯，或用 `/swanlab-analyze` 深挖。

## 注意事项

- 取数脚本报错会回 `{"error": ...}`；据此提示用户（多半是 `[swanlab]` 未配 `api_host`/`api_key`）。
- 监控无状态：每周期只看最近窗口，不依赖上次结果。
- 默认中文输出；指标名、step、数值保留原文。
