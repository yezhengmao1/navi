# Navi agent-team

一个插件、两种执行后端：后台 `subagent`（原 single / parallel / chain 及调度接口不变），以及 Herdr `team` 持久交互成员。目录由 `subagent` 改名为 `agent-team`；若在个人 settings 中显式配置旧路径，请改为新路径，勿同时加载两份。

## 统一入口与动态团队

`team` 的 `run` 操作显式选择 `backend: "background" | "pane"`；后台复用原 `subagent` 执行器，pane 模式创建持久交互成员。原有 `subagent`、`subagent_schedule` 继续兼容。

```json
{"action":"run","backend":"pane","name":"gradient-analysis","instructions":"分析梯度与 loss 的关系，不修改项目文件","task":"查找异常窗口并对齐时间序列"}
```

`/team start <目标>` 让 lead 按任务动态组队，不固定角色。成员统一放入专用 Herdr tab：每页最多 4 人，按左上、右上、左下、右下组成 2×2，第 5 人自动开下一页，不切走 lead 焦点。

成员默认沿用 lead 的正常 Pi 插件、MCP 和活动工具配置，不再默认禁用联网工具或界面插件；只有显式 `readOnly:true` / `tools` 才限制能力。已有旧配置成员需要重建，`status` 会显示 `needsProfileRestart:true`。

权限由 lead 集中处理：普通审批自动通过，只有 safety-guard 高危操作在 lead 弹窗请你授权；safety-guard 和标准扩展确认框会转发，不在成员里请求确认。lead 自身在团队激活后也使用相同策略。支持成员增减、任务依赖、按任务状态去重、过期丢弃的结果通知、worktree 和只读工具预设。控制操作按成员隔离，暂停即时生效；提交延迟有 15 秒观察宽限期，空闲团队自动降低轮询频率。详细接口、生命周期、安全边界和验收步骤见 **[TEAM.md](TEAM.md)**。

后台也可动态定义角色，不必创建 Markdown 文件：

```json
{"definitions":[{"name":"analysis","instructions":"分析梯度与 loss 的关系"}],"agent":"analysis","task":"查找异常窗口"}
```

`definitions` 仅当前调用有效，可被 single / parallel / chain 中的 agent 名称引用；显式覆盖同名已保存角色。无模型、无真实 Herdr 操作测试：

```bash
node --test packages/pi/tests/agent-team*.test.mjs packages/pi/tests/subagent-*.test.mjs
```


`index.ts` 和 `agents.ts` 基于本机 Pi 1.1.0 官方示例，包含本地适配：
`@earendil-works/pi-coding-agent/examples/extensions/subagent/`。
上游：https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent
版权与 MIT 许可见本目录 `LICENSE`；这两个第三方文件不适用仓库自定义许可证。

在仓库根启动 Pi，审核后信任项目并 `/reload`，会自动加载本目录 `index.ts`。
团队扩展无需复制到个人配置，也不要同时加载另一份同名 `subagent` 扩展。lead 的 safety-guard 需使用带 `agent-team:approval` 接口的新版（成员复用 lead 的兼容版本）。若个人扩展是旧的复制安装，需同步其审批接口后再 `/reload`；旧版不会自动支持 lead 自身的集中策略。

## 独立状态区

交互式 TUI 在输入框附近显示每个子任务的等待、运行、完成、失败、取消或跳过状态，不抢占输入焦点；详细输出仍在工具结果中。单任务、并行和链式调用均支持，同名 agent 按任务分别显示。

状态以子进程结束为准；链式失败后的未执行任务显示「已跳过」。全部结束后停留 3 秒自动收起；期间新任务开始会取消旧的收起定时器，切换或清空会话时清除。并发工具调用的状态合并显示。界面采用主题色和逐项列表，标题为「子任务」。搭配 magic-ui 时显示在 Working 与上下文统计之间，并留空行分隔。非 TUI 模式不创建 widget。

修改后执行 `/reload` 加载。

## 用法

```json
{"agent":"dlc-inspector","agentScope":"project","task":"巡检一次，不推送"}
```

- 单任务：`agent` + `task`。
- 并行：`tasks: [{agent, task, cwd?}, ...]`（最多 8 个，最多同时运行 4 个）。
- 串行：`chain: [{agent, task}, ...]`，后续任务可用 `{previous}`。
- 项目定义在 `.pi/agents/*.md`；必须显式传 `agentScope: "project"` 或 `"both"`，默认只读个人 agents。
- 不写 model 时继承主会话模型和思考级别，不使用 `model: inherit` 或 Claude 专用 `sonnet` 别名。
- 工具名用小写，如 `tools: read, bash, write`。

每个任务启动独立 `pi --mode json -p --no-session` 进程，使用相同机器权限，不是沙箱。父会话历史不会自动传给子会话；必要上下文和文件绝对路径放在 task 中。

建议审核后在交互会话执行 `/trust` 保存对仓库的信任，保证新建子进程也能加载项目 skills。仅对当前进程使用 `--approve` 不等于保存信任。

并行输出每个任务最多回传 50 KB。长报告应写到调用方提供的唯一临时文件，再由主会话用 read 分页读完；不要把工具预览当成全量输出。

## 定时子任务（融合式调度）

同一扩展同时注册立即执行的 `subagent` 和定时执行的 `subagent_schedule`，共用 agent 发现、模型继承和子进程执行逻辑，不需要安装第二份插件。

在当前交互会话 `/reload` 后，可直接说：

> 每 3 分钟让 dlc-inspector 检查一次训练任务 JOB_ID，最多 20 次，每次超时 120 秒。只检查，不修改、不推送。

对应模型工具参数：

```json
{"action":"create","agent":"dlc-inspector","agentScope":"project","task":"检查 JOB_ID 的运行状态和最新日志，仅只读检查，在结果中报告异常。不要修改任务或对外推送。","intervalSeconds":180,"maxRuns":20,"timeoutSeconds":120}
```

管理命令：

- `/schedules`：查看任务 ID、状态、次数、下次执行时间（Unix 毫秒）及最近结果。
- `/schedules stop <id>`：取消指定任务，包括正在执行的 Pi 子进程。
- `/schedules stop all`：停止全部任务。
- 也可以自然语言要求查看或停止，模型调用 `subagent_schedule` 的 `list` / `cancel` 操作。

行为和边界：

- **仅交互 TUI、仅当前会话存活期间有效**。退出、切换会话或 `/reload` 时清理定时器并取消执行；重启不恢复。
- 首次等待指定间隔再执行；后续从上一轮结束后计时，不重叠、不补跑。因此 180 秒表示“执行结束后再等 180 秒”，不是严格墙钟周期。
- 所有定时任务共享 **2 个执行槽位**，超过后 FIFO 排队（`queued`），排队不计执行次数，超时从真正开始执行计时。取消运行中的任务后，槽位等子进程实际结束才释放。这个限制不包含普通的立即执行 `subagent`。
- 默认最多 20 轮，每轮超时 120 秒。最多保留 20 个任务记录（含已完成），用 stop 删除后释放名额。完成后立即释放执行绑定，只留任务状态和最近结果。
- 每轮启动独立 Pi 进程，复用现有 subagent 执行器；创建时固定角色配置、工作目录、父模型和思考级别。子会话不继承父会话历史，task 必须包含完整检查目标和必要路径。
- 结果作为 `subagent-schedule` 消息显示在主会话，**不触发主模型续答**，但仍会成为后续对话上下文。最近结果保留前 12000 个 UTF-16 代码单元，加截断提示。
- 默认 `report: "always"` 每轮报告。可指定 `report: "on_change"`（自然语言“结果不变就别重复报告”），仅首次及返回文本变化时报告。比较的是执行器返回的有限文本，不做语义去重、异常分类；相同错误也会去重，时间戳等变化仍会报告，截断范围之外的变化可能不可见。每轮照常调用子模型，去重不节省子模型费用。
- 定时执行采用轻量收集：不累计消息历史、工具结果、思考或图片，只保留最终文本、用量和最近 16000 个代码单元的 stderr。流式 UTF-8 解码，单行 JSON 上限为 4 Mi 个代码单元；超限明确报错并终止子进程，而不是静默丢弃结果。限制的是父进程的输出收集，不限制子模型自身上下文或整个进程的 RSS。普通 `subagent` 仍保留完整结果。
- 每轮仍消耗子模型额度。工具超时会终止直接 Pi 子进程，不保证终止它启动的所有外部后代进程，也不会回滚已发生的操作。
- 子进程不是沙箱。建议检查任务明确限制为只读；未信任的项目角色需在创建时确认。无需每轮再确认同一个角色。
- 第一版定时调度仅支持单个角色；立即执行仍支持原有 single / parallel / chain。

升级 Pi 后应对照上游示例重新验证加载与调用。无模型、无网络测试：

```bash
node --test packages/pi/tests/subagent-{output,scheduler,status}.test.mjs
```
