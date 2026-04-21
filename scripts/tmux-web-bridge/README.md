# tmux-web-bridge

Web UI to monitor and interact with every Claude Code instance running in any tmux pane — including on remote machines.

- One **server** hosts the web UI.
- One **agent** runs on every machine that has tmux, and pushes its Claude panes up to the server.
- Browser sees all agents' panes together, grouped by host.

## Architecture

```
[tmux box A]                         [server box]
  agent.py  ──WS──►                    server.py ──HTTP──► Browser
  (tmux cmds,                          (pure relay,              │
   read /tmp/                          no tmux)                  ▼
   claude-status)                            ▲               xterm.js
                                             │               (terminal)
[tmux box B]                                 │
  agent.py  ──WS──►────────────────────────►─┘
```

- Agents connect **outbound** to `ws://<server>:8787/agent`; no inbound port needed on the tmux box.
- Browsers connect to `ws://<server>:8787/ws`.
- Pane dimensions (`cols` × `rows`) travel with each snapshot; the browser resizes `xterm.js` to match so the layout lines up.
- Snapshots are deduped server-side; idle panes produce no traffic.

## Requirements

- tmux (3.2+) on every agent box
- Python 3.10+ on server and agent
- `tmux-claude-status` hooks installed on each agent box:
  `bash scripts/tmux-claude-status/install.sh`
- A browser with ES2020 support

## Install

On both server and agent machines:

```bash
cd scripts/tmux-web-bridge
pip install -r requirements.txt
```

## Run — server

```bash
export BRIDGE_TOKEN=$(openssl rand -hex 16)   # share this with agents
python server.py --token "$BRIDGE_TOKEN"
```

Defaults: binds `0.0.0.0:8787`. The token is the shared secret; agents must present it.

Flags:

```
--host     bind address       default 0.0.0.0
--port     port               default 8787
--token    shared secret      or BRIDGE_TOKEN env
-v         verbose logs
```

Open <http://&lt;server&gt;:8787> in a browser.

## Run — agent

On every machine running Claude in tmux:

```bash
export BRIDGE_TOKEN=<same as server>
python agent.py --server ws://<server-host>:8787/agent \
                --token "$BRIDGE_TOKEN" \
                --host alice-laptop       # label shown in UI (default: hostname)
```

The agent reconnects automatically (exponential backoff, capped at 30 s) if the server is down.

Flags:

```
--server    server WS URL        required, e.g. ws://host:8787/agent
--token     shared secret        or BRIDGE_TOKEN env
--host      display label        default: hostname
--poll-hz   snapshots/sec        default 5 (range (0, 30])
-v          verbose logs
```

## All-in-one (same machine)

Run both in two terminals — no difference from the distributed case:

```bash
# terminal 1
python server.py --token secret123

# terminal 2
python agent.py --server ws://127.0.0.1:8787/agent --token secret123
```

## WebSocket protocol

**Browser ↔ server** (`/ws`):

Client → server:

```json
{"type": "subscribe",   "key": "alice-laptop/%42"}
{"type": "unsubscribe", "key": "alice-laptop/%42"}
{"type": "send_keys",   "key": "alice-laptop/%42", "text": "hello", "enter": true}
{"type": "list"}
```

Server → client:

```json
{"type": "panes",    "panes": [{"key": "alice/%42", "host": "alice", "pane": "%42", "state": "idle", "cwd": "...", ...}]}
{"type": "snapshot", "key":  "alice/%42", "cols": 180, "rows": 42, "data": "<base64 ANSI screen>"}
{"type": "gone",     "key":  "alice/%42"}
{"type": "error",    "msg":  "..."}
```

**Agent ↔ server** (`/agent`):

Agent → server:

```json
{"type": "hello",    "host": "alice-laptop", "token": "..."}
{"type": "panes",    "panes": [{"pane": "%42", "cwd": "...", "state": "...", ...}]}
{"type": "snapshot", "pane": "%42", "cols": 180, "rows": 42, "data": "<base64>"}
```

Server → agent:

```json
{"type": "subscribe",   "pane": "%42"}
{"type": "unsubscribe", "pane": "%42"}
{"type": "send_keys",   "pane": "%42", "text": "hello", "enter": true}
```

## Security

- **All browsers connected to the server can inject keystrokes into every Claude pane on every agent** — equivalent to remote shell access. Protect the server endpoint accordingly (VPN, reverse proxy with auth, or SSH tunnel).
- The agent ↔ server token is the only access control in the MVP. Use a 128-bit random token.
- For ad-hoc remote use without exposing ports, run the server locally and SSH-tunnel the agent:
  ```bash
  ssh -R 8787:127.0.0.1:8787 <tmux-box>
  # on tmux-box:
  python agent.py --server ws://127.0.0.1:8787/agent --token …
  ```

## Files

| File | Role |
|------|------|
| `server.py`     | Relay. WS endpoints `/agent` and `/ws`; serves web UI. |
| `agent.py`      | Runs on tmux box; local tmux ops + outbound WS to server. |
| `web/index.html` · `web/app.js` | Single-page UI with xterm.js. |
| `requirements.txt` | `aiohttp`. |

## Limits

- Only the **visible** screen is captured. To view scrollback, scroll with the mouse wheel (or Shift+PageUp / PageDown, or PageUp/PageDown while the input box is focused) — the browser drives tmux copy-mode on the remote pane and the next capture reflects the new viewport. Press Escape to leave copy-mode.
- Agent ↔ server pane list re-sync is ~2 s.
- Snapshot cadence is bounded by `agent.py --poll-hz` (default 3 Hz); only the active pane on each browser is polled.
