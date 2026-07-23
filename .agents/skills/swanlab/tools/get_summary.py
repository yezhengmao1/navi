#!/usr/bin/env python3
"""单一功能：取某实验的指标 summary（SwanLab 服务端返回的 latest/min/max/... 原文）。

返回的 summary 的 key 即该实验全部标量指标名，可用于指标发现。裸数据，不二次加工。

用法：python3 get_summary.py --path U/P/RID [--keys loss,acc]
   或 python3 get_summary.py --username U --project P --exp RID
"""
import argparse
import _common as c


def parse_args():
    ap = argparse.ArgumentParser(description="取 SwanLab 实验 summary")
    c.add_path_args(ap)
    ap.add_argument("--keys", help="逗号分隔；省略则取全部指标")
    return ap.parse_args()


if __name__ == "__main__":
    args = parse_args()
    with c.session() as (cfg, api):
        path = c.resolve_path(api, cfg, args)
        keys = [k.strip() for k in args.keys.split(",")] if args.keys else None
        with c.quiet():
            exp = api.run(path)
            summary = exp.summary(keys=keys)
        c.emit({"path": path, "experiment": c.exp_brief(exp), "summary": summary})
