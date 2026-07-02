#!/usr/bin/env python3
"""push.py — 把一段任务结果推送到华为/荣耀手机「负一屏」（HiBoard 服务动态）。

原理：一次 HTTPS POST 到负一屏云推送端点，body 里带 authCode + 一条 msgContent
（markdown 正文）。authCode 从手机负一屏关联「Claw 智能体」后获取。

用法：
    # 用 JSON 文件推（推荐，markdown 格式最稳）
    python3 push.py --data task.json
    python3 push.py --data task.json --dry-run      # 只打印 payload，不发

    # 直接传字段（正文可用 - 从 stdin 读）
    python3 push.py --name "每日简报" --result "已完成" --content report.md
    echo "# 正文" | python3 push.py --name "简报" --content -

JSON 文件字段（缺省项会补默认）：
    {
      "task_name":  "任务名",           // 必填
      "task_content": "# markdown 正文", // 必填
      "task_result": "任务已完成",       // 可选，默认「任务已完成」
      "summary":     "……任务已完成",     // 可选，默认据 name/result 生成
      "task_id":     "自定义ID",         // 可选，默认据时间生成
      "auth_code":   "覆盖配置里的授权码"  // 可选
    }

配置：~/.navi/config.toml 的 [hiboard] 段：
    [hiboard]
    auth_code = "从负一屏获取的授权码"     # 必填
    push_url  = "https://..."             # 可选，默认华为云端点
"""
import argparse
import json
import os
import sys
import time
import uuid
import urllib.request
import urllib.error
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:  # py<3.11
    import tomli as tomllib  # type: ignore

CONFIG_PATH = Path("~/.navi/config.toml").expanduser()
DEFAULT_URL = ("https://hiboard-claw-drcn.ai.dbankcloud.cn"
               "/distribution/message/cloud/claw/msg/upload")


def load_cfg() -> dict:
    """读 [hiboard]：auth_code（必填）、push_url（可选）。"""
    if not CONFIG_PATH.exists():
        raise SystemExit(f"未找到 {CONFIG_PATH}，请先在 [hiboard] 段填 auth_code。")
    with open(CONFIG_PATH, "rb") as f:
        hb = (tomllib.load(f).get("hiboard") or {})
    auth = hb.get("auth_code")
    if not auth:
        raise SystemExit(
            "配置缺少 [hiboard].auth_code。\n"
            "获取：手机负一屏 → 我的 → 动态管理 → 关联账号 → Claw 智能体 → 获取授权码")
    return {"auth_code": auth, "push_url": hb.get("push_url") or DEFAULT_URL}


def read_task(args) -> dict:
    """从 --data JSON 文件或 --name/--content 参数拼出 task 字段。"""
    if args.data:
        with open(args.data, "r", encoding="utf-8") as f:
            task = json.load(f)
    else:
        if not args.name or not args.content:
            raise SystemExit("请用 --data task.json，或同时给 --name 与 --content。")
        content = sys.stdin.read() if args.content == "-" else \
            Path(args.content).read_text(encoding="utf-8") if os.path.exists(args.content) \
            else args.content
        task = {"task_name": args.name, "task_content": content}
        if args.result:
            task["task_result"] = args.result
    if not task.get("task_name") or not task.get("task_content"):
        raise SystemExit("task 缺少 task_name 或 task_content。")
    return task


def build_payload(task: dict, auth_code: str) -> dict:
    """把 task 字段转成负一屏要求的标准 payload。

    实测端点契约（与技能文档略有出入，以实测为准）：
      - 整体包一层 {"data": {...}}
      - 每条 msgContent 需自带 msgId（否则报 msgId cannot be blank）
    """
    name = task["task_name"]
    result = task.get("task_result", "任务已完成")
    tid = task.get("task_id") or f"task_{int(time.time())}"
    return {
        "data": {
            "authCode": task.get("auth_code") or auth_code,
            "msgContent": [{
                "msgId": task.get("msg_id") or uuid.uuid4().hex,
                "scheduleTaskId": task.get("schedule_task_id") or tid,
                "scheduleTaskName": name,
                "summary": task.get("summary") or f"{name}{result}",
                "result": result,
                "content": task["task_content"],
                "source": task.get("source", "OpenClaw"),
                "taskFinishTime": int(time.time()),  # 秒级 UTC 时间戳
            }],
        },
    }


def push(payload: dict, url: str, timeout: int = 30) -> dict:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "x-trace-id": uuid.uuid4().hex,  # 端点必填，缺失报 x-trace-id is empty
        })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8", "replace")
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {"code": "?", "desc": raw[:500]}


def main() -> int:
    ap = argparse.ArgumentParser(description="推送任务结果到负一屏（HiBoard）")
    ap.add_argument("--data", help="任务 JSON 文件路径")
    ap.add_argument("--name", help="任务名（不用 --data 时）")
    ap.add_argument("--content", help="markdown 正文：文件路径 / '-' 读 stdin / 直接文本")
    ap.add_argument("--result", help="任务结果描述，默认「任务已完成」")
    ap.add_argument("--dry-run", action="store_true", help="只打印 payload，不实际发送")
    args = ap.parse_args()

    cfg = load_cfg()
    task = read_task(args)
    payload = build_payload(task, cfg["auth_code"])

    if args.dry_run:
        shown = json.loads(json.dumps(payload))
        ac = shown["data"]["authCode"]
        shown["data"]["authCode"] = ac[:4] + "***"  # 脱敏
        print(json.dumps(shown, ensure_ascii=False, indent=2))
        return 0

    try:
        resp = push(payload, cfg["push_url"])
    except urllib.error.HTTPError as e:
        raise SystemExit(f"❌ 推送失败 HTTP {e.code}：{e.read().decode('utf-8','replace')[:300]}")
    except urllib.error.URLError as e:
        raise SystemExit(f"❌ 网络错误：{e.reason}")

    code = str(resp.get("code", ""))
    if code in ("0000000000", "0"):
        print(f"✅ 推送成功：{task['task_name']}")
        return 0
    hint = {
        "0000900034": "授权码无效或未关联：负一屏 → 我的 → 动态管理 → 关联账号 → Claw 智能体 重新获取",
        "0200100004": "负一屏云推送异常，检查手机已联网/登录华为账号，且「动态管理」里 AI 任务完成通知开关已开",
    }.get(code, "")
    print(f"❌ 推送失败 code={code} desc={resp.get('desc')}")
    if hint:
        print(f"   → {hint}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
