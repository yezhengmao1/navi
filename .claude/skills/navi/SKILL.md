---
name: navi
description: 把 ~/.navi（config.toml + paper-cache 等）镜像备份到 WebDAV（账号配在 [navi] 段）——`navi sync` 增量上传，`navi pull` 在新机器上恢复，`navi status` 看差异
argument-hint: "sync | pull | status [--delete] [--dry-run]"
user-invocable: true
allowed-tools: Bash, Read
---

# Navi 配置/缓存 WebDAV 备份

把整个 `~/.navi/` 目录（`config.toml`、`paper-cache/`、`swanlab-metrics.md` 等）镜像到 WebDAV，方便在多台机器间同步或换机恢复。

设计原则（沿用 navi 惯例）：
- **独立配置**：URL 与 WebDAV 账号全部写在 `[navi]` 段（`webdav_url` / `webdav_user` / `webdav_password`），不复用其它段。
- **取数自包**：`webdav.py` 纯 stdlib（PROPFIND/PUT/GET/DELETE，跟随 alist 的 302 直链），不依赖第三方库。
- **增量**：本地 `~/.navi/.navi-sync.json` 记每个文件的 md5，未变就跳过；日志 / 锁 / `__pycache__` 默认不传。

## 文件

- `navi.py` — CLI 入口（`sync` / `pull` / `status`）
- `webdav.py` — 极简 WebDAV 客户端

## 用法

```bash
# 上传：本地 ~/.navi → WebDAV（增量）
python3 .claude/skills/navi/navi.py sync

# 真镜像：同时删除远端多余文件
python3 .claude/skills/navi/navi.py sync --delete

# 预演（不实际传输，只看会动哪些文件）
python3 .claude/skills/navi/navi.py sync --dry-run

# 换机恢复：WebDAV → 本地 ~/.navi
python3 .claude/skills/navi/navi.py pull

# 看本地与远端差异
python3 .claude/skills/navi/navi.py status
```

## 作为 `/navi` 被调用时

`$ARGUMENTS` 第一个词是子命令（`sync` / `pull` / `status`），缺省按 `sync` 处理：
1. 用 `Bash` 跑 `python3 "<本 skill 的 base directory>/navi.py" <子命令> [--delete] [--dry-run]`——**用调用时给出的 base directory 拼绝对路径**，别用相对 cwd 的路径（cwd 可能不在仓库根）。
2. 把返回的 JSON 用**中文小结**：传/拉/删了几个文件、跳过几个、目标 URL；`failures` 非空时原样转述并提示怎么改。
3. `--delete` 会删目标端文件，**执行前先跟用户确认**；不确定影响范围时先 `--dry-run` 或 `status`。
4. 若报缺少配置，提示在 `[navi]` 段补齐 `webdav_url` / `webdav_user` / `webdav_password`。

## 配置（`~/.navi/config.toml`）

URL 与账号全部写在 `[navi]` 段，三项必填：

```toml
[navi]
webdav_url      = "https://host/dav/.../navi"  # 备份根目录
webdav_user     = "..."
webdav_password = "..."
```
