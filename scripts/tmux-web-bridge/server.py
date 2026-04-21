#!/usr/bin/env python3
"""
tmux-web-bridge — server (relay).

This process holds no tmux state. Two WebSocket endpoints:

  /agent   — agents (one per tmux machine) connect outbound here. They
             advertise panes, stream snapshots for panes a browser asked to
             see, and execute send-keys on demand.
  /ws      — browsers connect here. They see the merged pane list from all
             agents and can subscribe to / send keys to any pane.

Panes are namespaced `<host>/<pane_id>` on the browser side so multiple
agents never collide.

Usage:
    python server.py [--host 0.0.0.0] [--port 8787] [--token <shared>]
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import logging
import os
import signal
import sys
import unicodedata
from pathlib import Path

import pyte
from aiohttp import WSMsgType, web

# pyte flag bitmap sent to the browser.
FLAG_BOLD = 1
FLAG_ITALIC = 2
FLAG_UNDERSCORE = 4
FLAG_REVERSE = 8
FLAG_STRIKE = 16


def _char_width(ch: str) -> int:
    """Cells occupied by a single character (0, 1, or 2)."""
    if not ch:
        return 1
    # Combining marks have no advance.
    if unicodedata.category(ch).startswith("M"):
        return 0
    ea = unicodedata.east_asian_width(ch)
    return 2 if ea in ("W", "F") else 1


def render_grid(ansi_bytes: bytes, cols: int, rows: int) -> list[list[list]]:
    """Parse ANSI bytes through pyte and return a grid of positioned runs.

    Each row is a list of runs:
        [col_start, text, fg|None, bg|None, flags_int, width_per_char]

    `width_per_char` is 1 for normal, 2 for CJK/wide characters. The browser
    draws each run starting at `col_start * cellW`, which bypasses any
    font-width quirks.
    """
    cols = max(1, min(cols, 500))
    rows = max(1, min(rows, 500))
    screen = pyte.Screen(cols, rows)
    # LNM on: treat bare LF like CRLF so capture-pane output (one \n per row)
    # lands at column 0 of the next row instead of trailing the previous line.
    screen.set_mode(pyte.modes.LNM)
    stream = pyte.ByteStream(screen)
    stream.feed(b"\x1b[H\x1b[2J")
    # Strip trailing newlines — capture-pane appends a \n after the last row,
    # which with LNM would move the cursor past the final row and scroll row 0
    # off the top of the pyte buffer (losing the oldest history line).
    ansi_bytes = ansi_bytes.rstrip(b"\n")
    try:
        stream.feed(ansi_bytes)
    except Exception:
        pass

    def attrs_of(c) -> tuple:
        fg = None if c.fg == "default" else c.fg
        bg = None if c.bg == "default" else c.bg
        flags = 0
        if c.bold:          flags |= FLAG_BOLD
        if c.italics:       flags |= FLAG_ITALIC
        if c.underscore:    flags |= FLAG_UNDERSCORE
        if c.reverse:       flags |= FLAG_REVERSE
        if c.strikethrough: flags |= FLAG_STRIKE
        return (fg, bg, flags)

    def is_blank(c) -> bool:
        return (c.data == " " or c.data == ""
                ) and c.bg == "default" and not c.reverse

    lines: list[list[list]] = []
    for y in range(rows):
        row = screen.buffer[y]
        runs: list[list] = []
        x = 0
        while x < cols:
            c = row[x]
            w = _char_width(c.data)
            if w == 0:
                # Combining mark with no pyte cell of its own — skip.
                x += 1
                continue
            if w == 2:
                # Wide char: emit as its own run; pyte leaves x+1 as a
                # continuation cell (data==""), skip past it.
                if not is_blank(c):
                    fg, bg, flags = attrs_of(c)
                    runs.append([x, c.data, fg, bg, flags, 2])
                x += 2
                continue
            # Narrow char: coalesce with following same-attrs narrow cells,
            # skipping over stretches of default blanks so we don't ship
            # trailing whitespace.
            if is_blank(c):
                x += 1
                continue
            fg, bg, flags = attrs_of(c)
            start = x
            chars = [c.data]
            x += 1
            while x < cols:
                nxt = row[x]
                if _char_width(nxt.data) != 1:
                    break
                if attrs_of(nxt) != (fg, bg, flags):
                    break
                if is_blank(nxt):
                    # Look ahead: only stop if run of blanks is >= 2 cells,
                    # else keep them as padding within this run.
                    if x + 1 < cols and is_blank(row[x + 1]):
                        break
                chars.append(nxt.data)
                x += 1
            runs.append([start, "".join(chars), fg, bg, flags, 1])
        lines.append(runs)
    return lines

WEB_DIR = Path(__file__).parent / "web"
log = logging.getLogger("tmux-bridge")


class AgentConn:
    """Server-side state for a single connected agent."""

    def __init__(self, ws: web.WebSocketResponse, host: str):
        self.ws = ws
        self.host = host                       # display label
        self.panes: dict[str, dict] = {}       # pane_id -> info (local to host)
        # Browsers subscribed to one of this agent's panes, keyed by pane_id.
        self.subscribers: dict[str, set[web.WebSocketResponse]] = {}
        # req_id -> browser ws awaiting a spawn_result from this agent.
        self.pending_spawns: dict[str, web.WebSocketResponse] = {}

    def key(self, pane_id: str) -> str:
        return f"{self.host}/{pane_id}"

    async def tell(self, msg: dict) -> None:
        try:
            await self.ws.send_str(json.dumps(msg))
        except Exception:
            pass


class Hub:
    def __init__(self, token: str):
        self.token = token
        self.agents: dict[str, AgentConn] = {}  # conn_id -> AgentConn
        self.browsers: set[web.WebSocketResponse] = set()
        self._conn_seq = 0

    # ── helpers ─────────────────────────────────────────────

    def _next_id(self) -> str:
        self._conn_seq += 1
        return f"c{self._conn_seq}"

    def _uniq_host(self, wanted: str) -> str:
        """Ensure the display host label is unique across agents."""
        if not any(a.host == wanted for a in self.agents.values()):
            return wanted
        i = 2
        while any(a.host == f"{wanted}#{i}" for a in self.agents.values()):
            i += 1
        return f"{wanted}#{i}"

    def _panes_snapshot(self) -> list[dict]:
        """Merged pane list as browsers see it — with namespaced keys."""
        out: list[dict] = []
        for agent in self.agents.values():
            for pane_id, info in agent.panes.items():
                e = dict(info)
                e["key"] = agent.key(pane_id)
                e["host"] = agent.host
                out.append(e)
        return out

    def _find(self, key: str) -> tuple[AgentConn, str] | None:
        host, _, pane_id = key.partition("/")
        if not host or not pane_id:
            return None
        # Don't require pane to be in agent.panes — a freshly-spawned pane
        # may not yet have appeared in the agent's scan. The agent itself
        # guards with its own tmux check before subscribing.
        for agent in self.agents.values():
            if agent.host == host:
                return agent, pane_id
        return None

    async def _broadcast_browsers(self) -> None:
        msg = json.dumps({"type": "panes", "panes": self._panes_snapshot()})
        for ws in list(self.browsers):
            try:
                await ws.send_str(msg)
            except Exception:
                self.browsers.discard(ws)

    # ── agent endpoint ──────────────────────────────────────

    async def handle_agent(self, ws: web.WebSocketResponse) -> None:
        # First message must be `hello` with token.
        try:
            first = await asyncio.wait_for(ws.receive(), timeout=10)
        except asyncio.TimeoutError:
            await ws.close(code=4001, message=b"no hello")
            return
        if first.type != WSMsgType.TEXT:
            return
        try:
            hello = json.loads(first.data)
        except Exception:
            return
        if hello.get("type") != "hello" or hello.get("token", "") != self.token:
            await ws.send_str(json.dumps({"type": "error", "msg": "auth failed"}))
            await ws.close(code=4003, message=b"auth")
            return
        host = self._uniq_host(str(hello.get("host", "unknown")))
        conn_id = self._next_id()
        agent = AgentConn(ws, host)
        self.agents[conn_id] = agent
        log.info("agent %s connected as host=%s", conn_id, host)
        await self._broadcast_browsers()

        try:
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                try:
                    m = json.loads(msg.data)
                except Exception:
                    continue
                t = m.get("type")
                if t == "panes":
                    found = {p["pane"]: p for p in m.get("panes", []) if p.get("pane")}
                    agent.panes = found
                    # Drop subscriptions for panes that vanished; tell any
                    # browser that was viewing them so it clears its UI.
                    for pid in list(agent.subscribers.keys()):
                        if pid not in found:
                            for bws in list(agent.subscribers[pid]):
                                try:
                                    await bws.send_str(json.dumps({
                                        "type": "gone", "key": agent.key(pid),
                                    }))
                                except Exception:
                                    pass
                            agent.subscribers.pop(pid, None)
                    await self._broadcast_browsers()
                elif t == "snapshot":
                    pane = m.get("pane")
                    subs = agent.subscribers.get(pane, set())
                    if not subs:
                        continue
                    cols = int(m.get("cols") or 80)
                    rows = int(m.get("rows") or 24)
                    try:
                        raw = base64.b64decode(m.get("data", ""))
                    except Exception:
                        raw = b""
                    lines = render_grid(raw, cols, rows)
                    fwd = json.dumps({
                        "type": "grid",
                        "key": agent.key(pane),
                        "cols": cols,
                        "rows": rows,
                        "lines": lines,
                        "scroll_position": m.get("scroll_position", 0),
                        "in_copy_mode": bool(m.get("in_copy_mode", False)),
                    })
                    for bws in list(subs):
                        try:
                            await bws.send_str(fwd)
                        except Exception:
                            subs.discard(bws)
                elif t == "spawn_result":
                    req_id = m.get("req_id")
                    target = agent.pending_spawns.pop(req_id, None) if req_id else None
                    if target is not None:
                        try:
                            await target.send_str(json.dumps({
                                "type": "spawn_result",
                                "req_id": req_id,
                                "host": agent.host,
                                "ok": bool(m.get("ok")),
                                "info": m.get("info", ""),
                                "cwd": m.get("cwd", ""),
                            }))
                        except Exception:
                            pass
        finally:
            log.info("agent %s disconnected (host=%s)", conn_id, host)
            self.agents.pop(conn_id, None)
            await self._broadcast_browsers()

    # ── browser endpoint ────────────────────────────────────

    async def handle_browser(self, ws: web.WebSocketResponse) -> None:
        self.browsers.add(ws)
        log.info("browser connected")
        # (agent, pane_id) this ws is currently subscribed to, or None
        subscribed: tuple[AgentConn, str] | None = None

        async def do_unsubscribe() -> None:
            nonlocal subscribed
            if subscribed is None:
                return
            agent, pane_id = subscribed
            subs = agent.subscribers.get(pane_id)
            if subs is not None:
                subs.discard(ws)
                if not subs:
                    agent.subscribers.pop(pane_id, None)
                    await agent.tell({"type": "unsubscribe", "pane": pane_id})
            subscribed = None

        try:
            await ws.send_str(json.dumps({
                "type": "panes", "panes": self._panes_snapshot(),
            }))
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                try:
                    m = json.loads(msg.data)
                except Exception:
                    continue
                t = m.get("type")

                if t == "subscribe":
                    key = m.get("key")
                    hit = self._find(key) if key else None
                    if hit is None:
                        await ws.send_str(json.dumps({
                            "type": "error", "msg": f"unknown pane {key}",
                        }))
                        continue
                    await do_unsubscribe()
                    agent, pane_id = hit
                    agent.subscribers.setdefault(pane_id, set()).add(ws)
                    subscribed = (agent, pane_id)
                    await agent.tell({"type": "subscribe", "pane": pane_id})

                elif t == "unsubscribe":
                    await do_unsubscribe()

                elif t == "send_keys":
                    key = m.get("key")
                    hit = self._find(key) if key else None
                    if hit is None:
                        continue
                    agent, pane_id = hit
                    fwd: dict = {"type": "send_keys", "pane": pane_id}
                    if isinstance(m.get("keys"), list):
                        fwd["keys"] = [str(k) for k in m["keys"] if isinstance(k, str)]
                    else:
                        fwd["text"] = m.get("text", "")
                        fwd["enter"] = bool(m.get("enter", True))
                    await agent.tell(fwd)

                elif t == "kill":
                    key = m.get("key")
                    hit = self._find(key) if key else None
                    if hit is None:
                        continue
                    agent, pane_id = hit
                    await agent.tell({"type": "kill", "pane": pane_id})

                elif t == "scroll":
                    key = m.get("key")
                    hit = self._find(key) if key else None
                    if hit is None:
                        continue
                    agent, pane_id = hit
                    action = m.get("action")
                    if action not in ("up", "down", "page_up", "page_down", "exit"):
                        continue
                    await agent.tell({
                        "type": "scroll", "pane": pane_id, "action": action,
                    })

                elif t == "resize":
                    key = m.get("key")
                    hit = self._find(key) if key else None
                    if hit is None:
                        continue
                    agent, pane_id = hit
                    try:
                        cols = int(m.get("cols") or 0)
                        rows = int(m.get("rows") or 0)
                    except (TypeError, ValueError):
                        continue
                    if cols < 20 or rows < 5 or cols > 500 or rows > 500:
                        continue
                    await agent.tell({
                        "type": "resize", "pane": pane_id,
                        "cols": cols, "rows": rows,
                    })


                elif t == "spawn":
                    host   = m.get("host") or ""
                    cwd    = m.get("cwd") or ""
                    window = m.get("window") or m.get("session") or ""
                    req_id = str(m.get("req_id") or "")
                    target = next(
                        (a for a in self.agents.values() if a.host == host),
                        None,
                    )
                    if target is None:
                        await ws.send_str(json.dumps({
                            "type": "spawn_result",
                            "req_id": req_id,
                            "ok": False,
                            "host": host,
                            "info": f"no agent for host {host!r}",
                            "cwd": cwd,
                        }))
                        continue
                    if req_id:
                        target.pending_spawns[req_id] = ws
                    await target.tell({
                        "type": "spawn",
                        "req_id": req_id,
                        "cwd": cwd,
                        "window": window,
                    })

                elif t == "list":
                    await ws.send_str(json.dumps({
                        "type": "panes", "panes": self._panes_snapshot(),
                    }))
        finally:
            await do_unsubscribe()
            self.browsers.discard(ws)
            log.info("browser disconnected")


def make_app(hub: Hub) -> web.Application:
    app = web.Application()

    async def agent_handler(request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(heartbeat=30, max_msg_size=16 * 1024 * 1024)
        await ws.prepare(request)
        await hub.handle_agent(ws)
        return ws

    async def browser_handler(request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(heartbeat=30)
        await ws.prepare(request)
        await hub.handle_browser(ws)
        return ws

    async def index(request: web.Request) -> web.FileResponse:
        return web.FileResponse(
            WEB_DIR / "index.html",
            headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
        )

    @web.middleware
    async def no_cache(request: web.Request, handler):
        resp = await handler(request)
        if request.path.startswith("/static/"):
            resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        return resp

    async def appjs(request: web.Request) -> web.FileResponse:
        return web.FileResponse(
            WEB_DIR / "app.js",
            headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
        )

    app.middlewares.append(no_cache)
    app.router.add_get("/", index)
    app.router.add_get("/app.js", appjs)
    app.router.add_get("/agent", agent_handler)
    app.router.add_get("/ws", browser_handler)
    app.router.add_static("/static/", WEB_DIR)
    return app


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="0.0.0.0",
                    help="bind address (default: 0.0.0.0 so agents on other "
                         "hosts can reach it)")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--token", default=os.environ.get("BRIDGE_TOKEN", ""),
                    help="shared secret the agent must present "
                         "(or BRIDGE_TOKEN env)")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    if not args.token:
        log.warning("no --token set; agents will connect with empty token. "
                    "Do NOT expose this to an untrusted network.")

    hub = Hub(token=args.token)
    app = make_app(hub)

    async def close_all_ws(app_: web.Application) -> None:
        # Force-close every open WS so AppRunner.cleanup() doesn't block on
        # idle connections waiting for the 30 s heartbeat to time out.
        sockets: list[web.WebSocketResponse] = []
        sockets.extend(list(hub.browsers))
        sockets.extend(a.ws for a in hub.agents.values())
        await asyncio.gather(
            *(ws.close(code=1001, message=b"server shutdown") for ws in sockets),
            return_exceptions=True,
        )

    app.on_shutdown.append(close_all_ws)

    runner = web.AppRunner(app, shutdown_timeout=1.0)
    await runner.setup()
    site = web.TCPSite(runner, args.host, args.port)
    await site.start()

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()

    def _on_signal() -> None:
        if stop.is_set():
            # Second Ctrl+C — give up waiting and exit hard.
            log.warning("second signal, exiting now")
            os._exit(130)
        stop.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, _on_signal)

    log.info("listening on http://%s:%d", args.host, args.port)
    log.info("  browser UI:  /   (+ WS /ws)")
    log.info("  agent WS:    /agent")

    try:
        await stop.wait()
    finally:
        log.info("shutting down")
        try:
            await asyncio.wait_for(runner.cleanup(), timeout=3.0)
        except asyncio.TimeoutError:
            log.warning("cleanup timed out")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
