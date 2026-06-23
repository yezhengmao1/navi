"""zotero_sync.py — 从 Zotero 增量拉 PDF 到本地 cache，按内容 md5 去重。

读 ~/.navi/config.toml 的 [zotero] 段（api_key / user_id / webdav_*）；
靠 manifest.json 的 library_version 做增量锚点，文件经 WebDAV 拉取。
"""
import argparse
import base64
import hashlib
import io
import json
import os
import re
import sys
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from urllib.parse import urlencode

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config  # noqa: E402

API_BASE = "https://api.zotero.org"


def _z(cfg_zot: dict):
    if not cfg_zot.get("api_key"):
        raise SystemExit("config.toml 缺少 [zotero].api_key。")
    ltype = (cfg_zot.get("library_type") or "user").lower()
    lib_id = cfg_zot.get("group_id") if ltype == "group" else cfg_zot.get("user_id")
    if not lib_id:
        raise SystemExit("[zotero] 缺少 user_id（或 group_id）。")
    prefix = f"/{'groups' if ltype == 'group' else 'users'}/{lib_id}"
    webdav = {
        "url": (cfg_zot.get("webdav_url") or "").rstrip("/") + "/",
        "user": cfg_zot.get("webdav_user", ""),
        "pw": cfg_zot.get("webdav_password", ""),
    }
    return cfg_zot["api_key"], prefix, webdav


def _api_get(path, key, params=None):
    url = API_BASE + path
    if params:
        url += "?" + urlencode(params)
    req = urllib.request.Request(url)
    req.add_header("Zotero-API-Version", "3")
    req.add_header("Zotero-API-Key", key)
    return urllib.request.urlopen(req, timeout=30)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def _webdav_fetch(zip_url, user, pw):
    # alist 多半 302 到 OSS 签名直链：先拿 Location 再无鉴权下载。
    req = urllib.request.Request(zip_url)
    if user:
        token = base64.b64encode(f"{user}:{pw}".encode()).decode()
        req.add_header("Authorization", "Basic " + token)
    try:
        return _OPENER.open(req, timeout=60).read()
    except urllib.error.HTTPError as e:
        if e.code in (301, 302, 303, 307, 308):
            loc = e.headers.get("Location")
            if not loc:
                raise
            return urllib.request.urlopen(loc, timeout=180).read()
        raise


def _safe_name(name, key):
    name = (name or f"{key}.pdf").replace("/", "_").replace("\0", "")
    if not name.lower().endswith(".pdf"):
        name += ".pdf"
    return name


def _list_pdfs(key, prefix, since):
    pdfs, start, lib_version = [], 0, None
    while True:
        resp = _api_get(f"{prefix}/items", key, params={
            "since": since, "itemType": "attachment", "format": "json",
            "limit": 100, "start": start, "includeTrashed": 0,
        })
        if lib_version is None:
            lib_version = resp.headers.get("Last-Modified-Version")
        batch = json.loads(resp.read().decode("utf-8"))
        if not batch:
            break
        for it in batch:
            d = it.get("data", {})
            if d.get("contentType") != "application/pdf":
                continue
            if not str(d.get("linkMode", "")).startswith("imported"):
                continue  # linked_file/url 无托管字节
            pdfs.append({
                "key": d.get("key"), "version": it.get("version"),
                "filename": d.get("filename"), "md5": d.get("md5"),
                "dateAdded": d.get("dateAdded"),
                "parentItem": d.get("parentItem"),
            })
        start += 100
        if len(batch) < 100:
            break
    return pdfs, lib_version


def _load_manifest(path: Path) -> dict:
    if path.exists():
        with open(path) as f:
            return json.load(f)
    return {"library_version": "0", "files": {}}


def _items_by_keys(prefix, key, item_keys):
    """批量按 itemKey 取 Zotero item.data（每批 50，Zotero 单请求上限）。"""
    out, keys = {}, [k for k in item_keys if k]
    for i in range(0, len(keys), 50):
        batch = keys[i:i + 50]
        resp = _api_get(f"{prefix}/items", key, params={
            "itemKey": ",".join(batch), "format": "json",
            "limit": 50, "includeTrashed": 1,
        })
        for it in json.loads(resp.read().decode("utf-8")):
            d = it.get("data", {})
            if d.get("key"):
                out[d["key"]] = d
    return out


def _bib_from_parent(pd: dict) -> dict:
    """把 Zotero 父条目的 data 拍平成 {title, authors[], year, journal, doi}。"""
    authors = []
    for c in pd.get("creators", []):
        if c.get("creatorType") not in (None, "author"):
            continue
        name = " ".join(x for x in (c.get("firstName"), c.get("lastName")) if x)
        name = name or c.get("name")
        if name:
            authors.append(name)
    m = re.search(r"(19|20|21)\d{2}", pd.get("date") or "")
    year = int(m.group(0)) if m else None
    journal = next((pd.get(k) for k in (
        "publicationTitle", "conferenceName", "proceedingsTitle",
        "journalAbbreviation", "repository", "publisher",
    ) if pd.get(k)), "")
    return {
        "title": pd.get("title") or "", "authors": authors,
        "year": year, "journal": journal, "doi": pd.get("DOI") or "",
    }


def enrich(cfg: dict, files: dict, force: bool = False) -> int:
    """给 manifest 里缺 `meta` 的附件补 Zotero 父条目的书目信息（title/authors/year…）。

    纯 Zotero API（批量），不下载附件；写入 files[key]['meta']。返回补全条数。
    """
    targets = [k for k, v in files.items() if force or "meta" not in v]
    if not targets:
        return 0
    key, prefix, _ = _z(cfg["zotero"])
    # 老 manifest 没记 parentItem 的，按 itemKey 批量回查附件拿 parentItem
    need_parent = [k for k in targets if not files[k].get("parentItem")]
    if need_parent:
        for k, d in _items_by_keys(prefix, key, need_parent).items():
            if k in files:
                files[k]["parentItem"] = d.get("parentItem")
    parent_of = {k: files[k].get("parentItem") for k in targets if files[k].get("parentItem")}
    parents = _items_by_keys(prefix, key, set(parent_of.values()))
    n = 0
    for k, pk in parent_of.items():
        pd = parents.get(pk)
        if pd is not None:
            files[k]["meta"] = _bib_from_parent(pd)
            n += 1
    return n


def sync(cfg: dict, limit: int = 0, full: bool = False) -> dict:
    key, prefix, webdav = _z(cfg["zotero"])
    pdf_dir: Path = cfg["pdf_dir"]
    pdf_dir.mkdir(parents=True, exist_ok=True)
    man_path: Path = cfg["manifest"]
    manifest = _load_manifest(man_path)
    files = manifest.setdefault("files", {})
    since = "0" if full else manifest.get("library_version", "0")

    known_md5 = {v.get("md5") for v in files.values() if v.get("md5")}

    pdfs, lib_version = _list_pdfs(key, prefix, since)
    if limit > 0:
        pdfs = pdfs[:limit]

    pulled, skipped, failed = [], [], []
    for p in pdfs:
        k, md5, fname = p["key"], p.get("md5"), p.get("filename")
        if k in files and os.path.exists(files[k].get("path", "")):
            skipped.append(k)
            continue
        if md5 and md5 in known_md5:  # 同篇被不同 key 重复添加 → 去重
            skipped.append(k)
            continue
        try:
            blob = _webdav_fetch(f"{webdav['url']}{k}.zip", webdav["user"], webdav["pw"])
            with zipfile.ZipFile(io.BytesIO(blob)) as z:
                inner = next((n for n in z.namelist() if n.lower().endswith(".pdf")), None)
                if inner is None:
                    raise ValueError("zip 内没有 PDF")
                pdf_bytes = z.read(inner)
            got = hashlib.md5(pdf_bytes).hexdigest()
            if md5 and got != md5:
                failed.append({"key": k, "why": f"md5 不符 期望{md5} 实得{got}"})
                continue
            dest = pdf_dir / _safe_name(fname, k)
            with open(dest, "wb") as f:
                f.write(pdf_bytes)
            files[k] = {"path": str(dest), "md5": got, "filename": fname,
                        "version": p.get("version"), "dateAdded": p.get("dateAdded"),
                        "parentItem": p.get("parentItem")}
            known_md5.add(got)
            pulled.append({"key": k, "path": str(dest), "bytes": len(pdf_bytes)})
        except Exception as e:  # noqa: BLE001
            failed.append({"key": k, "why": f"{type(e).__name__}: {e}"})

    try:
        enriched = enrich(cfg, files)
    except Exception as e:  # noqa: BLE001 — 补书目失败不应让同步失败
        enriched = 0
        failed.append({"key": "(enrich)", "why": f"{type(e).__name__}: {e}"})

    if lib_version:
        manifest["library_version"] = lib_version
    with open(man_path, "w") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    return {
        "pulled": len(pulled), "skipped": len(skipped), "failed": len(failed),
        "enriched": enriched,
        "library_version": manifest.get("library_version"),
        "total_in_cache": len(files),
        "pulled_files": pulled, "failures": failed,
    }


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--full", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()
    out = sync(config.load(), limit=a.limit, full=a.full)
    print(json.dumps(out, ensure_ascii=False, indent=2))
