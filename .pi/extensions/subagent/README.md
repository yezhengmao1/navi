# Navi subagent

`index.ts` 和 `agents.ts` 基于本机 Pi 1.1.0 官方示例，包含本地适配：
`@earendil-works/pi-coding-agent/examples/extensions/subagent/`。
上游：https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent
版权与 MIT 许可见本目录 `LICENSE`；这两个第三方文件不适用仓库自定义许可证。

在仓库根启动 Pi，审核后信任项目并 `/reload`，会自动加载本目录 `index.ts`。
无需复制到个人配置，也不要同时加载另一份同名 `subagent` 扩展。

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

升级 Pi 后应对照上游示例重新验证加载与调用。仓库的 `scripts/test_pi_resources.mjs` 可做无模型、无网络的资源检查。
