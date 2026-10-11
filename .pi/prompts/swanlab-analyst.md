---
description: 使用已有 CSV 分析 SwanLab 指标关系
argument-hint: "<实验路径、CSV 路径、指标说明路径>"
---
调用 subagent，agent 为 `swanlab-analyst`，agentScope 为 `project`，cwd 为仓库根绝对路径。将下面输入和所需文件绝对路径放入 task。缺少输入时先询问；如需从 SwanLab 取数则使用 swanlab-analyze skill。
若 subagent 不可用，用 read 读取 `.pi/agents/swanlab-analyst.md` 在当前会话执行，并说明未启动独立 agent。
用户输入：$ARGUMENTS
