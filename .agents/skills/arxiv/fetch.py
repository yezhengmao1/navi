#!/usr/bin/env python3
"""抓取 arxiv 今日新公告，输出 JSON。

RSS 全量返回（当日常有数百条），WebFetch 会截断到前 ~50 条，故走 urllib 自取。
默认剔除 announce_type 为 replace/replace-cross 的旧论文更新，只留当日新公告。
"""

import argparse
import json
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET

RSS_URL = "https://rss.arxiv.org/rss/cs.AI+cs.CL+cs.LG+cs.CE+cs.DB+cs.DC+cs.MA+cs.OS+cs.SY"
API_URL = (
    "https://export.arxiv.org/api/query"
    "?search_query=cat:cs.AI+OR+cat:cs.CL+OR+cat:cs.LG+OR+cat:cs.DC+OR+cat:cs.DB"
    "&sortBy=submittedDate&sortOrder=descending&max_results={n}"
)

NS = {
    "dc": "http://purl.org/dc/elements/1.1/",
    "arxiv": "http://arxiv.org/schemas/atom",
    "atom": "http://www.w3.org/2005/Atom",
}

UA = {"User-Agent": "navi-arxiv/1.0 (personal daily digest)"}


def get(url, timeout=60):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def text(node, path, ns=None):
    el = node.find(path, ns or {})
    return "".join(el.itertext()).strip() if el is not None else ""


def parse_rss(raw):
    root = ET.fromstring(raw)
    channel = root.find("channel")
    if channel is None:
        return "", []
    date = text(channel, "pubDate")
    items = []
    for item in channel.findall("item"):
        items.append(
            {
                "title": text(item, "title"),
                "link": text(item, "link"),
                "authors": text(item, "dc:creator", NS),
                "abstract": text(item, "description"),
                "announce_type": text(item, "arxiv:announce_type", NS),
            }
        )
    return date, items


def parse_api(raw):
    root = ET.fromstring(raw)
    items = []
    for entry in root.findall("atom:entry", NS):
        authors = ", ".join(
            text(a, "atom:name", NS) for a in entry.findall("atom:author", NS)
        )
        items.append(
            {
                "title": text(entry, "atom:title", NS),
                "link": text(entry, "atom:id", NS),
                "authors": authors,
                "abstract": text(entry, "atom:summary", NS),
                "announce_type": "new",
            }
        )
    return items


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--keep-replace",
        action="store_true",
        help="保留 replace/replace-cross（旧论文更新），默认剔除",
    )
    ap.add_argument("--max-results", type=int, default=200, help="API 回退时的抓取上限")
    args = ap.parse_args()

    source, date, items = "rss", "", []
    try:
        date, items = parse_rss(get(RSS_URL))
    except (urllib.error.URLError, ET.ParseError) as e:
        print(f"RSS 抓取失败（{e}），回退 API", file=sys.stderr)

    if not items:  # 周末/假期 RSS 为空
        source = "api"
        try:
            items = parse_api(get(API_URL.format(n=args.max_results)))
        except (urllib.error.URLError, ET.ParseError) as e:
            print(f"API 抓取也失败：{e}", file=sys.stderr)
            return 1

    total = len(items)
    if not args.keep_replace:
        items = [i for i in items if not i["announce_type"].startswith("replace")]

    json.dump(
        {
            "source": source,
            "feed_date": date,
            "total_fetched": total,
            "announced_today": len(items),
            "papers": items,
        },
        sys.stdout,
        ensure_ascii=False,
        indent=2,
    )
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
