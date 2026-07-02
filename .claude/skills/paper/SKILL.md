---
name: paper
description: 把 Zotero 论文库同步到本地并用 PaperQA2 做语义问答——`paper sync` 拉 PDF 建向量索引，`paper ask` 对自己的论文库带引用问答
argument-hint: "sync | ask [问题] | status"
user-invocable: true
allowed-tools: Bash, Read
---

# Zotero 论文问答（PaperQA2）

把 Zotero 里的 PDF 同步到本地缓存，用 [PaperQA2](https://github.com/Future-House/paper-qa) 建索引/向量，然后在命令行对自己的论文库做**带引用的语义问答**。全程 CLI；LLM 与 embedding 走 SiliconFlow（OpenAI 兼容）。

设计原则（沿用 navi 惯例）：
- **配置统一** `~/.navi/config.toml`：`[paper]`（cache + SiliconFlow key + 模型）、`[zotero]`（API key + WebDAV）。
- **取数自包**：`zotero_sync.py` 纯 stdlib 直接走 Zotero API + WebDAV，带 md5 去重，不依赖其它脚本。
- **核心交给 PaperQA2**：解析/切块/向量/检索/引用全由它负责；本目录只做取数 + 编排 CLI。

## 文件

- `paper.py` — CLI 入口（`sync` / `ask` / `status`）
- `config.py` — 读配置、构造 PaperQA `Settings`（已处理 SiliconFlow 的两处坑：embedding 的 `encoding_format`、覆盖 paperqa 默认的 gpt-4o）
- `zotero_sync.py` — 自包同步：Zotero API 列 PDF → WebDAV 拉 zip → md5 去重 → 落 `cache/pdfs/`
- `requirements.txt` — `paper-qa>=5`

## 用法

```bash
# 首次：安装依赖
pip install -r .claude/skills/paper/requirements.txt

# 同步 Zotero 新论文并建/更新索引（增量；--full 全量重扫+重建，--limit N 调试）
python3 .claude/skills/paper/paper.py sync

# 问答：带问题=单次；省略=进交互式 REPL
python3 .claude/skills/paper/paper.py ask "我的库里关于 MoE 路由有哪些工作?"
python3 .claude/skills/paper/paper.py ask

# 查看缓存/索引状态
python3 .claude/skills/paper/paper.py status
```

## 作为 `/paper` 被调用时

`$ARGUMENTS` 第一个词是子命令（`sync` / `ask` / `status`），缺省按 `ask` 处理：
1. 用 `Bash` 跑 `python3 "<本 skill 的 base directory>/paper.py" <子命令> [其余参数]`——**用调用时给出的 base directory 拼绝对路径**，别用相对 cwd 的路径（cwd 可能不在仓库根）。
2. `ask` 在非交互场景下应带上完整问题作为参数（一次性问答），把返回的带引用答案整理给用户。
3. 若报缺少依赖/配置，按下面「配置」提示用户补齐。

## 配置（`~/.navi/config.toml`）

```toml
[paper]
cache     = "~/.navi/paper-cache"          # PDF + 索引 + manifest 根目录
api_key   = "sk-..."                        # SiliconFlow key
base_url  = "https://api.siliconflow.cn/v1"
llm       = "deepseek-ai/DeepSeek-V3"       # 问答用大模型
embedding = "Qwen/Qwen3-Embedding-8B"       # 向量模型

[zotero]
api_key         = "..."                     # Zotero Web API key（read 即可）
user_id         = "..."                     # 数字 userID
webdav_url      = "https://.../zotero/"     # 附件存储 WebDAV（以 zotero/ 结尾）
webdav_user     = "..."
webdav_password = "..."
```