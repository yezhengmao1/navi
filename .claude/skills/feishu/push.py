#!/usr/bin/env python3
"""push.py — 把一段内容推送到飞书自定义机器人（群 webhook）。

原理：一次 HTTPS POST 到飞书群机器人 webhook，body 里带 msg_type + content。
webhook 形如 https://open.feishu.cn/open-apis/bot/v2/hook/<KEY>，其中 <KEY> 是
每个机器人独有的一段。KEY 既可用 --key 传参（优先），也可从配置读。

用法：
    # KEY 作参数传入（优先）
    python3 push.py --key 1b64311b-.... --content report.md
    echo "# 正文" | python3 push.py --key 1b64311b-.... --content -

    # 用 JSON 文件推（markdown/富文本格式最稳）
    python3 push.py --key <KEY> --data task.json
    python3 push.py --data task.json --dry-run       # 只打印 payload，不发

    # KEY 省略时回退到配置里的 [feishu].key
    python3 push.py --content report.md

正文默认作为「文本」消息推送；富文本/标题用 --title 会自动升级为 interactive 卡片。

JSON 文件字段（缺省项会补默认）：
    {
      "title":   "标题",              // 可选；给了则以卡片形式推
      "content": "# markdown 正文",   // 必填
      "key":     "覆盖配置/参数的 KEY" // 可选
    }

配置：~/.navi/config.toml 的 [feishu] 段：
    [feishu]
    key = "机器人 webhook 末段（hook/ 之后那串）"   # 可选，--key 未传时用
    # base_url = "https://open.feishu.cn/open-apis/bot/v2/hook/"  # 可选，默认飞书官方
"""

import argparse
import json
import os
import sys
import urllib.request
import urllib.error
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:  # py<3.11
    import tomli as tomllib  # type: ignore

CONFIG_PATH = Path("~/.navi/config.toml").expanduser()
DEFAULT_BASE = "https://open.feishu.cn/open-apis/bot/v2/hook/"


def load_cfg() -> dict:
    """读 [feishu]：key（可选，--key 未传时用）、base_url（可选）。配置不存在也不报错。"""
    fs = {}
    if CONFIG_PATH.exists():
        with open(CONFIG_PATH, "rb") as f:
            fs = tomllib.load(f).get("feishu") or {}
    return {"key": fs.get("key"), "base_url": fs.get("base_url") or DEFAULT_BASE}


def resolve_url(key: str, base_url: str) -> str:
    """KEY 可以是纯末段，也可以是整条 webhook；都归一成完整 URL。"""
    key = key.strip()
    if key.startswith("http://") or key.startswith("https://"):
        return key
    return base_url.rstrip("/") + "/" + key


def read_task(args) -> dict:
    """从 --data JSON 文件或 --content/--title 参数拼出 task 字段。"""
    if args.data:
        with open(args.data, "r", encoding="utf-8") as f:
            task = json.load(f)
    else:
        if not args.content:
            raise SystemExit("请用 --data task.json，或给 --content（文件/'-'/文本）。")
        content = (
            sys.stdin.read()
            if args.content == "-"
            else Path(args.content).read_text(encoding="utf-8")
            if os.path.exists(args.content)
            else args.content
        )
        task = {"content": content}
        if args.title:
            task["title"] = args.title
    if not task.get("content"):
        raise SystemExit("task 缺少 content。")
    return task


def build_payload(task: dict) -> dict:
    """有 title → interactive 卡片（正文按 lark_md 渲染 markdown）；否则纯文本。"""
    content = task["content"]
    title = task.get("title")
    if not title:
        return {"msg_type": "text", "content": {"text": content}}
    return {
        "msg_type": "interactive",
        "card": {
            "config": {"wide_screen_mode": True},
            "header": {
                "title": {"tag": "plain_text", "content": title},
                "template": task.get("template", "blue"),
            },
            "elements": [
                {"tag": "div", "text": {"tag": "lark_md", "content": content}}
            ],
        },
    }


def push(payload: dict, url: str, timeout: int = 30) -> dict:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json; charset=utf-8"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8", "replace")
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {"code": "?", "msg": raw[:500]}


def main() -> int:
    ap = argparse.ArgumentParser(description="推送内容到飞书群机器人")
    ap.add_argument("--key", help="webhook 末段（hook/ 之后那串），优先于配置")
    ap.add_argument("--data", help="任务 JSON 文件路径")
    ap.add_argument("--title", help="卡片标题；给了则以 interactive 卡片推送")
    ap.add_argument("--content", help="正文：文件路径 / '-' 读 stdin / 直接文本")
    ap.add_argument("--dry-run", action="store_true", help="只打印 payload，不实际发送")
    args = ap.parse_args()

    cfg = load_cfg()
    task = read_task(args)
    # KEY 优先级：--key > task.json 里的 key > 配置 [feishu].key
    key = args.key or task.get("key") or cfg["key"]
    if not key:
        raise SystemExit(
            "缺少 webhook KEY：用 --key 传入，或在 ~/.navi/config.toml 的 [feishu] 段填 key。"
        )
    url = resolve_url(key, cfg["base_url"])
    payload = build_payload(task)

    if args.dry_run:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0

    try:
        resp = push(payload, url)
    except urllib.error.HTTPError as e:
        raise SystemExit(
            f"❌ 推送失败 HTTP {e.code}：{e.read().decode('utf-8', 'replace')[:300]}"
        )
    except urllib.error.URLError as e:
        raise SystemExit(f"❌ 网络错误：{e.reason}")

    code = resp.get("code", resp.get("StatusCode"))
    if code in (0, "0"):
        print(f"✅ 推送成功{('：' + task['title']) if task.get('title') else ''}")
        return 0
    hint = {
        19021: "签名校验失败（该机器人开了签名校验，本 skill 未支持；请在群机器人设置里改用「自定义关键词」或关闭校验）",
        19024: "关键词校验失败（机器人设了自定义关键词，正文需包含其中之一）",
        9499: "参数错误，检查 webhook KEY 是否正确",
    }.get(code, "")
    print(f"❌ 推送失败 code={code} msg={resp.get('msg')}")
    if hint:
        print(f"   → {hint}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
