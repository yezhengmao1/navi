---
name: dlc
description: 查阿里云 PAI-DLC 训练任务——`dlc list` 跨全部可访问工作空间列 Running 任务（含 GPU 卡数 / 已运行时长 / 属主），`dlc logs JOB_ID` 取某任务最后一个节点的日志，`dlc workspaces` 列可访问工作空间
---

# DLC — 阿里云 PAI-DLC 任务查询

用阿里云官方 SDK（`alibabacloud_pai_dlc20201203`）读训练任务列表与日志。

设计原则（沿用 navi 惯例）：
- **看全组，不只看自己**：先 `ListWorkspaces` 拿到你能访问的所有工作空间，再逐个 `ListJobs`——
  这样才看得到同事在同一工作空间提交的任务（`show_own=False`）。属主用 `username`（真人名）。
- **一次取全**：GPU 卡数、已运行时长、属主都取自 `ListJobs` 返回项（`request_gpu` /
  `gmt_running_time` / `username`），列表**无需逐个 `GetJob`**；只有 `logs` 才按 pod 取。
- **默认聚焦**：`list` 默认只列 `Running` 且过滤掉 GPU=0 的辅助任务。

## 文件

- `dlc.py` — CLI 入口（`list` / `logs` / `workspaces`）

## 依赖

```bash
pip install alibabacloud_pai_dlc20201203 alibabacloud_aiworkspace20210204 alibabacloud_tea_openapi
```

## 用法

```bash
# 全部 Running 任务（遍历所有可访问工作空间；含 GPU / 时长 / 属主 + 合计卡数）
python3 .agents/skills/dlc/dlc.py list

python3 .agents/skills/dlc/dlc.py list --all-status         # 不限状态
python3 .agents/skills/dlc/dlc.py list --status Failed      # 指定状态
python3 .agents/skills/dlc/dlc.py list --mine               # 只看自己提交的
python3 .agents/skills/dlc/dlc.py list --workspace 600283   # 只查某工作空间
python3 .agents/skills/dlc/dlc.py list --with-zero-gpu      # 保留 GPU=0 的任务
python3 .agents/skills/dlc/dlc.py list --days 30            # 只看最近 N 天创建的
python3 .agents/skills/dlc/dlc.py --json list              # JSON 输出（便于程序解析）

# 某任务最后一个节点（worker 序号最大者）的日志尾部
python3 .agents/skills/dlc/dlc.py logs <jobid> --lines 50
python3 .agents/skills/dlc/dlc.py logs <jobid> --pod worker-3   # 指定 pod

# 列可访问的工作空间
python3 .agents/skills/dlc/dlc.py workspaces
```

## 作为 `/dlc` 被调用时

`用户请求` 第一个词是子命令（`list` / `logs` / `workspaces`），缺省按 `list` 处理：
1. 用 `Bash` 跑 `python3 "<本 skill 的 base directory>/dlc.py" <子命令> [选项]`——
   **用调用时给出的 base directory 拼绝对路径**，别用相对 cwd 的路径（cwd 可能不在仓库根）。
2. `list`：把结果整理成中文表格（GPU / 已运行 / 状态 / 工作空间 / 属主 / 任务名），
   并给出**合计卡数**与「我 vs 他人」的粗略拆分（属主等于你自己的即为「我的」）。
   注意 GPU=0 的辅助任务默认已过滤；用户问「所有任务」再加 `--with-zero-gpu`。
3. `logs`：默认取最后一个 worker 的尾部日志，扫一眼有没有报错 / OOM / loss 异常，中文小结。
   用户没给行数就默认 50 行；给了 jobid 但拿不到 pod 时如实说明（任务未开始或已释放）。
4. 若报缺少依赖，提示 `pip install` 那三个包；若报缺配置，提示补 `[dlc]` 段。

## 配置（`~/.navi/config.toml`）

```toml
[dlc]
access_key_id     = "LTAI..."          # 建议用 RAM 子账号只读密钥（授 PAI-DLC 只读）
access_key_secret = "..."
region            = "cn-hangzhou"       # 任务所在地域
workspace_id      = "513442"            # 可选，仅作 ListWorkspaces 失败时的回退目标
```

> 安全提醒：`access_key` 是长期凭证，务必用 RAM 子账号只读密钥，不要用主账号 AK。
