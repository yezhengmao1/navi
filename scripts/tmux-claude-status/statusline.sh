#!/usr/bin/env bash
# tmux statusline segment: show Claude instance states.
# Usage: add  #(/path/to/statusline.sh)  to tmux status-right or status-left.

STATUS_DIR="/tmp/claude-status"
[ -d "$STATUS_DIR" ] || exit 0

idle=0 thinking=0 tool_use=0 pending=0

for f in "$STATUS_DIR"/*; do
  [ -f "$f" ] || continue
  state=$(grep -o '"state":"[^"]*"' "$f" 2>/dev/null | head -1)
  case "$state" in
    *idle*)      idle=$((idle + 1)) ;;
    *thinking*)  thinking=$((thinking + 1)) ;;
    *tool_use*)  tool_use=$((tool_use + 1)) ;;
    *pending*)   pending=$((pending + 1)) ;;
  esac
done

parts=()
[ "$pending" -gt 0 ]  && parts+=("◐ ${pending}")
[ "$tool_use" -gt 0 ] && parts+=("● ${tool_use}")
[ "$thinking" -gt 0 ] && parts+=("✢ ${thinking}")
[ "$idle" -gt 0 ]     && parts+=("○ ${idle}")

[ ${#parts[@]} -eq 0 ] && exit 0

printf '%s' "${parts[*]}"
