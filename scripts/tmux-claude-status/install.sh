#!/usr/bin/env bash
# Install Claude status tracking hooks and tmux keybinding.
#
# Usage: bash install.sh [--uninstall]
#
# What it does:
#   1. Adds hook entries to ~/.claude/settings.json (global)
#   2. Adds tmux keybinding (prefix + a) to ~/.tmux.conf

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK_SCRIPT="$SCRIPT_DIR/status-hook.sh"
POPUP_SCRIPT="$SCRIPT_DIR/claude-status.sh"
STATUSLINE_SCRIPT="$SCRIPT_DIR/statusline.sh"
SETTINGS_FILE="$HOME/.claude/settings.json"
TMUX_CONF="$HOME/.tmux.conf"

HOOK_EVENTS=("SessionStart" "UserPromptSubmit" "PreToolUse" "PostToolUse" "PermissionRequest" "Stop" "Notification" "SessionEnd")

# ── Uninstall ───────────────────────────────────────────────
if [ "${1:-}" = "--uninstall" ]; then
  echo "Removing hooks from $SETTINGS_FILE ..."
  if [ -f "$SETTINGS_FILE" ]; then
    tmp=$(mktemp)
    jq 'del(.hooks)' "$SETTINGS_FILE" > "$tmp" && mv "$tmp" "$SETTINGS_FILE"
    echo "  Hooks removed."
  fi

  echo "Removing tmux keybinding from $TMUX_CONF ..."
  if [ -f "$TMUX_CONF" ]; then
    sed -i '/# claude-status-popup/d; /claude-status\.sh/d' "$TMUX_CONF"
    sed -i '/# claude-statusline/d; /statusline\.sh/d' "$TMUX_CONF"
    echo "  Keybinding removed."
  fi

  rm -rf /tmp/claude-status
  echo "Done. Restart Claude sessions for changes to take effect."
  exit 0
fi

# ── Install hooks ───────────────────────────────────────────
echo "Installing Claude status hooks..."

if [ ! -f "$SETTINGS_FILE" ]; then
  echo '{}' > "$SETTINGS_FILE"
fi

# Build hooks object: each event maps to the same hook command
hooks_json=$(jq -n --arg cmd "$HOOK_SCRIPT" '
  [
    "SessionStart", "UserPromptSubmit", "PreToolUse",
    "PostToolUse", "PermissionRequest", "Stop", "Notification", "SessionEnd"
  ] | reduce .[] as $event ({};
    .[$event] = [{
      matcher: "",
      hooks: [{type: "command", command: $cmd}]
    }]
  )
')

# Merge hooks into existing settings (preserve other keys, merge into existing hooks)
tmp=$(mktemp)
jq --argjson hooks "$hooks_json" '.hooks = ((.hooks // {}) * $hooks)' "$SETTINGS_FILE" > "$tmp" \
  && mv "$tmp" "$SETTINGS_FILE"

echo "  Hooks written to $SETTINGS_FILE"

# ── Install tmux keybinding ─────────────────────────────────
echo "Installing tmux keybinding (prefix + a)..."

BIND_LINE="bind a display-popup -w 70 -h 20 -E \"$POPUP_SCRIPT\"  # claude-status-popup"
STATUSLINE_LINE="set -g status-right '#{?window_bigger,[#{window_offset_x}#,#{window_offset_y}] ,}#($STATUSLINE_SCRIPT)'  # claude-statusline"

if grep -qF 'claude-status-popup' "$TMUX_CONF" 2>/dev/null; then
  sed -i '/claude-status-popup/c\'"$BIND_LINE" "$TMUX_CONF"
  echo "  Updated existing keybinding in $TMUX_CONF"
else
  echo "" >> "$TMUX_CONF"
  echo "$BIND_LINE" >> "$TMUX_CONF"
  echo "  Added keybinding to $TMUX_CONF"
fi

if grep -qF 'claude-statusline' "$TMUX_CONF" 2>/dev/null; then
  sed -i '/claude-statusline/c\'"$STATUSLINE_LINE" "$TMUX_CONF"
  echo "  Updated existing statusline in $TMUX_CONF"
else
  echo "$STATUSLINE_LINE" >> "$TMUX_CONF"
  echo "  Added statusline to $TMUX_CONF"
fi

# Live-apply if tmux is running
if [ -n "${TMUX:-}" ]; then
  tmux bind a display-popup -w 70 -h 20 -E "$POPUP_SCRIPT" 2>/dev/null || true
  tmux set -g status-right "#{?window_bigger,[#{window_offset_x}#,#{window_offset_y}] ,}#($STATUSLINE_SCRIPT)" 2>/dev/null || true
  echo "  Keybinding and statusline active in current tmux session."
fi

echo ""
echo "Done! Restart Claude sessions for hooks to take effect."
echo "  prefix + a  — open status popup"
echo "  Status bar  — ✨ appears when approval is needed"
