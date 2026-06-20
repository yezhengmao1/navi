---
name: server
description: 管理 navi 的远程服务器清单——把服务器名/IP/登录方式（密码或密钥）写入 ~/.navi/config.toml 的 [servers.*] 段
argument-hint: "add | list | remove [name]"
user-invocable: true
allowed-tools: Bash, Read, AskUserQuestion
---

# 远程服务器管理

把远程服务器（名字 / IP / 登录方式）登记进 navi 专属配置 `~/.navi/config.toml` 的 `[servers.<name>]` 段，供后续部署、SSH 等场景复用。

设计原则（沿用 navi 惯例）：
- **最小职责**：所有读写走唯一脚本 `.claude/skills/server/tools/server_config.py`（只增删查 `[servers.*]`，不做连接测试），本 skill 只负责**收集信息 + 编排**。
- **绝不重写整个配置**：脚本对其它段（`[github]`/`[swanlab]`/`[siyuan]`）做文本级保护，原样不动。

## 子命令

`$ARGUMENTS` 第一个词是子命令，缺省按 `add` 处理：

| 子命令 | 动作 |
|--------|------|
| `add` | 新增一台服务器（**默认**） |
| `list` | 列出已登记服务器（密码脱敏显示 `***`） |
| `remove <name>` | 删除一台服务器 |

## add 流程

逐项收集，**已在 `$ARGUMENTS` 里给出的就别再问**：

1. **服务器名字**（`--name`）：唯一标识，只能用字母/数字/下划线/连字符（如 `gpu01`）。
2. **IP / 域名**（`--host`）。
3. **登录用户**（`--user`）：不确定就问，默认 `root`。
4. **SSH 端口**（`--port`）：默认 `22`，一般不必问。
5. **登录方式**（`--auth`）：用 `AskUserQuestion` 让用户在 **密钥 / 密码** 之间二选一。
   - 选 **密钥** → 再问私钥路径（`--key-path`，默认 `~/.ssh/id_rsa`）。
   - 选 **密码** → 再问密码（`--password`）。⚠️ 收集前**提醒用户**：密码会以明文存进 `config.toml`，更推荐用密钥。

收齐后调用脚本（密码用单引号包好，避免 shell 转义问题）：

```bash
python3 .claude/skills/server/tools/server_config.py add \
  --name gpu01 --host 1.2.3.4 --user root --port 22 \
  --auth key --key-path ~/.ssh/id_rsa
```

密码方式：

```bash
python3 .claude/skills/server/tools/server_config.py add \
  --name gpu02 --host 5.6.7.8 --user ubuntu \
  --auth password --password 'the-secret'
```

脚本回单行 JSON（密码脱敏）。把结果**用中文小结**给用户：登记了哪台、IP、登录方式、写到了哪个文件；若 `error` 字段非空则原样转述并说明怎么改（如重名要先 `remove`）。

## list 流程

```bash
python3 .claude/skills/server/tools/server_config.py list
```

把 JSON 整理成中文表格（名字 / host / user / 端口 / 登录方式），密码列只显示 `***`。

## remove 流程

从 `$ARGUMENTS` 取 `<name>`；没给就先 `list` 让用户挑。删除前**确认一次**，再执行：

```bash
python3 .claude/skills/server/tools/server_config.py remove --name gpu01
```

## 输出规范

- 中文小结，凭证敏感字段一律脱敏。
- 不在对话里回显完整密码。
