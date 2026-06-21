# tmux-claude-status

tmux 插件，通过 Claude Code hooks 实时追踪所有 Claude 实例状态。

`prefix + a` 弹窗查看详情，按编号跳转到对应 pane；状态栏在有 approval 待处理时显示提示标记。

## 安装 / 卸载

```bash
# 安装（写入 hooks 到 ~/.claude/settings.json + tmux 快捷键）
bash integrations/tmux-claude-status/install.sh

# 卸载
bash integrations/tmux-claude-status/install.sh --uninstall
```

## 文件结构

- `install.sh` — 安装 / 卸载
- `status-hook.sh` — hook 脚本，事件触发时写状态到 `/tmp/claude-status/`
- `claude-status.sh` — `prefix + a` 弹窗显示脚本
- `statusline.sh` — 状态栏组件，有 approval 时显示提示标记

## 原理

Claude Code 在每次事件（开始/停止/等待审批等）触发 hook，`status-hook.sh` 把当前实例状态落到 `/tmp/claude-status/` 下的文件；弹窗与状态栏脚本读取这些文件汇总展示。
