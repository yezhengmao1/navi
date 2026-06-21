#!/usr/bin/env python3
"""paper — 基于 PaperQA2 的 Zotero 论文问答 CLI。

子命令：
    paper sync                从 Zotero 同步 PDF 到 cache，并建/更新 PaperQA 索引
        --full                忽略增量锚点，全量重扫 Zotero
        --limit N             只同步前 N 篇（调试）
    paper ask ["问题"]        对论文库问答；带问题=单次问，省略=进交互式 REPL
    paper status              查看 cache 里 PDF 数 / 索引状态

配置全部读 ~/.navi/config.toml（[paper] + [zotero]）。详见同目录 config.py。
"""

import argparse
import asyncio
import csv
import json
import os
import re
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config  # noqa: E402
import zotero_sync  # noqa: E402
from paperqa.agents import agent_query  # noqa: E402
from paperqa.agents.search import get_directory_index  # noqa: E402

_FNAME_RE = re.compile(r"^(.*?)\s*-\s*(\d{4})\s*-\s*(.*)$")


def write_pqa_manifest(cfg) -> int:
    rows = []
    for p in sorted(cfg["pdf_dir"].glob("*.pdf")):
        stem = p.stem
        m = _FNAME_RE.match(stem)
        if m:
            authors, year, title = m.group(1).strip(), m.group(2), m.group(3).strip()
            row = {
                "file_location": p.name,
                "title": f"{title or stem} ({year})",
                "authors": json.dumps([authors], ensure_ascii=False),
            }
        else:
            row = {"file_location": p.name, "title": stem, "authors": "[]"}
        rows.append(row)
    with open(cfg["pqa_manifest"], "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["file_location", "title", "authors"])
        w.writeheader()
        w.writerows(rows)
    return len(rows)


def _answer_text(resp):
    for getter in (
        lambda r: r.session.formatted_answer,
        lambda r: r.formatted_answer,
        lambda r: r.session.answer,
        lambda r: str(r),
    ):
        try:
            t = getter(resp)
            if t:
                return t
        except Exception:  # noqa: BLE001
            continue
    return str(resp)


async def cmd_sync(cfg, full=False, limit=0):
    config.ensure_dirs(cfg)
    print(f"缓存目录: {cfg['cache']}")
    print("→ 从 Zotero 同步 PDF …")
    st = zotero_sync.sync(cfg, limit=limit, full=full)
    print(
        f"  新增 {st['pulled']} / 去重跳过 {st['skipped']} / 失败 {st['failed']}"
        f"（cache 共 {st['total_in_cache']} 篇，library v{st['library_version']}）"
    )
    for f in st["failures"][:10]:
        print(f"  ! {f['key']}: {f['why']}")

    if full and cfg["index_dir"].exists():
        shutil.rmtree(cfg["index_dir"])
    n_man = write_pqa_manifest(cfg)
    print(f"→ 引用清单: {n_man} 篇 → {cfg['pqa_manifest']}")
    print(
        f"→ 建/更新 PaperQA 索引（仅 embedding，并发 {cfg['concurrency']}，首次较慢）…"
    )
    settings = config.paperqa_settings(cfg)
    index = await get_directory_index(settings=settings)
    try:
        n = len(await index.index_files)
    except Exception:  # noqa: BLE001
        n = "?"
    print(f"  索引完成，已索引文档数: {n}")


async def cmd_ask(cfg, question=None):
    if not cfg["pdf_dir"].exists() or not any(cfg["pdf_dir"].glob("*.pdf")):
        print("cache 里还没有 PDF，请先运行：paper sync")
        return
    settings = config.paperqa_settings(cfg)

    async def answer(q, attempts=3):
        last = None
        for i in range(attempts):
            try:
                resp = await agent_query(query=q, settings=settings)
                return _answer_text(resp)
            except Exception as e:  # noqa: BLE001
                last = e
                if i < attempts - 1:
                    print(f"  (第 {i + 1} 次失败：{type(e).__name__}，重试…)")
        return f"问答失败（重试 {attempts} 次）：{type(last).__name__}: {last}"

    if question:
        print(await answer(question))
        return

    print(f"论文问答（模型 {cfg['llm']}）。输入问题，exit / Ctrl-D 退出。")
    while True:
        try:
            q = input("\n问> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not q:
            continue
        if q in ("exit", "quit", "q"):
            break
        try:
            print("\n" + await answer(q))
        except Exception as e:  # noqa: BLE001
            print(f"出错: {type(e).__name__}: {e}")


def cmd_status(cfg):
    pdfs = list(cfg["pdf_dir"].glob("*.pdf")) if cfg["pdf_dir"].exists() else []
    print(f"缓存目录 : {cfg['cache']}")
    print(f"PDF 数量 : {len(pdfs)}")
    print(
        f"索引目录 : {cfg['index_dir']}（{'存在' if cfg['index_dir'].exists() else '未建'}）"
    )
    print(f"模型     : llm={cfg['llm']}  embedding={cfg['embedding']}")
    man = cfg["manifest"]
    if man.exists():
        m = json.load(open(man))
        print(
            f"library_version: {m.get('library_version')}  manifest 记录: {len(m.get('files', {}))} 篇"
        )


if __name__ == "__main__":
    ap = argparse.ArgumentParser(
        prog="paper", description="基于 PaperQA2 的 Zotero 论文问答"
    )
    sub = ap.add_subparsers(dest="cmd", required=True)
    sp = sub.add_parser("sync", help="同步 Zotero PDF + 建索引")
    sp.add_argument("--full", action="store_true", help="全量重扫 Zotero")
    sp.add_argument("--limit", type=int, default=0, help="只同步前 N 篇")
    ap_ask = sub.add_parser("ask", help="对论文库问答（交互或单次）")
    ap_ask.add_argument("question", nargs="?", help="一次性问题；省略进交互式")
    sub.add_parser("status", help="查看 cache / 索引状态")
    args = ap.parse_args()

    cfg = config.load()
    if args.cmd == "sync":
        asyncio.run(cmd_sync(cfg, full=args.full, limit=args.limit))
    elif args.cmd == "ask":
        asyncio.run(cmd_ask(cfg, question=args.question))
    elif args.cmd == "status":
        cmd_status(cfg)
