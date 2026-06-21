# Skills — 斜杠命令

Navi 的全部斜杠命令。每个命令对应一个子目录，操作说明写在各自的 `SKILL.md` 里；本文件是命令总览。

## 命令一览

| 命令 | 说明 |
|------|------|
| `/arxiv` | 筛选今日 arxiv 上 LLM 基模和训练系统相关论文 |
| `/paper sync\|ask\|status` | Zotero 论文库同步到本地 + PaperQA2 语义问答（带引用），走 SiliconFlow |
| `/github [language]` | GitHub 每日热门仓库，支持按语言筛选 |
| `/zhihu` | 知乎当前热榜话题 |
| `/hfpapers` | Hugging Face Daily Papers 今日热门论文 |
| `/hackernews` | Hacker News 当前热门帖子 |
| `/producthunt` | Product Hunt 今日热门产品 |
| `/brief` | 每日简报，聚合以上所有信息源 |
| `/swanlab-analyze [实验]` | 分析 SwanLab 训练实验，自动挖掘指标关系并诊断 |
| `/swanlab-monitor [实验]` | 实时监控运行中的训练实验，研判异常并告警（配 `/loop`） |
| `/server add\|list\|remove` | 管理远程服务器清单（名字/IP/登录方式）写入 `~/.navi/config.toml` |

## 用法示例

```
> /arxiv              # 今日 LLM/训练系统论文
> /paper sync         # 从 Zotero 同步 PDF 并建索引
> /paper ask "MoE 路由有哪些工作"  # 对自己的论文库问答
> /github             # 今日 GitHub 热榜
> /github rust        # Rust 语言热榜
> /zhihu              # 知乎热榜
> /hfpapers           # HF 今日热门论文
> /hackernews         # Hacker News 热帖
> /producthunt        # Product Hunt 热门产品
> /brief              # 每日简报（聚合全部）
> /swanlab-analyze    # 分析 SwanLab 训练实验，挖掘指标关系
> /swanlab-monitor    # 实时监控运行中的训练实验（配 /loop）
> /server add         # 登记一台远程服务器
```

## 各命令所需配置

凭证统一读 `~/.navi/config.toml`（结构见仓库根 README）。

- `/github` 需要 GitHub token：[Personal access tokens](https://github.com/settings/tokens)，无需勾选任何 scope。
- `/swanlab-*` 需要 `[swanlab]` 段并 `pip install -U swanlab`（>=0.8.0）；指标说明维护在 `~/.navi/swanlab-metrics.md`（不存在则回退 `swanlab/metrics.example.md`）。
- `/paper` 需要 `[paper]` 段（cache + SiliconFlow key + 模型）与 `[zotero]` 段（API key + WebDAV），并 `pip install -r paper/requirements.txt`（paper-qa）。
- `/server` 把服务器写入 `[servers.<name>]` 段，无需额外凭证。
- `/arxiv` `/zhihu` `/hfpapers` `/hackernews` `/producthunt` `/brief` 走公开数据源，无需配置。

## SwanLab 分析 / 监控的内部结构

`/swanlab-analyze` 与 `/swanlab-monitor` 拆成两个独立 skill，共享 `swanlab/` 资产包：

- `swanlab/tools/` — 单一功能取数脚本（只回裸数据，凭证读 `~/.navi/config.toml`）
- `swanlab/metrics.example.md` — 指标说明默认模板
- `../agents/swanlab-analyst.md` — 用 pandas 挖掘关系 + 诊断的分析 agent
