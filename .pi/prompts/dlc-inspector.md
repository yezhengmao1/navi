---
description: 巡检 DLC 任务进度并按请求推送
argument-hint: "[巡检要求]"
---
调用 subagent，agent 为 `dlc-inspector`，agentScope 为 `project`，cwd 为仓库根绝对路径。task 为下面的用户要求（为空时巡检一次）。将必要的 skill 路径解析为绝对路径传入。不启动定时循环。
若 subagent 不可用，用 read 读取 `.pi/agents/dlc-inspector.md` 在当前会话执行，并说明未启动独立 agent。
用户要求：$ARGUMENTS
