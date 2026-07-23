#!/usr/bin/env python3
"""dlc.py — 阿里云 PAI-DLC 训练任务查询。

用官方 SDK（alibabacloud_pai_dlc20201203）读任务列表 / 日志：
    - 遍历「你能访问的所有工作空间」（先 ListWorkspaces），再逐个 ListJobs，
      这样才能看到同事在同一工作空间提交的任务，而不只是自己的。
    - GPU 卡数直接取 ListJobs 返回项的 request_gpu（无需逐个 GetJob）。
    - 属主取 username（真人名），比 user_id 直观。

用法：
    python3 dlc.py list                     # 全部 Running 任务（遍历所有可访问工作空间，含卡数/时长/属主）
    python3 dlc.py list --all-status        # 不限状态（默认只看 Running）
    python3 dlc.py list --status Failed     # 指定状态：Creating/Queuing/Running/Succeeded/Failed/Stopped
    python3 dlc.py list --mine              # 只看自己提交的
    python3 dlc.py list --workspace 600283  # 只查指定工作空间
    python3 dlc.py list --with-zero-gpu     # 保留 GPU=0 的任务（默认过滤）
    python3 dlc.py list --days 30           # 时间窗（默认近 7 天，DLC 服务端默认）
    python3 dlc.py logs <jobid> [--lines N] [--pod worker-3]
                                            # 某任务日志；默认取最后一个 worker，尾部 N 行
    python3 dlc.py workspaces               # 列出可访问的工作空间

输出统一是 JSON（--json）或人类可读表格（默认）。skill 编排时用 --json 更好解析。

配置：~/.navi/config.toml 的 [dlc] 段：
    [dlc]
    access_key_id     = "LTAI..."          # 建议用 RAM 子账号只读密钥
    access_key_secret = "..."
    region            = "cn-hangzhou"       # 任务所在地域
    workspace_id      = "513442"            # 可选，仅作 ListWorkspaces 失败时的回退目标
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:  # py<3.11
    import tomli as tomllib  # type: ignore

CONFIG_PATH = Path("~/.navi/config.toml").expanduser()


def load_cfg() -> dict:
    if not CONFIG_PATH.exists():
        raise SystemExit(
            f"未找到 {CONFIG_PATH}，请先在 [dlc] 段填 access_key_id / access_key_secret。"
        )
    with open(CONFIG_PATH, "rb") as f:
        d = tomllib.load(f).get("dlc") or {}
    ak, sk = d.get("access_key_id"), d.get("access_key_secret")
    if not ak or not sk:
        raise SystemExit(
            "配置缺少 [dlc].access_key_id / access_key_secret。\n"
            "建议用阿里云 RAM 子账号的只读密钥（授予 PAI-DLC 只读权限）。"
        )
    return {
        "ak": ak,
        "sk": sk,
        "region": d.get("region") or "cn-hangzhou",
        "workspace_id": (str(d["workspace_id"]) if d.get("workspace_id") else None),
    }


def _clients(cfg):
    """构造 DLC 客户端与（可选的）工作空间客户端。SDK 缺失时给出明确安装提示。"""
    try:
        from alibabacloud_pai_dlc20201203.client import Client as DlcClient
        from alibabacloud_pai_dlc20201203 import models as dlc_models
        from alibabacloud_tea_openapi import models as open_api_models
    except ModuleNotFoundError:
        raise SystemExit(
            "缺少依赖，请先安装：\n"
            "  pip install alibabacloud_pai_dlc20201203 "
            "alibabacloud_aiworkspace20210204 alibabacloud_tea_openapi"
        )

    def mk(endpoint):
        c = open_api_models.Config(access_key_id=cfg["ak"], access_key_secret=cfg["sk"])
        c.endpoint = endpoint
        return c

    dlc = DlcClient(mk(f"pai-dlc.{cfg['region']}.aliyuncs.com"))
    return dlc, dlc_models, mk


def list_workspaces(cfg, dlc_models, mk):
    """返回 [(workspace_id, name), ...]；失败则回退到配置里的 workspace_id。"""
    try:
        from alibabacloud_aiworkspace20210204.client import Client as WsClient
        from alibabacloud_aiworkspace20210204 import models as ws_models

        wsc = WsClient(mk(f"aiworkspace.{cfg['region']}.aliyuncs.com"))
        req = ws_models.ListWorkspacesRequest(page_number=1, page_size=100)
        body = wsc.list_workspaces(req).body
        out = [(str(w.workspace_id), w.workspace_name) for w in (body.workspaces or [])]
        if out:
            return out
    except Exception:
        pass
    if cfg["workspace_id"]:
        return [(cfg["workspace_id"], cfg["workspace_id"])]
    raise SystemExit("列不出工作空间，且 [dlc].workspace_id 未配置，无法继续。")


def _gpu_of(job) -> int:
    """优先用返回项现成的 request_gpu；缺失则从 job_specs 累加 gpu×pod_count。"""
    rg = getattr(job, "request_gpu", None)
    if rg is not None and str(rg).isdigit():
        return int(rg)
    total = 0
    for s in getattr(job, "job_specs", None) or []:
        rc = getattr(s, "resource_config", None)
        g = int(rc.gpu) if (rc and rc.gpu and str(rc.gpu).isdigit()) else 0
        total += g * (getattr(s, "pod_count", 0) or 0)
    return total


def _duration_str(job, now) -> str:
    """已运行时长：优先 gmt_running_time→现在；否则用返回的 duration 秒数。"""
    t = getattr(job, "gmt_running_time", None)
    sec = None
    if t:
        st = datetime.fromisoformat(t.replace("Z", "+00:00"))
        sec = (now - st).total_seconds()
    elif getattr(job, "duration", None):
        sec = float(job.duration)
    if sec is None or sec < 0:
        return "-"
    sec = int(sec)
    d, r = divmod(sec, 86400)
    h, r = divmod(r, 3600)
    m = r // 60
    return f"{d}d{h}h" if d else f"{h}h{m}m"


def cmd_list(cfg, args):
    dlc, dlc_models, mk = _clients(cfg)
    # 默认遍历「你能访问的全部工作空间」（这样才看得到同事的任务）；
    # --workspace <id> 只查指定的那一个。
    if args.workspace:
        spaces = [(args.workspace, args.workspace)]
    else:
        spaces = list_workspaces(cfg, dlc_models, mk)

    now = datetime.now(timezone.utc)
    status = None if args.all_status else args.status
    start_time = None
    if args.days:
        start_time = (now - timedelta(days=args.days)).strftime("%Y-%m-%dT%H:%M:%SZ")

    rows = []
    for wid, wname in spaces:
        page = 1
        while True:
            req = dlc_models.ListJobsRequest(
                workspace_id=wid,
                status=status,
                show_own=bool(args.mine),
                page_number=page,
                page_size=100,
                order="desc",
                sort_by="GmtCreateTime",
                start_time=start_time,
            )
            body = dlc.list_jobs(req).body
            jobs = body.jobs or []
            for j in jobs:
                gpu = _gpu_of(j)
                if gpu == 0 and not args.with_zero_gpu:
                    continue
                rows.append(
                    {
                        "workspace": wname,
                        "workspace_id": wid,
                        "job_id": j.job_id,
                        "name": j.display_name,
                        "status": j.status,
                        "job_type": j.job_type,
                        "gpu": gpu,
                        "duration": _duration_str(j, now),
                        "owner": getattr(j, "username", None)
                        or getattr(j, "user_id", ""),
                        # 资源池（自管理 ACK 池名，如 infra / ai_lab_resources）；
                        # 用于按池汇总运行/排队卡量。取不到回退占位。
                        "resource_pool": getattr(j, "resource_name", None) or "-",
                        "gmt_running_time": getattr(j, "gmt_running_time", None),
                        "gmt_create_time": j.gmt_create_time,
                    }
                )
            if len(jobs) < 100:
                break
            page += 1

    rows.sort(key=lambda r: -r["gpu"])
    total = sum(r["gpu"] for r in rows)

    # 按资源池汇总卡量（含任务数），供上层直接分池展示 运行/排队 卡量。
    pools: dict[str, dict] = {}
    for r in rows:
        p = pools.setdefault(r["resource_pool"], {"pool": r["resource_pool"], "gpu": 0, "jobs": 0})
        p["gpu"] += r["gpu"]
        p["jobs"] += 1
    by_pool = sorted(pools.values(), key=lambda p: -p["gpu"])

    if args.json:
        print(
            json.dumps(
                {"count": len(rows), "total_gpu": total, "by_pool": by_pool, "jobs": rows},
                ensure_ascii=False,
                indent=2,
            )
        )
        return

    label = "全部状态" if args.all_status else (status or "Running")
    print(f"DLC 任务（{cfg['region']}，{label}，{len(rows)} 个，合计 {total} 卡）")
    print("-" * 100)
    print(f"{'GPU':>5}  {'已运行':>7}  {'状态':<9}  {'工作空间':<16}{'属主':<10}任务")
    print("-" * 100)
    for r in rows:
        print(
            f"{r['gpu']:>5}  {r['duration']:>7}  {r['status']:<9}  "
            f"{r['workspace'][:14]:<16}{str(r['owner'])[:8]:<10}{r['name'][:42]}"
        )
    print("-" * 100)


def cmd_logs(cfg, args):
    dlc, dlc_models, mk = _clients(cfg)
    job = dlc.get_job(args.job_id, dlc_models.GetJobRequest()).body
    pods = job.pods or []
    if not pods:
        raise SystemExit(f"任务 {args.job_id} 没有 pod（可能未开始或已释放）。")

    if args.pod:
        cand = [p for p in pods if args.pod in (p.pod_id or "")]
        if not cand:
            raise SystemExit(
                f"没有匹配 '{args.pod}' 的 pod。现有：{[p.pod_id for p in pods]}"
            )
        pod = cand[0]
    else:
        # “最后一个节点”：按 worker 数字序号最大者（回退按启动时间）
        def worker_idx(p):
            pid = p.pod_id or ""
            tail = pid.rsplit("-", 1)[-1]
            return int(tail) if tail.isdigit() else -1

        pod = max(pods, key=lambda p: (worker_idx(p), p.gmt_start_time or ""))

    req = dlc_models.GetPodLogsRequest(max_lines=args.lines)
    resp = dlc.get_pod_logs(args.job_id, pod.pod_id, req).body
    logs = resp.logs or []

    if args.json:
        print(
            json.dumps(
                {
                    "job_id": args.job_id,
                    "name": job.display_name,
                    "pod_id": pod.pod_id,
                    "pod_type": pod.type,
                    "pod_status": pod.status,
                    "node": pod.node_name,
                    "lines": logs,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return

    print(f"任务: {job.display_name}  ({args.job_id})  共 {len(pods)} 个 pod")
    print(
        f"节点: {pod.pod_id}  type={pod.type} status={pod.status} "
        f"node={pod.node_name} start={pod.gmt_start_time}"
    )
    print("=" * 80)
    for line in logs:
        print(line.rstrip())
    print("=" * 80)
    print(f"（{len(logs)} 行）")


def cmd_workspaces(cfg, args):
    dlc, dlc_models, mk = _clients(cfg)
    spaces = list_workspaces(cfg, dlc_models, mk)
    if args.json:
        print(
            json.dumps(
                [{"workspace_id": w, "name": n} for w, n in spaces],
                ensure_ascii=False,
                indent=2,
            )
        )
        return
    print(f"可访问工作空间（{cfg['region']}，{len(spaces)} 个）：")
    for wid, name in spaces:
        print(f"  {wid}  {name}")


def parse_args():
    ap = argparse.ArgumentParser(description="阿里云 PAI-DLC 任务查询")
    ap.add_argument("--json", action="store_true", help="输出 JSON（便于程序解析）")
    sub = ap.add_subparsers(dest="cmd")

    # --json 同时挂到每个子命令上（default=SUPPRESS：不给就沿用顶层值，给了才覆盖），
    # 这样 `dlc.py --json list` 和 `dlc.py list --json` 都能用。
    def add_json(parser):
        parser.add_argument(
            "--json",
            action="store_true",
            default=argparse.SUPPRESS,
            help="输出 JSON（便于程序解析）",
        )

    p = sub.add_parser("list", help="列任务（默认全部工作空间的 Running）")
    add_json(p)
    p.add_argument(
        "--status",
        default="Running",
        help="任务状态，默认 Running（Creating/Queuing/Running/Succeeded/Failed/Stopped）",
    )
    p.add_argument("--all-status", action="store_true", help="不限状态")
    p.add_argument("--mine", action="store_true", help="只看自己提交的")
    p.add_argument(
        "--workspace",
        default=None,
        help="只查指定工作空间 id（默认遍历全部可访问工作空间）",
    )
    p.add_argument("--with-zero-gpu", action="store_true", help="保留 GPU=0 的任务")
    p.add_argument("--days", type=int, default=None, help="只看最近 N 天创建的任务")

    p = sub.add_parser("logs", help="取某任务最后一个节点的日志")
    add_json(p)
    p.add_argument("job_id")
    p.add_argument("--lines", type=int, default=50, help="尾部行数，默认 50")
    p.add_argument("--pod", default=None, help="指定 pod（子串匹配，如 worker-3）")

    add_json(sub.add_parser("workspaces", help="列可访问的工作空间"))

    args = ap.parse_args()
    if args.cmd is None:  # 裸调用默认 list（重解析后 --json 自然为 False）
        args = ap.parse_args(["list"])
    return args


if __name__ == "__main__":
    args = parse_args()
    cfg = load_cfg()
    if args.cmd == "list":
        cmd_list(cfg, args)
    elif args.cmd == "logs":
        cmd_logs(cfg, args)
    elif args.cmd == "workspaces":
        cmd_workspaces(cfg, args)
