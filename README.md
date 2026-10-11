<p align="center">
  <img src="assets/logo.svg" width="120" alt="Navi">
</p>

<h1 align="center">Navi - Hey Listen</h1>

基于 [Pi](https://pi.dev/) 的个人助手：论文追踪、每日简报、训练任务巡检、指标分析与通知推送。

## 快速开始

使用支持原生 MCP 和 Agent Skills 的 Pi（本仓库按 **1.1.0** 验证）：

```bash
git clone https://github.com/yezhengmao1/navi.git
cd navi
pi
```

审核项目资源后同意项目信任。若使用独立子 agent，执行 `/trust` 保存信任，让子进程也能加载项目 skills。修改资源后执行 `/reload`。

```text
/skill:navi sync
/skill:navi status
/skill:arxiv
/skill:okx 最近 10 小时的订单
/skill:brief arxiv hfpapers
让 dlc-inspector 巡检一次，不推送
/skill:swanlab-analyze username/project/run_id
```

Skills 统一使用 `/skill:<name> [参数]`；不再提供同名转发短命令。`@skills/navi sync` 不是 Pi 的 skill 命令。

## 目录与加载方式

| 路径 | 用途 |
|------|------|
| `.agents/skills/` | 唯一 skill 来源，Pi 原生发现，16 个 skills |
| `.pi/agents/` | `dlc-inspector`、`swanlab-analyst`、`source-researcher` 定义 |
| `.pi/extensions/subagent/` | Pi 官方示例扩展，使项目 agents 可独立/并行执行 |
| `packages/pi/extensions/magic-ui/` | 单一 UI 扩展入口，包含字标、编辑器、状态栏、折叠显示、通用问卷和额度查询 |
| `packages/pi/` | 可选的通用 Pi 扩展包：界面、命令确认、会话与主题，附安装脚本和测试 |
| `mcp/siyuan/` | 思源 MCP server |

`.pi/` 放项目直接加载资源，`packages/pi/` 放可独立安装的通用扩展，`.agents/skills/` 放业务流程。不要将通用扩展再复制到 `.pi/extensions/`，以免与全局副本重复加载。安装与迁移方式见 [Pi 扩展包说明](packages/pi/README.md)。

没有重复复制到 `.pi/skills`，也不需要额外 skills 搜索路径。子 agent 调用需显式设置 `agentScope: "project"`，不指定模型时继承主会话配置。详情见 [Skills 总览](.agents/skills/README.md) 和 [subagent 说明](.pi/extensions/subagent/README.md)。

专用 agent 不是沙箱。监控和巡检默认只跑一轮，持续运行需另行配置外部调度。

## 业务配置与依赖

所有凭证仍放在 `~/.navi/config.toml`，**不要提交到仓库**。各 skill 的 SKILL.md 列出对应配置段和依赖，按需安装，不要求一次配齐。

例如 Navi 同步需要：

```toml
[navi]
webdav_url = "https://example.com/dav/navi"
webdav_user = "your-user"
webdav_password = "your-password"
```

`sync` 上传 `~/.navi`，`pull` 恢复，`status` 看差异；`sync --delete` 会删除远端多余文件，执行前需确认。

## 可选：思源 MCP

仓库根 `.mcp.json` 是旧客户端配置，Pi 不自动读取它。要启用思源，先安装 server 依赖，再从仓库根登记：

```bash
npm --prefix mcp/siyuan install
pi mcp add --local siyuan -- node "$(pwd)/mcp/siyuan/index.js"
pi mcp list
```

它会创建 `.pi/mcp.json`；思源地址和凭证按 server 要求配置在 `~/.navi/config.toml` 的 `[siyuan]`。Pi 中执行 `/reload` 和 `/mcp` 查看连接。

旧 `.claude/skills`、`.claude/agents`、`.codex/agents` 已统一迁移。`integrations/` 下的 Claude 专用状态栏/hooks 及本地 `.claude/settings*.json` 不属于此次 skills/agents 迁移，Pi 不加载它们。

## 离线验证

```bash
# 默认查找本机 Pi 安装；也可设置 PI_PACKAGE_ROOT 指向 Pi 包目录
node --test packages/pi/tests/*.test.mjs
bash -n packages/pi/install-extensions.sh
python3 -m unittest discover -s .agents/skills/feishu -p 'test_*.py'
python3 -m unittest discover -s .agents/skills/paper -p 'test_*.py'
python3 -m unittest discover -s .agents/skills/okx -p 'test_*.py'
```

通用问卷使用模拟按键验证；扩展测试覆盖部分显示、加载与生命周期行为。不请求模型、不运行云端任务、不发送通知。

## License

本项目：[Hey-Listen License (HLL)](LICENSE)。
Pi 官方 subagent 示例：MIT，见 [.pi/extensions/subagent/LICENSE](.pi/extensions/subagent/LICENSE)。
