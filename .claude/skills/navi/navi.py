"""navi.py — 把 ~/.navi（config + cache）镜像备份到 WebDAV。

子命令：
    sync    本地 → 远端（增量上传；--delete 删除远端多余文件，真镜像）
    pull    远端 → 本地（增量下载；--delete 删除本地多余文件）
    status  对比本地与远端，列出待传 / 待拉 / 已改动

WebDAV 凭证默认复用 [zotero] 的 webdav_user / webdav_password，URL 默认指向
alist 的 navi 目录；可在 [navi] 段覆盖。增量靠本地 manifest 记每个文件的 md5。
"""
import argparse
import fnmatch
import hashlib
import json
import os
import sys
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:  # py<3.11
    import tomli as tomllib  # type: ignore

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from webdav import WebDAV  # noqa: E402

CONFIG_PATH = Path("~/.navi/config.toml").expanduser()
NAVI_ROOT = Path("~/.navi").expanduser()
MANIFEST = NAVI_ROOT / ".navi-sync.json"
# 同步时跳过的本地相对路径模式（manifest 自身、日志、锁、缓存目录）
EXCLUDE = [".navi-sync.json", "*.log", "*.lock", "__pycache__/*", "*/__pycache__/*"]


def load_cfg() -> dict:
    if not CONFIG_PATH.exists():
        raise SystemExit(f"未找到 {CONFIG_PATH}。")
    with open(CONFIG_PATH, "rb") as f:
        data = tomllib.load(f)
    navi = data.get("navi") or {}
    url = navi.get("webdav_url")
    user = navi.get("webdav_user")
    pw = navi.get("webdav_password", "")
    if not url or not user:
        raise SystemExit("请在 [navi] 段填 webdav_url / webdav_user / webdav_password。")
    return {"url": url, "user": user, "pw": pw}


def _excluded(rel: str) -> bool:
    base = os.path.basename(rel)
    return any(fnmatch.fnmatch(rel, p) or fnmatch.fnmatch(base, p) for p in EXCLUDE)


def _md5(path: Path) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _local_files() -> dict:
    """回 {relpath: Path}，相对 ~/.navi，已剔除 EXCLUDE。"""
    out = {}
    for p in NAVI_ROOT.rglob("*"):
        if not p.is_file():
            continue
        rel = str(p.relative_to(NAVI_ROOT))
        if not _excluded(rel):
            out[rel] = p
    return out


def _load_manifest() -> dict:
    if MANIFEST.exists():
        with open(MANIFEST) as f:
            return json.load(f)
    return {}


def _save_manifest(man: dict):
    with open(MANIFEST, "w") as f:
        json.dump(man, f, ensure_ascii=False, indent=2, sort_keys=True)


def sync(cfg: dict, delete: bool = False, dry: bool = False) -> dict:
    dav = WebDAV(cfg["url"], cfg["user"], cfg["pw"])
    local, man = _local_files(), _load_manifest()
    uploaded, skipped, deleted, failed = [], 0, [], []
    for rel, path in sorted(local.items()):
        md5 = _md5(path)
        if man.get(rel) == md5:
            skipped += 1
            continue
        if dry:
            uploaded.append(rel)
            continue
        try:
            with open(path, "rb") as f:
                dav.put(rel, f.read())
            man[rel] = md5
            uploaded.append(rel)
        except Exception as e:  # noqa: BLE001
            failed.append({"rel": rel, "why": f"{type(e).__name__}: {e}"})
    if delete:  # 真镜像：删掉远端有、本地没有的
        for rel in sorted(set(dav.walk()) - set(local)):
            if dry:
                deleted.append(rel)
                continue
            dav.delete(rel)
            man.pop(rel, None)
            deleted.append(rel)
    if not dry:
        _save_manifest(man)
    return {"action": "sync", "dry_run": dry, "uploaded": len(uploaded), "skipped": skipped,
            "deleted": len(deleted), "failed": len(failed), "url": cfg["url"],
            "uploaded_files": uploaded, "deleted_files": deleted, "failures": failed}


def pull(cfg: dict, delete: bool = False, dry: bool = False) -> dict:
    dav = WebDAV(cfg["url"], cfg["user"], cfg["pw"])
    remote, local, man = dav.walk(), _local_files(), _load_manifest()
    downloaded, skipped, deleted, failed = [], 0, [], []
    for rel, size in sorted(remote.items()):
        if _excluded(rel):
            continue
        dest = NAVI_ROOT / rel
        if dest.exists() and dest.stat().st_size == size and rel in man:
            skipped += 1
            continue
        if dry:
            downloaded.append(rel)
            continue
        try:
            blob = dav.get(rel)
            dest.parent.mkdir(parents=True, exist_ok=True)
            with open(dest, "wb") as f:
                f.write(blob)
            man[rel] = hashlib.md5(blob).hexdigest()
            downloaded.append(rel)
        except Exception as e:  # noqa: BLE001
            failed.append({"rel": rel, "why": f"{type(e).__name__}: {e}"})
    if delete:  # 删掉本地有、远端没有的
        for rel in sorted(set(local) - set(remote)):
            if dry:
                deleted.append(rel)
                continue
            (NAVI_ROOT / rel).unlink(missing_ok=True)
            man.pop(rel, None)
            deleted.append(rel)
    if not dry:
        _save_manifest(man)
    return {"action": "pull", "dry_run": dry, "downloaded": len(downloaded), "skipped": skipped,
            "deleted": len(deleted), "failed": len(failed), "url": cfg["url"],
            "downloaded_files": downloaded, "deleted_files": deleted, "failures": failed}


def status(cfg: dict) -> dict:
    dav = WebDAV(cfg["url"], cfg["user"], cfg["pw"])
    remote, local, man = dav.walk(), _local_files(), _load_manifest()
    to_upload = [r for r, p in local.items() if man.get(r) != _md5(p)]
    to_download = [r for r in remote if not _excluded(r) and r not in local]
    only_remote = sorted(set(remote) - set(local))
    only_local = sorted(set(local) - set(remote))
    return {"action": "status", "url": cfg["url"], "local_files": len(local),
            "remote_files": len(remote), "to_upload": sorted(to_upload),
            "to_download": sorted(to_download), "only_local": only_local,
            "only_remote": only_remote}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["sync", "pull", "status"], nargs="?", default="sync")
    ap.add_argument("--delete", action="store_true", help="镜像模式：删除目标端多余文件")
    ap.add_argument("--dry-run", action="store_true", help="只预演不实际传输")
    a = ap.parse_args()
    conf = load_cfg()
    if a.cmd == "sync":
        result = sync(conf, delete=a.delete, dry=a.dry_run)
    elif a.cmd == "pull":
        result = pull(conf, delete=a.delete, dry=a.dry_run)
    else:
        result = status(conf)
    print(json.dumps(result, ensure_ascii=False, indent=2))
