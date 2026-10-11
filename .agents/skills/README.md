# Navi Skills（Pi）

`.agents/skills/` 是 Pi 原生支持的 Agent Skills 目录，也是本仓库的唯一 skill 来源，不再维护 `.claude/skills` 副本。
每个 skill 使用标准 YAML `name` / `description` frontmatter 和 `SKILL.md` 正文；相邻脚本和资产保持原位。

## 命令

统一使用 Pi 原生命令 `/skill:<name> [参数]`，不再提供同名转发 prompt。`.pi/prompts/` 仅保留两个专用 agent 入口，见下文。

| 命令 | 说明 |
|------|------|
| `/skill:arxiv` | 今日 arxiv LLM 基模、训练系统与安全论文 |
| `/skill:hfpapers` | Hugging Face Daily Papers |
| `/skill:github [language]` | GitHub 热门仓库 |
| `/skill:hackernews` | Hacker News 热门帖子 |
| `/skill:zhihu` | 知乎热榜 |
| `/skill:producthunt` | Product Hunt 热门产品 |
| `/skill:brief [信息源...]` | 完整日报，支持并行取数与可选推送 |
| `/skill:paper sync\|ask\|status` | Zotero 同步 + PaperQA2 问答 |
| `/skill:swanlab-analyze [实验]` | 挖掘指标关系，不做健康评级 |
| `/skill:swanlab-monitor [实验]` | 单周期异常监控，不自动循环 |
| `/skill:dlc list\|logs\|workspaces` | 阿里云训练任务查询 |
| `/skill:server add\|list\|remove` | 远程服务器登记 |
| `/skill:navi sync\|pull\|status` | 配置/缓存 WebDAV 同步 |
| `/skill:hiboard <内容>` | 手机负一屏推送 |
| `/skill:feishu <内容>` | 飞书群机器人推送 |

例如：

```text
/skill:navi sync
/skill:navi status
/skill:paper ask "MoE 路由有哪些工作"
/skill:brief arxiv hfpapers
/skill:swanlab-monitor username/project/run_id
```

不要使用 `@skills/navi sync` 作为 skill 命令；Pi 的明确调用语法是 `/skill:navi sync`。

## 路径、工具与配置

- 用 `read` 加载 skill，`bash` 运行脚本，`write` 写新结果，`edit` 修改已有文件。用户选择在对话中确认。
- 仓库根相对路径示例 `.agents/skills/...` 不能直接相对任意 cwd 执行；从 SKILL.md 的绝对位置解析实际脚本路径。
- 凭证统一在 `~/.navi/config.toml`，字段和依赖见各自 SKILL.md。不要打印或提交凭证。
- GitHub token 可选；SwanLab 需要 `[swanlab]` 与 `swanlab>=0.8.0`；Paper 需要 `[paper]`、`[zotero]` 和 `paper/requirements.txt`；DLC 需要 `[dlc]` 和阿里云 SDK。
- Navi WebDAV 需要 `[navi]`；推送分别需要 `[hiboard]` / `[feishu]` 或调用方指定的本次参数。
- 网络源失败如实说明。Pi 默认没有浏览器/网页抓取专用工具，使用已有脚本或 curl/Python urllib。

## Agents 与共享资产

- `swanlab/` 没有 SKILL.md，是分析和监控共享的资产包，不能当独立 skill 调用。
- 指标说明：`~/.navi/swanlab-metrics.md`，不存在时回退 `swanlab/metrics.example.md`。
- 专用 agents 在仓库 `.pi/agents/`，由 `.pi/extensions/subagent/` 加载，不是 Pi 自动读取的系统角色。
- `/dlc-inspector [要求]`：一次训练任务进度巡检。
- `/swanlab-analyst <实验、CSV、指标说明>`：直接分析已有数据。
- `source-researcher`：简报内部取数 agent，不需独立用户命令。

Pi 默认没有定时循环命令。持续监控/巡检要另行确认 cron/systemd 等调度与停止条件。
