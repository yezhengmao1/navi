#!/usr/bin/env python3
"""单一功能：列出某项目下的全部实验（run）。裸数据，不加工、不过滤。

用法：python3 list_experiments.py [--username U] [--project P]
"""
import argparse
import _common as c


def parse_args():
    ap = argparse.ArgumentParser(description="列出 SwanLab 实验")
    ap.add_argument("--username", help="workspace；省略则用配置默认或当前用户")
    ap.add_argument("--project", help="项目名；省略则用配置默认")
    return ap.parse_args()


if __name__ == "__main__":
    args = parse_args()
    with c.session() as (cfg, api):
        username = args.username or cfg.get("username") or api.username
        project = args.project or cfg.get("project")
        if not project:
            c.die("缺少项目名：--project 或在配置里设 project。")
        with c.quiet():
            runs = list(api.runs(f"{username}/{project}"))
        out = [c.exp_brief(e) for e in runs]
        c.emit({"username": username, "project": project, "count": len(out),
                "experiments": out})
