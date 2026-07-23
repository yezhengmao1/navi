#!/usr/bin/env python3
"""
server_config.py — 管理 ~/.navi/config.toml 里的远程服务器条目（单一职责：读写 [servers.*]）。

只干一件事：往 navi 专属配置里增 / 查 / 删服务器，**不做任何连接测试**（那是别的工具的事）。
其它配置段（[github] / [swanlab] / [siyuan]）原样不动——add/remove 都只对 [servers.*] 块做文本级增删，
绝不重写整个文件，以免抹掉用户在别处写的注释与格式。

TOML 结构：
    [servers.gpu01]
    host     = "1.2.3.4"
    port     = 22
    user     = "root"
    auth     = "key"               # "key" 或 "password"
    key_path = "~/.ssh/id_rsa"     # auth=key 时
    # password = "xxx"             # auth=password 时（明文存储）

子命令：
    add    --name --host --auth {key,password} [--user --port --key-path --password]
    list
    remove --name
输出：单行 JSON（密码字段以 "***" 脱敏）。
"""
import argparse
import json
import os
import re
import sys

CONFIG_PATH = os.path.expanduser("~/.navi/config.toml")
BARE_KEY = re.compile(r"^[A-Za-z0-9_-]+$")  # TOML 裸键，作为 [servers.<name>] 的 name


def emit(obj):
    print(json.dumps(obj, ensure_ascii=False))


def die(msg, code=2):
    print(json.dumps({"error": msg}, ensure_ascii=False))
    sys.exit(code)


def toml_str(s: str) -> str:
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def load_servers():
    """读 [servers] 段，返回 dict（文件不存在则空）。只读，不改文件。"""
    if not os.path.exists(CONFIG_PATH):
        return {}
    try:
        import tomllib
    except ModuleNotFoundError:  # py<3.11
        import tomli as tomllib  # type: ignore
    with open(CONFIG_PATH, "rb") as f:
        data = tomllib.load(f)
    return data.get("servers", {}) or {}


def mask(entry: dict) -> dict:
    out = dict(entry)
    if "password" in out:
        out["password"] = "***"
    return out


def cmd_add(args):
    if not BARE_KEY.match(args.name):
        die(f"服务器名只能含字母/数字/下划线/连字符：{args.name!r}")
    servers = load_servers()
    if args.name in servers:
        die(f"服务器 {args.name!r} 已存在；先 remove 再 add，或换个名字。")

    if args.auth == "key":
        key_path = args.key_path or "~/.ssh/id_rsa"
        if not args.key_path:
            sys.stderr.write(f"[server] 未给 --key-path，默认 {key_path}\n")
    elif args.auth == "password":
        if not args.password:
            die("auth=password 必须给 --password。")
    else:
        die("auth 只能是 key 或 password。")

    lines = [f"[servers.{args.name}]"]
    lines.append(f"host     = {toml_str(args.host)}")
    lines.append(f"port     = {int(args.port)}")
    lines.append(f"user     = {toml_str(args.user)}")
    lines.append(f"auth     = {toml_str(args.auth)}")
    if args.auth == "key":
        lines.append(f"key_path = {toml_str(key_path)}")
    else:
        lines.append(f"password = {toml_str(args.password)}")
    block = "\n".join(lines) + "\n"

    os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
    need_nl = False
    if os.path.exists(CONFIG_PATH) and os.path.getsize(CONFIG_PATH) > 0:
        with open(CONFIG_PATH, "rb") as f:
            need_nl = not f.read()[-1:] == b"\n"
    with open(CONFIG_PATH, "a", encoding="utf-8") as f:
        if need_nl:
            f.write("\n")
        f.write("\n" + block)

    entry = {"host": args.host, "port": int(args.port), "user": args.user, "auth": args.auth}
    entry["key_path" if args.auth == "key" else "password"] = (
        key_path if args.auth == "key" else args.password
    )
    emit({"ok": True, "action": "added", "name": args.name, "server": mask(entry),
          "config": CONFIG_PATH})


def cmd_list(_args):
    servers = load_servers()
    emit({"ok": True, "count": len(servers),
          "servers": {k: mask(v) for k, v in servers.items()}})


def cmd_remove(args):
    if not os.path.exists(CONFIG_PATH):
        die(f"配置文件不存在：{CONFIG_PATH}")
    if args.name not in load_servers():
        die(f"未找到服务器 {args.name!r}。")
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        lines = f.readlines()

    header = re.compile(r"^\s*\[servers\." + re.escape(args.name) + r"\]\s*$")
    top_table = re.compile(r"^\s*\[")
    out, i, removed = [], 0, False
    while i < len(lines):
        if header.match(lines[i]):
            removed = True
            i += 1
            while i < len(lines) and not top_table.match(lines[i]):
                i += 1
            # 顺手吃掉块后多余空行，保持文件整洁
            while out and out[-1].strip() == "":
                out.pop()
            continue
        out.append(lines[i])
        i += 1

    if not removed:
        die(f"未定位到 [servers.{args.name}] 块。")
    text = "".join(out)
    if not text.endswith("\n"):
        text += "\n"
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        f.write(text)
    emit({"ok": True, "action": "removed", "name": args.name, "config": CONFIG_PATH})


def parse_args():
    ap = argparse.ArgumentParser(description="管理 ~/.navi/config.toml 的远程服务器条目")
    sub = ap.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("add", help="新增一台服务器")
    a.add_argument("--name", required=True)
    a.add_argument("--host", required=True, help="IP 或域名")
    a.add_argument("--auth", required=True, choices=["key", "password"])
    a.add_argument("--user", default="root")
    a.add_argument("--port", default=22, type=int)
    a.add_argument("--key-path", dest="key_path")
    a.add_argument("--password")
    a.set_defaults(func=cmd_add)

    sub.add_parser("list", help="列出所有服务器（密码脱敏）").set_defaults(func=cmd_list)

    r = sub.add_parser("remove", help="删除一台服务器")
    r.add_argument("--name", required=True)
    r.set_defaults(func=cmd_remove)

    return ap.parse_args()


if __name__ == "__main__":
    args = parse_args()
    args.func(args)
