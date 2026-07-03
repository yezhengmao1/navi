#!/usr/bin/env python3
"""单一功能：取某实验的原始折线点。裸数据，不算统计、不判异常、不重组形状。

每个 key 输出 [[step, value, timestamp], ...]。查询范围可选（监控时用 --since-step / --tail）。

用法：
  python3 get_metrics.py --path U/P/RID                       # 全部指标，服务端采样
  python3 get_metrics.py --path U/P/RID --keys loss,grad_norm # 指定指标
  python3 get_metrics.py --path U/P/RID --since-step 1000     # 只取 step>1000 的新点
  python3 get_metrics.py --path U/P/RID --tail 30             # 只取最近 30 个点
  python3 get_metrics.py --path U/P/RID --all --out run.csv   # 全分辨率并落 CSV
"""
import argparse
import os
import _common as c


def parse_args():
    ap = argparse.ArgumentParser(description="取 SwanLab 实验原始指标点")
    c.add_path_args(ap)
    ap.add_argument("--keys", help="逗号分隔；省略则取全部标量指标")
    ap.add_argument("--since-step", type=int, help="只取该 step 之后的新点（监控用）")
    ap.add_argument("--tail", type=int, help="只取最近 N 个点")
    ap.add_argument("--sample", type=int, default=1500, help="服务端采样上限（默认 1500）")
    ap.add_argument("--all", action="store_true", help="拉全分辨率数据，不采样")
    ap.add_argument("--out", help="把原始点写入 CSV（长表：key,step,value,timestamp）")
    return ap.parse_args()


if __name__ == "__main__":
    args = parse_args()
    with c.session() as (cfg, api):
        path = c.resolve_path(api, cfg, args)
        with c.quiet():
            exp = api.run(path)
            keys = [k.strip() for k in args.keys.split(",")] if args.keys else \
                sorted((exp.summary() or {}).keys())
        if not keys:
            c.die("该实验没有可用的标量指标。")

        range_query = None
        if args.since_step is not None:
            range_query = {"type": "step", "start": int(args.since_step)}
        elif args.tail is not None:
            range_query = {"tail": int(args.tail)}

        # exp.metrics 返回 dict：{keys, metricType, ..., list:[{key, metrics:[<point>], ...}]}
        # 点字段名随查询模式而变：采样模式为 index/data，all / range_query 模式为 step/value。
        def _pt(p):
            step = p["step"] if "step" in p else p.get("index")
            val = p["value"] if "value" in p else p.get("data")
            return [step, val, p.get("timestamp")]

        with c.quiet():
            data = exp.metrics(keys=keys, sample=args.sample, all=args.all,
                               range_query=range_query)
        series = {}
        for item in (data.get("list") or []):
            series[item.get("key")] = [_pt(p) for p in (item.get("metrics") or [])]

        if args.out:
            import csv
            with open(args.out, "w", newline="") as f:
                w = csv.writer(f)
                w.writerow(["key", "step", "value", "timestamp"])
                for key, pts in series.items():
                    for step, val, ts in pts:
                        w.writerow([key, step, val, ts])

        c.emit({
            "path": path,
            "experiment": c.exp_brief(exp),
            "keys": keys,
            "point_schema": ["step", "value", "timestamp"],
            "series": series,
            "csv": os.path.abspath(args.out) if args.out else None,
        })
