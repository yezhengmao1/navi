#!/usr/bin/env python3
"""单一功能：列出某 workspace 下的全部项目。裸数据，不加工。

用法：python3 list_projects.py [--username U]
"""
import argparse
import _common as c


def parse_args():
    ap = argparse.ArgumentParser(description="列出 SwanLab 项目")
    ap.add_argument("--username", help="workspace；省略则用配置默认或当前用户")
    return ap.parse_args()


if __name__ == "__main__":
    args = parse_args()
    with c.session() as (cfg, api):
        username = args.username or cfg.get("username") or api.username
        with c.quiet():
            projects = list(api.projects(username, all=True))
        out = []
        for p in projects:
            try:
                out.append(p.json())
            except Exception:
                out.append({"name": getattr(p, "name", None)})
        c.emit({"username": username, "projects": out})
