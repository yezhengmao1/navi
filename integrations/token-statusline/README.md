# Token 用量状态栏（claude-hud + ccusage）

在 Claude Code 底部状态栏**常驻一行**显示模型、上下文占用、订阅额度进度、今日总 token：

```
🤖 Opus 4.8 | 🧠 61% (92k) | ⏳ 5h 42% (1h29m) | 🔥 $21.8/hr | 📅 58.8M today
```

| 段 | 来源 | 含义 |
|----|------|------|
| `🤖 Opus 4.8` | hook JSON `model.display_name` | 当前模型 |
| `🧠 61% (92k)` | claude-hud（%）+ hook JSON（token） | 上下文占用：百分比来自 claude-hud（含 autocompact 缓冲，非 token/窗口线性比），括号内是实际 token 数（`current_usage` 三项之和） |
| `⏳ 5h 42% (1h29m)` | hook JSON `rate_limits` | 订阅 5h 额度窗用了 42%，1h29m 后重置。**仅订阅账号 + 较新 Claude Code 下发该字段时显示，否则整段省略**（`resets_at` 数字 epoch / ISO 字符串都支持） |
| `🔥 $21.8/hr` | ccusage `statusline` | 燃烧速率（按 API 计价的 $/小时），后台缓存 |
| `📅 58.8M today` | ccusage `daily` | 今日总 token（input+output+cache），后台缓存 |

> 渲染 ~0.1s。额度段（`⏳`）与内置 `/usage` 同源（取自 hook 的 `rate_limits`）；某次为空说明那次 hook 未带该字段，以 `/usage` 为准。

---

## 前置：运行时

claude-hud / ccusage 都是 JS 工具。**若机器没有 Node.js（≥18），装 bun 即可**（ccusage 官方也推荐 bun）：

```bash
curl -fsSL https://bun.sh/install | bash      # 装到 ~/.bun/bin/bun
```

已有 Node.js ≥18 可跳过，把下文 `bun <cli.js>` 换成对应 node/npx 方式。

## 1. 安装 claude-hud（提供上下文%）

**方式 A（官方 · 交互式）** —— 在 Claude Code 里依次执行：

```
/plugin marketplace add jarrodwatts/claude-hud
/plugin install claude-hud
/reload-plugins
/claude-hud:setup
```

> 官方安装会自己接管 `statusLine`。若要用下面的自定义单行脚本，改用方式 B。

**方式 B（手动接线 · 适合脚本化 / 后台环境）** —— clone 后只留 `dist/`，用 bun 直接跑：

```bash
git clone --depth 1 https://github.com/jarrodwatts/claude-hud /tmp/claude-hud
mkdir -p ~/.claude/claude-hud
cp -r /tmp/claude-hud/dist ~/.claude/claude-hud/dist
cp /tmp/claude-hud/package.json ~/.claude/claude-hud/
# 调用：bun ~/.claude/claude-hud/dist/index.js（读 stdin 的 statusline hook JSON）
```

> 方式 B 不进 `/plugin list`、无 `/claude-hud:setup` 命令，更新需重新 clone。

## 2. 安装 ccusage（提供今日总 token）

```bash
~/.bun/bin/bun add -g ccusage
# 装到 ~/.bun/install/global/node_modules/ccusage/src/cli.js
# 注意：它的 bin 是 #!/usr/bin/env node，无 node 时必须用 `bun <cli.js>` 方式调用
```

> 本方案用 ccusage 的 `daily`（今日 token）+ `statusline`（燃烧速率）。模型、上下文%、额度进度不经过 ccusage。

## 3. 合并脚本

写入 `~/.claude/statusline.sh`：

```bash
#!/usr/bin/env bash
# Single-line Claude Code statusline (run via bun; no system node here).
#   🤖 <model> | 🧠 <ctx%> | ⏳ 5h <used%> (<reset>) | 🔥 <$/hr> | 📅 <today tokens>

BUN=/root/.bun/bin/bun
HUD=/root/.claude/claude-hud/dist/index.js
CCLI=/root/.bun/install/global/node_modules/ccusage/src/cli.js
CACHE="$HOME/.claude/.ccusage-today-tok"   # line: "<date> <ts> <today-tokens> <burn>"
LOCK="$CACHE.lock"
TTL=60   # seconds before the ccusage cache is stale

input=$(cat)   # Claude Code passes the hook JSON on stdin

# context % from claude-hud (strip ANSI, take the % on the Context line)
ctx=$(printf '%s' "$input" | "$BUN" "$HUD" 2>/dev/null \
      | sed 's/\x1b\[[0-9;]*m//g' \
      | grep -i context | grep -oE '[0-9]+%' | head -1)

# today's tokens + burn rate — ccusage scans all logs (slow), so never compute
# inline: print cached values, refresh both in background (flock-guarded)
today=$(date +%Y-%m-%d)
now=$(date +%s)
tok=""; burn=""; c_date=""; c_ts=0
if [ -f "$CACHE" ]; then
  read -r c_date c_ts c_tok c_burn < "$CACHE"
  if [ "$c_date" = "$today" ]; then
    [ "$c_tok"  != "-" ] && tok="$c_tok"
    [ "$c_burn" != "-" ] && burn="$c_burn"
  fi
fi
if [ "$c_date" != "$today" ] || [ $(( now - c_ts )) -ge "$TTL" ]; then
  (
    flock -n 9 || exit 0
    t=$("$BUN" "$CCLI" daily --json 2>/dev/null | python3 -c '
import json,sys
try:
    d=json.load(sys.stdin); day=sys.argv[1]
    row=next((r for r in d.get("daily",[]) if str(r.get("period","")).startswith(day)), None)
    n=int(row.get("totalTokens",0)) if row else 0
    print(f"{n/1e6:.1f}M" if n>=1e6 else (f"{n/1e3:.0f}k" if n>=1e3 else str(n)))
except Exception:
    print("")
' "$today")
    b=$(printf '%s' '{"session_id":"bg","transcript_path":"/nonexistent.jsonl","cwd":"/","model":{"id":"x","display_name":"x"},"workspace":{"current_dir":"/"}}' \
        | "$BUN" "$CCLI" statusline 2>/dev/null \
        | sed 's/\x1b\[[0-9;]*m//g' | grep -oE '\$[0-9.]+/hr' | head -1)
    if [ -n "$t" ] || [ -n "$b" ]; then
      printf '%s %s %s %s\n' "$today" "$(date +%s)" "${t:--}" "${b:--}" > "$CACHE"
    fi
  ) 9>"$LOCK" >/dev/null 2>&1 &
  disown 2>/dev/null || true
fi

# assemble: 🤖 model | 🧠 ctx% | ⏳ 5h used% (reset) | 🔥 $/hr | 📅 today
# model + 5h usage come straight from the hook JSON; ctx/burn/tok passed in.
printf '%s' "$input" | python3 -c '
import json,sys
from datetime import datetime,timezone
ctx=sys.argv[1]; tok=sys.argv[2]; burn=sys.argv[3]
def left(s):
    if s is None or s=="": return ""
    try:
        if isinstance(s,(int,float)):
            ms = s if s>1e12 else s*1000
            t=datetime.fromtimestamp(ms/1000, timezone.utc)
        else:
            t=datetime.fromisoformat(str(s).replace("Z","+00:00"))
        d=(t-datetime.now(timezone.utc)).total_seconds()
        if d<=0: return "now"
        h=int(d//3600); m=int((d%3600)//60)
        return (f"{h}h{m}m" if h else f"{m}m")
    except Exception: return ""
def fmt(n):
    return f"{n/1e6:.1f}M" if n>=1e6 else (f"{n/1e3:.0f}k" if n>=1e3 else str(n))
try: d=json.load(sys.stdin)
except Exception: d={}
model=(d.get("model") or {}).get("display_name") or (d.get("model") or {}).get("id") or ""
# context token count from the hook (input + cache-creation + cache-read)
cu=(d.get("context_window") or {}).get("current_usage") or {}
ctok=sum(int(cu.get(k,0) or 0) for k in ("input_tokens","cache_creation_input_tokens","cache_read_input_tokens"))
ctxtok=fmt(ctok) if ctok>0 else ""
fh=(d.get("rate_limits") or {}).get("five_hour") or {}
p5=fh.get("used_percentage")
usage=""
if p5 is not None:
    r=left(fh.get("resets_at"))
    usage="\U000023f3 5h %d%%%s" % (int(p5), (" (%s)" % r) if r else "")
brain=ctx or ""
if ctxtok: brain=(brain+" ("+ctxtok+")") if brain else ctxtok
out=[]
if model: out.append("\U0001f916 "+model)
if brain: out.append("\U0001f9e0 "+brain)
if usage: out.append(usage)
if burn:  out.append("\U0001f525 "+burn)
if tok:   out.append("\U0001f4c5 "+tok+" today")
print(" | ".join(out))
' "$ctx" "$tok" "$burn"
```

```bash
chmod +x ~/.claude/statusline.sh
```

> 路径按无 node 环境写死了 `/root/.bun/...`。换机时改 `BUN` / `HUD` / `CCLI` 三个变量即可。

## 4. 接入 settings.json

在 `~/.claude/settings.json` 加 `statusLine`（保留已有 `hooks`/`theme` 等）：

```json
{
  "statusLine": {
    "type": "command",
    "command": "/root/.claude/statusline.sh",
    "padding": 0
  }
}
```

**对新开的会话生效**（当前会话不变）。

---

## 说明

- 渲染 ~0.1s：模型、上下文%、额度全部从 hook JSON / claude-hud 本地取，不做联网或重活。
- 「今日总 token」+「燃烧速率」靠 `ccusage daily` / `statusline`（扫全量日志，慢），**后台异步刷新**写 `~/.claude/.ccusage-today-tok`（一行 `<date> <ts> <tokens> <burn>`，`flock` 防并发堆积），状态栏只读缓存永不阻塞。
- `⏳` 额度段直接解析 hook 的 `rate_limits.five_hour`（和 claude-hud 同源），**仅订阅账号 + 较新 Claude Code 才下发**；缺字段时自动省略。`resets_at` 数字 epoch / ISO 字符串都支持。要随时看准确额度用 `/usage`。
- 想加回花费 / 7d 窗：装配段把 `rate_limits.seven_day` 也拼进 `usage`，或追加 `ccusage statusline` 的花费段。各段来源见脚本注释。
