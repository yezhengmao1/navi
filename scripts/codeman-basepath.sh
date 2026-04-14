#!/usr/bin/env bash
# codeman-basepath.sh — 安装 Codeman + 注入 base path + 启动
#
# 用法:
#   ./codeman-basepath.sh /siflow/auriga/a77dfa8f14/cc-web/v1/3000
#   ./codeman-basepath.sh --patch-only /siflow/auriga/a77dfa8f14/cc-web/v1/3000
#   ./codeman-basepath.sh --port 8080 /siflow/auriga/a77dfa8f14/cc-web/v1/8080

set -euo pipefail

PORT=3000
PATCH_ONLY=false

while [[ $# -gt 1 ]]; do
  case "$1" in
    --patch-only) PATCH_ONLY=true; shift ;;
    --port) PORT="$2"; shift 2 ;;
    *) break ;;
  esac
done

BASE_PATH="${1:?用法: $0 [--patch-only] [--port PORT] <base-path>}"
BASE_PATH="${BASE_PATH%/}"

CODEMAN_DIR="$HOME/.codeman/app"
INDEX_HTML="$CODEMAN_DIR/dist/web/public/index.html"
SERVER_JS="$CODEMAN_DIR/dist/web/server.js"
SESSION_JS="$CODEMAN_DIR/dist/session.js"
CLI_BUILDER_JS="$CODEMAN_DIR/dist/session-cli-builder.js"

# ── Step 1: 安装 ──
if [[ "$PATCH_ONLY" == false ]]; then
  pkill -f 'index.js.*web' 2>/dev/null || true
  echo "==> 安装 Codeman ..."
  CODEMAN_NONINTERACTIVE=1 bash -c \
    "$(curl -fsSL https://raw.githubusercontent.com/Ark0N/Codeman/master/install.sh)"
  pkill -f 'index.js.*web' 2>/dev/null || true
  sleep 1
fi

if [[ ! -f "$INDEX_HTML" ]]; then
  echo "错误: 找不到 $INDEX_HTML" >&2
  exit 1
fi

# ── Step 2: Patch 前端 (index.html) ──
echo "==> Patch 前端: ${BASE_PATH}"

PATCH_SCRIPT=$(mktemp)
cat > "$PATCH_SCRIPT" << 'PYEOF'
import sys, re

base_path = sys.argv[1]
html_path = sys.argv[2]

js_snippet = (
    "<script>(function(){"
    "var B=window.__CODEMAN_BASE_PATH__='" + base_path + "';"
    "if(!B)return;"
    "var _f=window.fetch;"
    "window.fetch=function(u,o){"
    "if(typeof u==='string'&&u.charAt(0)==='/')u=B+u;"
    "return _f.call(this,u,o)"
    "};"
    "var _E=window.EventSource;"
    "window.EventSource=function(u,o){"
    "if(typeof u==='string'&&u.charAt(0)==='/')u=B+u;"
    "return new _E(u,o)"
    "};"
    "window.EventSource.prototype=_E.prototype;"
    "window.EventSource.CONNECTING=_E.CONNECTING;"
    "window.EventSource.OPEN=_E.OPEN;"
    "window.EventSource.CLOSED=_E.CLOSED;"
    "var _W=window.WebSocket;"
    "window.WebSocket=function(u,p){"
    "if(typeof u==='string'){"
    "var m=u.match(/^(wss?:\\/\\/[^\\/]+)(\\/.*)/);"
    "if(m&&m[2].charAt(0)==='/')u=m[1]+B+m[2]"
    "}"
    "return p!==undefined?new _W(u,p):new _W(u)"
    "};"
    "window.WebSocket.prototype=_W.prototype;"
    "window.WebSocket.CONNECTING=_W.CONNECTING;"
    "window.WebSocket.OPEN=_W.OPEN;"
    "window.WebSocket.CLOSING=_W.CLOSING;"
    "window.WebSocket.CLOSED=_W.CLOSED;"
    "var _b=navigator.sendBeacon.bind(navigator);"
    "navigator.sendBeacon=function(u,d){"
    "if(typeof u==='string'&&u.charAt(0)==='/')u=B+u;"
    "return _b(u,d)"
    "}"
    "})();</script>"
)

with open(html_path, 'r') as f:
    html = f.read()

if '__CODEMAN_BASE_PATH__' in html:
    html = re.sub(
        r"window\.__CODEMAN_BASE_PATH__='[^']*'",
        "window.__CODEMAN_BASE_PATH__='" + base_path + "'",
        html
    )
    print("    已更新（覆盖旧值）")
else:
    html = html.replace('<meta charset="UTF-8">', '<meta charset="UTF-8">\n' + js_snippet, 1)
    print("    已注入")

with open(html_path, 'w') as f:
    f.write(html)
PYEOF

python3 "$PATCH_SCRIPT" "$BASE_PATH" "$INDEX_HTML"
rm -f "$PATCH_SCRIPT"

rm -f "$INDEX_HTML.gz" "$INDEX_HTML.br"
echo "    已清理预压缩缓存"

# ── Step 2b: Patch 主题 — Ubuntu 配色 ──
echo "==> Patch 主题: Ubuntu"

STYLES_CSS=$(ls "$CODEMAN_DIR/dist/web/public/styles."*.css 2>/dev/null | head -1)
if [[ -n "$STYLES_CSS" ]]; then
  python3 -c "
import sys
css_path = sys.argv[1]
with open(css_path, 'r') as f:
    css = f.read()

replacements = {
    '--bg-dark: #09090b':       '--bg-dark: #2C001E',
    '--bg-card: #131316':       '--bg-card: #3C0A2E',
    '--bg-input: #1a1a1f':      '--bg-input: #4A1138',
    '--bg-hover: #1f1f26':      '--bg-hover: #5E2750',
    '--border: #232329':        '--border: #6B3A5C',
    '--border-light: #2e2e38':  '--border-light: #77216F',
    '--accent: #3b82f6':        '--accent: #E95420',
    '--accent-hover: #60a5fa':  '--accent-hover: #FF7043',
    'rgba(19, 19, 22, .85)':    'rgba(44, 0, 30, .85)',
}

for old, new in replacements.items():
    css = css.replace(old, new)

with open(css_path, 'w') as f:
    f.write(css)
print('    已应用')
" "$STYLES_CSS"
  rm -f "$STYLES_CSS.gz" "$STYLES_CSS.br"
fi

# ── Step 3: Patch 服务端 (server.js) — rewriteUrl strip prefix ──
echo "==> Patch 服务端: rewriteUrl strip prefix"

PATCH_SERVER=$(mktemp)
cat > "$PATCH_SERVER" << 'PYEOF'
import sys, re

base_path = sys.argv[1]
server_path = sys.argv[2]

rewrite_fn = (
    "/* __CODEMAN_BASE_PATH_HOOK__ */ "
    "rewriteUrl:function(req){var __BP__='" + base_path + "';"
    "if(req.url.startsWith(__BP__))return req.url.slice(__BP__.length)||'/';"
    "return req.url},"
)

with open(server_path, 'r') as f:
    content = f.read()

if '__CODEMAN_BASE_PATH_HOOK__' in content:
    content = re.sub(r"var __BP__='[^']*'", "var __BP__='" + base_path + "'", content)
    print("    已更新（覆盖旧值）")
else:
    content = content.replace(
        'Fastify({ logger: false,',
        'Fastify({ ' + rewrite_fn + ' logger: false,',
    )
    content = content.replace(
        'Fastify({ logger: false })',
        'Fastify({ ' + rewrite_fn + ' logger: false })',
    )
    print("    已注入")

with open(server_path, 'w') as f:
    f.write(content)
PYEOF

python3 "$PATCH_SERVER" "$BASE_PATH" "$SERVER_JS"
rm -f "$PATCH_SERVER"

# ── Step 4: Patch Claude 模式 — 去掉 dangerously-skip-permissions ──
echo "==> Patch Claude 模式: normal（兼容 root）"

# session.js: 默认模式改为 normal
sed -i "s/_claudeMode = 'dangerously-skip-permissions'/_claudeMode = 'normal'/" "$SESSION_JS"

# session-cli-builder.js: 默认 args 去掉 --dangerously-skip-permissions
sed -i "s/'--dangerously-skip-permissions', //" "$CLI_BUILDER_JS"

# tmux-manager.js: 默认 fallback 改为 normal
TMUX_JS="$CODEMAN_DIR/dist/tmux-manager.js"
sed -i "s/claudeMode || 'dangerously-skip-permissions'/claudeMode || 'normal'/" "$TMUX_JS"

echo "    已完成"

# ── Step 5: 验证 ──
FAIL=false
if grep -q '__CODEMAN_BASE_PATH__' "$INDEX_HTML"; then
  echo "==> 验证: 前端 patch ✓"
else
  echo "错误: 前端 patch 失败！" >&2; FAIL=true
fi

if grep -q '__CODEMAN_BASE_PATH_HOOK__' "$SERVER_JS"; then
  echo "==> 验证: 服务端 patch ✓"
else
  echo "错误: 服务端 patch 失败！" >&2; FAIL=true
fi

if ! grep -q "dangerously-skip-permissions" "$SESSION_JS"; then
  echo "==> 验证: Claude 模式 patch ✓"
else
  echo "警告: Claude 模式 patch 可能不完整" >&2
fi

$FAIL && exit 1

# ── Step 6: 启动 ──
echo "==> 启动 codeman web (port ${PORT}) ..."
pkill -f 'index.js.*web' 2>/dev/null || true
sleep 1
node "$HOME/.codeman/app/dist/index.js" web --port "$PORT" &
echo "    PID: $!"
echo ""
echo "完成！通过 proxy 访问即可。"
