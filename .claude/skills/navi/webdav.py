"""webdav.py — 极简 WebDAV 客户端（纯 stdlib），够 navi 备份用。

支持 PROPFIND 递归列目录、PUT 上传（自动建父目录）、GET 下载（跟随 alist 的
302 直链）、DELETE。凭证走 HTTP Basic，与 zotero_sync 同一套 WebDAV 账号。
"""
import base64
import urllib.error
import urllib.request
from urllib.parse import quote, unquote, urlparse
from xml.etree import ElementTree

_DAV = "{DAV:}"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None  # GET 时自己接管 302，先拿 Location 再无鉴权下载


_OPENER = urllib.request.build_opener(_NoRedirect)


class WebDAV:
    def __init__(self, base_url: str, user: str = "", password: str = ""):
        self.base = base_url.rstrip("/")
        self.base_path = urlparse(self.base).path.rstrip("/")
        self._auth = None
        if user:
            self._auth = "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()
        self._mkcol_done = set()  # 已建过的 collection，避免重复 MKCOL

    def _url(self, rel: str) -> str:
        rel = rel.strip("/")
        return self.base if not rel else self.base + "/" + quote(rel, safe="/")

    def _req(self, method: str, rel: str, data=None, headers=None, timeout=60):
        req = urllib.request.Request(self._url(rel), data=data, method=method)
        if self._auth:
            req.add_header("Authorization", self._auth)
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        return req

    def _rel_from_href(self, href: str) -> str:
        path = unquote(urlparse(href).path).rstrip("/")
        if path.startswith(self.base_path):
            path = path[len(self.base_path):]
        return path.strip("/")

    def _propfind(self, rel: str):
        """对单层目录 PROPFIND（Depth:1），回 [(relpath, is_dir, size)]，不含自身。"""
        req = self._req("PROPFIND", rel, headers={"Depth": "1"}, timeout=60)
        try:
            body = urllib.request.urlopen(req, timeout=60).read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return []
            raise
        self_rel = rel.strip("/")
        out = []
        root = ElementTree.fromstring(body)
        for resp in root.findall(f"{_DAV}response"):
            href = resp.findtext(f"{_DAV}href") or ""
            child = self._rel_from_href(href)
            if child == self_rel:
                continue
            props = resp.find(f"{_DAV}propstat/{_DAV}prop")
            is_dir = props is not None and props.find(f"{_DAV}resourcetype/{_DAV}collection") is not None
            size = int((props.findtext(f"{_DAV}getcontentlength") or 0) if props is not None else 0)
            out.append((child, is_dir, size))
        return out

    def walk(self) -> dict:
        """递归列远端，回 {relpath: size}（仅文件）。"""
        files, stack = {}, [""]
        while stack:
            for child, is_dir, size in self._propfind(stack.pop()):
                if is_dir:
                    stack.append(child)
                else:
                    files[child] = size
        return files

    def _mkcol_p(self, rel: str):
        """尽力建出 rel 的每层父目录。best-effort：对象存储后端（如 alist+OSS）
        目录是隐式的、MKCOL 会 409，直接吞掉——PUT 会隐式建路径，是真正的事实来源。
        标准 WebDAV 服务器上 MKCOL 则正常建目录。"""
        parts, acc = rel.strip("/").split("/"), ""
        for p in parts:
            if not p:
                continue
            acc = f"{acc}/{p}" if acc else p
            if acc in self._mkcol_done:
                continue
            try:
                urllib.request.urlopen(self._req("MKCOL", acc, timeout=60), timeout=60)
            except urllib.error.HTTPError:
                pass  # 已存在 / 隐式目录 / 不支持——交给 PUT
            self._mkcol_done.add(acc)

    def put(self, rel: str, data: bytes):
        parent = rel.rsplit("/", 1)[0] if "/" in rel else ""
        if parent:
            self._mkcol_p(parent)
        urllib.request.urlopen(self._req("PUT", rel, data=data, timeout=300), timeout=300)

    def get(self, rel: str) -> bytes:
        req = self._req("GET", rel, timeout=300)
        try:
            return _OPENER.open(req, timeout=300).read()
        except urllib.error.HTTPError as e:
            if e.code in (301, 302, 303, 307, 308):  # alist 多半 302 到 OSS 直链
                loc = e.headers.get("Location")
                if loc:
                    return urllib.request.urlopen(loc, timeout=300).read()
            raise

    def delete(self, rel: str):
        try:
            urllib.request.urlopen(self._req("DELETE", rel, timeout=60), timeout=60)
        except urllib.error.HTTPError as e:
            if e.code != 404:
                raise
