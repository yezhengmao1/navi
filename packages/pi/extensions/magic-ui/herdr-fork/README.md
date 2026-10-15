# /split

在 herdr 内的 Pi 输入：

- `/split`：选择当前项目已保存的一个 Pi 会话，复制到新分屏。
- 独立选择卡片，无搜索输入框。列表最多显示 8 项（小终端进一步缩减），←/→ 向前/向后跳 10 个（到首尾停止），↑↓ 逐个选择，Enter 确认、Esc 取消。方向键仅移动选择，不会创建分屏。
- 不再提供 `all`，避免无意扫描跨项目的大量会话。

选择后创建同一 tab 的兄弟分屏，在新窗格运行 `pi --fork <source-path>`。
宽窗格向右分屏，其他情况向下；保留原焦点。Esc 取消不会创建窗格。
会话标签包含名称（或首条问题）、项目目录、ID，以及当前会话标记。

使用 Pi 原生 CLI fork，不自行改写 JSONL，不切换/修改原会话。
这是从所选会话已保存状态创建副本，不是内置 `/fork` 的历史消息选择器。
不会创建 Git 分支/worktree，也不会隔离或回滚工作目录文件。
如果源会话仍在运行，副本只能包含启动 fork 时已保存的内容。

启动超时或等待授权时，保留新窗格并报告其 ID；请先查看，不要盲目重试。
不会自动批准项目信任或其他启动对话框，也不会自动关闭窗格。
使用当前会话的 sessionDir 列出当前项目，支持自定义存储。

## 安装

此模块由 `magic-ui/index.ts` 统一注册，不再作为独立扩展加载。随 Navi Pi 扩展包安装，或从仓库根执行兼容安装脚本：

```bash
./packages/pi/install-extensions.sh --link
```

脚本会清理旧的 `~/.pi/agent/extensions/herdr-fork` 目录或链接。原生 package 安装不清理旧入口，需自行移除旧副本，并更新任何显式扩展路径，避免重复注册。
然后在 Pi 中执行 `/reload`。不要同时用包安装和全局链接加载两份。

## 接口依据

- 官方仓库：https://github.com/herdrdev/herdr
- 本机 `herdr --skill`、`herdr pane split --help`、`herdr agent start --help`
- `herdr pane layout --pane <caller>` 查询几何布局
- `herdr pane split --pane <caller> --direction right|down --cwd <cwd> --no-focus`
- `herdr agent start <unique-name> --kind pi --pane <new-id> --timeout 30000 -- --fork <session-path>`
- Pi SDK `SessionManager.list` / `listAll` 及 CLI `pi --fork`

CLI 使用参数数组而不是 shell 拼接。仅在 `HERDR_ENV=1`、存在 caller pane ID 且 Pi 为 TUI 时运行。

## 测试

```bash
node --test packages/pi/tests/herdr-fork.test.mjs
```

自动化测试模拟 herdr 调用，不创建真实窗格。手工验收：重载扩展，取消一次选择以确认没有新窗格；再选择会话，确认新 Pi 保留历史、会话 ID 与原会话不同，且原窗格焦点未变。
