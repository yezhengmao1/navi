#!/usr/bin/env python3
"""
tmux-web-bridge — agent.

Runs on the machine that owns tmux. Connects outbound (WebSocket) to a central
server, then, on the server's behalf:
  - reads /tmp/claude-status/ to discover Claude panes,
  - polls `tmux capture-pane` for panes the server asks it to watch,
  - forwards keystrokes from the server into panes via `tmux send-keys`.

Usage:
    python agent.py --server ws://server-host:8787/agent \
                    --token   <shared-secret> \
                    [--host   alice-laptop]      # label; defaults to hostname
                    [--poll-hz 5] [-v]
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import logging
import os
import re
import shutil
import signal
import socket
import sys
import time
from pathlib import Path

import aiohttp

STATUS_DIR = Path("/tmp/claude-status")
log = logging.getLogger("tmux-agent")


async def tmux(*args: str) -> tuple[int, bytes, bytes]:
    proc = await asyncio.create_subprocess_exec(
        "tmux", *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate()
    return (proc.returncode or 0), out, err


# Per-file last-good parse, so a transient read/JSON error doesn't make a
# pane vanish from the sidebar. Keyed by status-file path.
_OVERLAY_CACHE: dict[str, tuple[float, dict]] = {}


def _read_status_overlay() -> dict[str, dict]:
    """Map of pane_id -> claude-status fields, for panes that wrote a hook file."""
    if not STATUS_DIR.exists():
        return {}
    overlay: dict[str, dict] = {}
    live_keys: set[str] = set()
    for f in STATUS_DIR.iterdir():
        if not f.is_file():
            continue
        key = str(f)
        live_keys.add(key)
        try:
            st = f.stat()
            mtime = st.st_mtime
        except OSError:
            continue
        cached = _OVERLAY_CACHE.get(key)
        d: dict | None = None
        if cached is not None and cached[0] == mtime:
            d = cached[1]
        else:
            try:
                d = json.loads(f.read_text())
                _OVERLAY_CACHE[key] = (mtime, d)
            except Exception:
                # Fall back to the last good parse so a pane mid-rewrite or
                # a transiently-malformed file doesn't drop the sidebar row.
                if cached is not None:
                    d = cached[1]
        if not d:
            continue
        pane = d.get("pane") or ""
        if not pane:
            continue
        overlay[pane] = {
            "session_id": f.name,
            "state": d.get("state", ""),
            "detail": d.get("detail", ""),
            "timestamp": d.get("timestamp", ""),
        }
    # Drop cache entries for files that have gone away.
    for stale in list(_OVERLAY_CACHE.keys()):
        if stale not in live_keys:
            _OVERLAY_CACHE.pop(stale, None)
    return overlay


async def list_all_panes() -> tuple[dict[str, dict], set[str]]:
    """Return (claude-panes-with-overlay, all-tmux-pane-ids).

    The overlay-filtered dict drives the sidebar. The raw pane-id set is
    what the scan loop uses to decide whether a poller should be cancelled;
    keying that off the overlay alone caused pollers to die whenever a
    status-hook file was mid-rewrite (brief JSON parse failure → pane
    missing from overlay → poller cancelled before its first snapshot).
    """
    code, out, _ = await tmux(
        "list-panes", "-a", "-F",
        "#{pane_id}\t#{session_name}\t#{window_index}\t#{window_name}\t"
        "#{pane_current_path}\t#{pane_current_command}",
    )
    if code != 0:
        return {}, set()
    overlay = _read_status_overlay()
    result: dict[str, dict] = {}
    all_pids: set[str] = set()
    for line in out.decode(errors="replace").splitlines():
        parts = line.split("\t")
        if len(parts) < 6:
            continue
        pid, sess, widx, wname, cwd, cmd = parts[:6]
        all_pids.add(pid)
        ov = overlay.get(pid)
        # Only surface claude panes — those with a matching status-hook file.
        if ov is None:
            continue
        result[pid] = {
            "pane": pid,
            "session_id": ov["session_id"],
            "cwd": cwd,
            "state": ov["state"],
            "detail": ov["detail"],
            "timestamp": ov["timestamp"],
            "session_name": sess,
            "window_index": widx,
            "window_name": wname,
        }
    return result, all_pids


async def pane_info(pane_id: str) -> tuple[int, int, int, bool] | None:
    """Returns (cols, rows, scroll_position, in_copy_mode).
    scroll_position is the number of lines scrolled back from the bottom
    (0 = live view). copy-mode is the source of scroll_position; outside
    copy-mode it's 0.
    """
    code, out, _ = await tmux(
        "display-message", "-p", "-t", pane_id,
        "#{pane_width}\t#{pane_height}\t#{scroll_position}\t#{pane_in_mode}",
    )
    if code != 0:
        return None
    try:
        parts = out.decode().strip().split("\t")
        w, h = int(parts[0]), int(parts[1])
        sp = int(parts[2]) if parts[2] else 0
        in_mode = parts[3] == "1"
        return w, h, sp, in_mode
    except Exception:
        return None


async def capture_pane(pane_id: str, height: int, scroll_pos: int) -> bytes:
    """Capture the pane viewport, adjusted for copy-mode scroll offset.
    When scroll_pos=0 this is the live visible screen. When scrolled back
    by S lines, the viewport shows rows [-S .. height-1-S] of the buffer
    (negative = scrollback).
    """
    if scroll_pos <= 0:
        args = ["capture-pane", "-p", "-e", "-t", pane_id]
    else:
        start = -scroll_pos
        end = height - 1 - scroll_pos
        args = [
            "capture-pane", "-p", "-e", "-t", pane_id,
            "-S", str(start), "-E", str(end),
        ]
    code, out, _ = await tmux(*args)
    return out if code == 0 else b""


async def send_keys(pane_id: str, text: str, enter: bool = True) -> None:
    if text:
        await tmux("send-keys", "-t", pane_id, "-l", text)
    if enter:
        await tmux("send-keys", "-t", pane_id, "Enter")


# Allow only tmux's well-known key names from the UI buttons.
_NAMED_KEYS = {
    "Up", "Down", "Left", "Right",
    "Enter", "Escape", "Tab", "BTab", "Space", "BSpace",
    "Home", "End", "PageUp", "PageDown",
    "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
    # Common ctrl combos Claude TUI cares about.
    "C-c", "C-d", "C-l", "C-o", "C-r",
    # Literal punctuation exposed via UI buttons.
    "/",
}


async def send_named_keys(pane_id: str, names: list[str]) -> None:
    for name in names:
        if isinstance(name, str) and name in _NAMED_KEYS:
            await tmux("send-keys", "-t", pane_id, name)


async def _in_copy_mode(pane_id: str) -> bool:
    code, out, _ = await tmux(
        "display-message", "-p", "-t", pane_id, "#{pane_in_mode}",
    )
    if code != 0:
        return False
    return out.decode(errors="replace").strip() == "1"


async def scroll_pane(pane_id: str, action: str) -> None:
    """Drive tmux copy-mode so the visible area reveals scrollback. The next
    capture-pane poll will reflect the new viewport."""
    if action == "exit":
        if await _in_copy_mode(pane_id):
            await tmux("send-keys", "-t", pane_id, "-X", "cancel")
        return
    if not await _in_copy_mode(pane_id):
        if action in ("up", "page_up"):
            await tmux("copy-mode", "-t", pane_id)
        else:
            return
    # If we're in copy-mode already at the bottom (scroll_position == 0), any
    # further "down" scroll just wastes a round-trip — exit copy-mode instead
    # so the viewport snaps back to the live pane.
    if action in ("down", "page_down"):
        info = await pane_info(pane_id)
        if info is not None:
            _, _, sp, in_mode = info
            if in_mode and sp <= 0:
                await tmux("send-keys", "-t", pane_id, "-X", "cancel")
                return
    cmd = {
        "up":        "scroll-up",
        "down":      "scroll-down",
        "page_up":   "page-up",
        "page_down": "page-down",
    }.get(action)
    if not cmd:
        return
    await tmux("send-keys", "-t", pane_id, "-X", cmd)


_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")


CC_SESSION = "cc"


async def spawn_claude_session(
    cwd: str,
    window_name: str = "",
) -> tuple[bool, str]:
    """Create a new window inside the `cc` session (creating the session if
    needed), then launch `claude` inside it. A shell starts first so the
    window survives even if `claude` exits immediately."""
    cwd = os.path.expanduser(cwd or "")
    if not cwd or not os.path.isdir(cwd):
        return False, f"cwd not a directory: {cwd!r}"
    base = _SAFE_NAME.sub("-", os.path.basename(cwd.rstrip("/")) or "claude")[:32] or "claude"
    requested = _SAFE_NAME.sub("-", (window_name or "").strip())[:48]
    wname = requested or base

    # Detached sessions have no attached client, so without `window-size
    # manual` tmux falls back to `default-size` (80x24) — capture-pane then
    # returns a tiny blank grid and the browser sees an empty canvas until
    # the user hits Fit. Force manual sizing + a roomy initial size so the
    # first snapshot has real content.
    INIT_COLS, INIT_ROWS = 200, 50

    # Default history-limit (2000) is too small for long Claude sessions —
    # scrollback gets evicted before the browser ever sees it. Panes capture
    # the value at creation time, so bump the global default BEFORE we create
    # any new session/window.
    await tmux("set-option", "-g", "history-limit", "50000")

    has_code, _, _ = await tmux("has-session", "-t", CC_SESSION)
    if has_code != 0:
        code, _, err = await tmux(
            "new-session", "-d", "-s", CC_SESSION, "-n", wname, "-c", cwd,
            "-x", str(INIT_COLS), "-y", str(INIT_ROWS),
        )
        if code != 0:
            return False, err.decode(errors="replace").strip() or f"tmux exited {code}"
        await tmux("set-option", "-t", CC_SESSION, "window-size", "manual")
    else:
        code, _, err = await tmux(
            "new-window", "-t", f"{CC_SESSION}:", "-n", wname, "-c", cwd,
        )
        if code != 0:
            return False, err.decode(errors="replace").strip() or f"tmux exited {code}"

    target = f"{CC_SESSION}:{wname}.0"
    # Even on new-window path, make sure this specific window is sized —
    # otherwise it inherits whatever the session currently thinks (which may
    # be 80x24 if no client ever attached).
    await tmux(
        "resize-window", "-t", target,
        "-x", str(INIT_COLS), "-y", str(INIT_ROWS),
    )
    await tmux("send-keys", "-t", target, "-l", "claude")
    await tmux("send-keys", "-t", target, "Enter")
    return True, f"{CC_SESSION}:{wname}"


class Agent:
    def __init__(self, server_url: str, token: str, host: str, poll_period: float):
        self.server_url = server_url
        self.token = token
        self.host = host
        self.poll_period = poll_period
        self.panes: dict[str, dict] = {}
        self.ws: aiohttp.ClientWebSocketResponse | None = None
        self.pollers: dict[str, asyncio.Task] = {}  # pane_id -> task
        self.scroll_nudges: dict[str, asyncio.Event] = {}  # pane_id -> wake-poll event
        # When set, _scan_loop uses a faster cadence for a short burst
        # (useful right after spawning a new session so it shows up quickly
        # instead of waiting for the next 2 s tick).
        self.fast_scan_until: float = 0.0

    async def run(self, stop: asyncio.Event) -> None:
        backoff = 1.0
        while not stop.is_set():
            t0 = asyncio.get_event_loop().time()
            failure_reason: str | None = None
            try:
                failure_reason = await self._session()
            except Exception as e:
                failure_reason = f"{type(e).__name__}: {e}"

            # Reset backoff only if the session was genuinely long-lived
            # (>= 30 s of healthy operation). A session that ends immediately
            # — auth failure, handshake problem — must keep backing off to
            # avoid a reconnect storm.
            if asyncio.get_event_loop().time() - t0 >= 30.0:
                backoff = 1.0

            if stop.is_set():
                return
            log.warning("disconnected (%s); retrying in %.1fs",
                        failure_reason or "clean close", backoff)
            try:
                await asyncio.wait_for(stop.wait(), timeout=backoff)
                return
            except asyncio.TimeoutError:
                pass
            backoff = min(backoff * 2, 30.0)

    async def _session(self) -> str | None:
        """Run one WS session. Returns a failure reason string, or None on clean close."""
        try:
            async with aiohttp.ClientSession() as sess:
                async with sess.ws_connect(self.server_url, heartbeat=20) as ws:
                    self.ws = ws
                    log.info("connected to %s as host=%s", self.server_url, self.host)
                    await ws.send_str(json.dumps({
                        "type": "hello",
                        "host": self.host,
                        "token": self.token,
                    }))
                    scan_task = asyncio.create_task(self._scan_loop())
                    reason: str | None = None
                    try:
                        async for msg in ws:
                            if msg.type == aiohttp.WSMsgType.TEXT:
                                try:
                                    parsed = json.loads(msg.data)
                                except Exception:
                                    continue
                                if parsed.get("type") == "error":
                                    reason = f"server rejected us: {parsed.get('msg')}"
                                    log.error(reason)
                                    break
                                await self._dispatch(parsed)
                            elif msg.type == aiohttp.WSMsgType.CLOSE:
                                reason = f"server closed: code={ws.close_code}"
                                break
                            elif msg.type == aiohttp.WSMsgType.ERROR:
                                reason = f"ws error: {ws.exception()}"
                                break
                    finally:
                        scan_task.cancel()
                        for t in list(self.pollers.values()):
                            t.cancel()
                        self.pollers.clear()
                        self.scroll_nudges.clear()
                        self.ws = None
                    return reason
        except aiohttp.ClientError as e:
            return f"client error: {e}"

    async def _dispatch(self, msg: dict) -> None:
        t = msg.get("type")
        if t == "subscribe":
            pane = msg.get("pane")
            if pane and pane not in self.pollers:
                self.scroll_nudges[pane] = asyncio.Event()
                self.pollers[pane] = asyncio.create_task(self._poll(pane))
        elif t == "unsubscribe":
            pane = msg.get("pane")
            task = self.pollers.pop(pane, None)
            self.scroll_nudges.pop(pane, None)
            if task:
                task.cancel()
        elif t == "send_keys":
            pane = msg.get("pane")
            if pane not in self.panes:
                return
            # Keystrokes to the running app don't reach it while tmux is in
            # copy-mode — drop out first, so the user can scroll back, then
            # type without having to hit Escape manually.
            if await _in_copy_mode(pane):
                await tmux("send-keys", "-t", pane, "-X", "cancel")
            keys = msg.get("keys")
            if isinstance(keys, list) and keys:
                await send_named_keys(pane, keys)
                return
            text = msg.get("text", "")
            enter = bool(msg.get("enter", True))
            if isinstance(text, str):
                await send_keys(pane, text, enter)
        elif t == "resize":
            pane = msg.get("pane")
            try:
                cols = int(msg.get("cols") or 0)
                rows = int(msg.get("rows") or 0)
            except (TypeError, ValueError):
                return
            if not pane or cols < 20 or rows < 5:
                return
            # Need both the session (to flip window-size policy) and the
            # window target (to resize it explicitly).
            code, out, _ = await tmux(
                "display-message", "-p", "-t", pane,
                "#{session_id}\t#{session_name}:#{window_index}",
            )
            if code != 0:
                log.warning("resize: display-message failed for pane=%s", pane)
                return
            parts = out.decode(errors="replace").strip().split("\t", 1)
            if len(parts) != 2:
                return
            sess_id, target = parts
            # Without this, tmux sizes the window to whatever the smallest
            # attached client is — or to default-size (often 80x24) when no
            # client is attached. `manual` unlocks explicit sizing.
            await tmux("set-option", "-t", sess_id, "window-size", "manual")
            code, _, err = await tmux(
                "resize-window", "-t", target,
                "-x", str(cols), "-y", str(rows),
            )
            if code != 0:
                log.warning("resize-window failed (%s): %s",
                            target, err.decode(errors="replace").strip())
                return
            # Also resize the pane itself — if the window has a split layout,
            # resize-window only grows the envelope; resize-pane makes this
            # specific pane fill it.
            await tmux("resize-pane", "-t", pane,
                       "-x", str(cols), "-y", str(rows))
            log.info("resized pane=%s to %dx%d (target=%s)",
                     pane, cols, rows, target)
        elif t == "spawn":
            cwd = msg.get("cwd", "")
            window = msg.get("window") or msg.get("session") or ""
            req_id = msg.get("req_id")
            ok, info = await spawn_claude_session(cwd, window)
            if ok:
                # Keep scanning at 250 ms for the next 20 s so the new session's
                # first SessionStart status write is picked up quickly.
                self.fast_scan_until = asyncio.get_event_loop().time() + 20.0
            if self.ws is not None:
                await self.ws.send_str(json.dumps({
                    "type": "spawn_result",
                    "req_id": req_id,
                    "ok": ok,
                    "info": info,
                    "cwd": cwd,
                }))
        elif t == "scroll":
            pane = msg.get("pane")
            action = msg.get("action")
            if pane and isinstance(action, str):
                await scroll_pane(pane, action)
                # Force the next poll iteration to run immediately instead of
                # waiting out the remaining poll_period. Capture-pane's output
                # changes even though only the viewport (not the buffer) moved.
                ev = self.scroll_nudges.get(pane)
                if ev is not None:
                    ev.set()
        elif t == "kill":
            pane = msg.get("pane")
            if not pane:
                return
            code, _, err = await tmux("kill-window", "-t", pane)
            if code != 0:
                log.warning(
                    "kill-window failed pane=%s: %s",
                    pane, err.decode(errors="replace").strip(),
                )
                return
            self.fast_scan_until = asyncio.get_event_loop().time() + 5.0
        elif t == "ping":
            if self.ws is not None:
                await self.ws.send_str(json.dumps({"type": "pong"}))

    async def _scan_loop(self) -> None:
        try:
            while True:
                found, all_pids = await list_all_panes()
                if found != self.panes:
                    self.panes = found
                    if self.ws is not None:
                        await self.ws.send_str(json.dumps({
                            "type": "panes",
                            "panes": list(found.values()),
                        }))
                # Only cancel pollers for panes tmux no longer knows about —
                # a pane missing from `found` (but present in `all_pids`) is
                # just a status-file hiccup, not a dead pane.
                for pid in list(self.pollers.keys()):
                    if pid not in all_pids:
                        self.pollers[pid].cancel()
                        self.pollers.pop(pid, None)
                        self.scroll_nudges.pop(pid, None)
                now = asyncio.get_event_loop().time()
                delay = 0.25 if now < self.fast_scan_until else 2.0
                await asyncio.sleep(delay)
        except asyncio.CancelledError:
            return

    async def _poll(self, pane_id: str) -> None:
        last: bytes | None = None
        last_state: tuple[int, int, int, bool] | None = None
        first = True
        empty_streak = 0
        try:
            while True:
                info = await pane_info(pane_id)
                if info is None:
                    cols, rows, sp, in_mode = 200, 60, 0, False
                else:
                    cols, rows, sp, in_mode = info
                data = await capture_pane(pane_id, rows, sp)
                if not data:
                    empty_streak += 1
                    if empty_streak > 100:
                        log.info("poll giving up on pane=%s (never produced output)", pane_id)
                        return
                    await asyncio.sleep(self.poll_period)
                    continue
                empty_streak = 0
                state = (cols, rows, sp, in_mode)
                if first or data != last or state != last_state:
                    first = False
                    last = data
                    last_state = state
                    payload = {
                        "type": "snapshot",
                        "pane": pane_id,
                        "data": base64.b64encode(data).decode(),
                        "cols": cols,
                        "rows": rows,
                        "visible_rows": rows,
                        "scroll_position": sp,
                        "in_copy_mode": in_mode,
                    }
                    if self.ws is not None:
                        await self.ws.send_str(json.dumps(payload))
                ev = self.scroll_nudges.get(pane_id)
                if ev is None:
                    await asyncio.sleep(self.poll_period)
                else:
                    try:
                        await asyncio.wait_for(ev.wait(), timeout=self.poll_period)
                    except asyncio.TimeoutError:
                        pass
                    ev.clear()
        except asyncio.CancelledError:
            return
        except Exception:
            log.exception("poll crashed pane=%s", pane_id)


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", required=True,
                    help="server WS URL, e.g. ws://host:8787/agent")
    ap.add_argument("--token", default=os.environ.get("BRIDGE_TOKEN", ""),
                    help="shared secret (or BRIDGE_TOKEN env)")
    ap.add_argument("--host", default=socket.gethostname(),
                    help="label shown in UI (default: hostname)")
    ap.add_argument("--poll-hz", type=float, default=3.0)
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    if shutil.which("tmux") is None:
        sys.exit("error: tmux not found on PATH")
    if not STATUS_DIR.exists():
        log.warning("%s does not exist — install tmux-claude-status hooks first",
                    STATUS_DIR)
    if args.poll_hz <= 0 or args.poll_hz > 30:
        sys.exit("error: --poll-hz must be in (0, 30]")
    if not args.token:
        log.warning("no token set; server may reject connection")

    agent = Agent(
        server_url=args.server,
        token=args.token,
        host=args.host,
        poll_period=1.0 / args.poll_hz,
    )

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)

    run_task = asyncio.create_task(agent.run(stop))
    await stop.wait()
    run_task.cancel()
    try:
        await run_task
    except asyncio.CancelledError:
        pass


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
