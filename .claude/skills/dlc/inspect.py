#!/usr/bin/env python3
"""inspect.py — DLC 训练任务确定性巡检（不经 LLM 判级）。

把「取数 + 判是否前进」做成脚本，绕开 LLM 中间层在多步复核上的不稳定与高成本：
    - 列 Running / Queuing（复用 dlc.py list --json）。
    - 每个训练任务用 `dlc.py logs <id> --lines N --fresh` 取「日志最新」的 worker
      节点（--fresh 已从源头绕开陈旧缓存假 HANG），提取最新训练 iteration + 行内时间戳。
    - 按阈值判级：最新步距今 > max(30min, 15×单步) = 🔴；无 iteration 但日志活跃 = 评估/初始化中；
      workers ready 后 >60min 无 iteration = 🔴 卡初始化；纯推理服务（VLLMRouter）跳过。
    - 输出近纯文本分级报告（任务名加粗），供 hiboard / feishu 推送。

用法：
    python3 inspect.py                 # 打印报告到 stdout
    python3 inspect.py --out报告.txt    # 同时写报告文件（供推送）
    python3 inspect.py --lines 200     # 每个任务取的日志行数（默认 200）
"""
import argparse
import json
import re
import subprocess
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
DLC = str(HERE / "dlc.py")
CST = timezone(timedelta(hours=8))

# 纯推理 / 常驻服务（日志主体是 VLLMRouter 等），非训练，不判 HANG。按名字子串匹配。
INFER_MARKERS = ("ablation_ab_metrics", "-vllm", "-router", "-serving")

ITER = re.compile(r"iteration\s+(\d+)/\s*(\d+)|iter[:\s]+(\d+)/\s*(\d+)")
TS = re.compile(r"\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})")
TS_ISO = re.compile(r"time=(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})")
MS = re.compile(r"(?:elapsed time per iteration \(ms\)|ms/iter)[:\s]+([\d.]+)")


def _run(args, timeout=150):
    return subprocess.run(
        ["python3", DLC, *args], capture_output=True, text=True, timeout=timeout
    ).stdout


def is_infer(name):
    return any(m in name for m in INFER_MARKERS)


def judge(job, lines_n, now):
    """取一个训练任务的最新日志并判级，返回 (status, gpu, owner, name, msg)。"""
    jid, name, gpu, owner = job["job_id"], job["name"], job["gpu"], job["owner"]
    try:
        d = json.loads(_run(["logs", jid, "--json", "--lines", str(lines_n), "--fresh"]))
    except Exception as e:
        return ("⚠️", gpu, owner, name, f"取日志失败：{e}")
    lines, pod = d.get("lines", []), d.get("pod_id", "?")
    iters = [
        (int(m.group(1) or m.group(3)), int(m.group(2) or m.group(4)),
         TS.search(l).group(1) if TS.search(l) else None)
        for l in lines if (m := ITER.search(l))
    ]
    steps = [float(m.group(1)) for l in lines if (m := MS.search(l))]

    if not iters:  # 无训练 iteration：看日志是否还活跃
        stamps = [TS.search(l).group(1) for l in lines if TS.search(l)]
        stamps += [f"{m.group(1)} {m.group(2)}" for l in lines if (m := TS_ISO.search(l))]
        if not stamps:
            return ("🔴", gpu, owner, name, f"无任何训练输出/时间戳 [pod {pod}]")
        latest = max(stamps)
        mins = (now - datetime.strptime(latest, "%Y-%m-%d %H:%M:%S").replace(tzinfo=CST)).total_seconds() / 60
        if mins > 60:
            return ("🔴", gpu, owner, name,
                    f"无训练 iteration，日志停在 {latest[11:]}（{mins:.0f} 分钟前），卡初始化。建议 stop [pod {pod}]")
        return ("✅", gpu, owner, name,
                f"评估/初始化中（{latest[11:]} 活跃，{mins:.0f} 分前），无新训练步属评估阶段正常 [pod {pod}]")

    a, b, ts = iters[-1]
    step = sum(steps) / len(steps) / 1000 if steps else None  # ms→s
    mins = None if not ts else (now - datetime.strptime(ts, "%Y-%m-%d %H:%M:%S").replace(tzinfo=CST)).total_seconds() / 60
    thr = max(30, 15 * (step or 0) / 60)
    spd = f"{step:.1f} s/it（近{len(steps)}步均值）" if step else "?s/it"
    rem = f"剩~{(b - a) * step / 3600:.1f}h" if step else "剩?"
    pct = 100 * a / b
    if mins is not None and mins > thr:
        return ("🔴", gpu, owner, name,
                f"iter {a}/{b}({pct:.0f}%) 停在 {ts[11:]}，{mins:.0f} 分钟无新步（阈值 {thr:.0f} 分），疑 HANG [pod {pod}]")
    mstr = f"{mins:.0f} 分前更新" if mins is not None else "距今未知"
    return ("✅", gpu, owner, name, f"iter {a}/{b}({pct:.0f}%)，{spd}，{mstr}，{rem} [pod {pod}]")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lines", type=int, default=200)
    ap.add_argument("--out", default=None, help="报告写入的文件路径")
    args = ap.parse_args()

    now = datetime.now(CST)
    run = json.loads(_run(["list", "--json"]))
    que = json.loads(_run(["list", "--json", "--status", "Queuing"]))
    jobs = [j for j in run["jobs"] if not is_infer(j["name"])]
    infer = [j for j in run["jobs"] if is_infer(j["name"])]

    with ThreadPoolExecutor(max_workers=8) as ex:
        res = list(ex.map(lambda j: judge(j, args.lines, now), jobs))
    red = [r for r in res if r[0] == "🔴"]
    warn = [r for r in res if r[0] == "⚠️"]
    ok = [r for r in res if r[0] == "✅"]

    L = []
    L.append(f"DLC 训练任务巡检 · {now.strftime('%Y-%m-%d %H:%M')}")
    L.append(f"Running {len(jobs)} 训练 / {run['total_gpu']} 卡 · 🔴{len(red)} ✅{len(ok)}"
             f"{f' ⚠️{len(warn)}' if warn else ''} · 推理{len(infer)} · 排队 {len(que['jobs'])} 个 / {que['total_gpu']} 卡")
    L.append("资源池(运行卡)")
    for p in sorted(run.get("by_pool", []), key=lambda x: -x["gpu"]):
        L.append(f"  {p['pool']}   {p['gpu']}")
    bar = "━" * 20
    for tag, group in (("🔴 需处理", red + warn), ("✅ 正常", sorted(ok, key=lambda x: -x[1]))):
        if not group:
            continue
        L.append(bar)
        L.append(tag)
        for s, gpu, owner, name, msg in group:
            L.append(f"**{name}**")
            L.append(f"{owner} ｜ {gpu}卡")
            L.append(f"诊断：{msg}")
    if infer:
        L.append(bar)
        L.append("推理服务·非训练：" + "、".join(f"{j['name']}（{j['owner']} {j['gpu']}卡）" for j in infer))
    if que["jobs"]:
        L.append(f"⏳ 排队 {len(que['jobs'])} 个 / {que['total_gpu']} 卡")

    report = "\n".join(L)
    print(report)
    if args.out:
        Path(args.out).write_text(report, encoding="utf-8")


if __name__ == "__main__":
    main()
